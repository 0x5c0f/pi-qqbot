/**
 * pi-qqbot — mirror the live pi session to a QQ private chat.
 *
 * One pi session <-> one QQ C2C conversation (single allowlisted owner):
 *   QQ -> pi : injected via pi.sendUserMessage (tagged `[QQ]`)
 *   pi -> QQ : assistant `text` blocks, debounced + chunked, passive-reply aware
 *   终端 -> QQ : terminal-typed user messages, prefixed with `🖥 终端`
 *
 * Transport is the official Tencent SDK `@tencent-connect/qqbot-nodejs`
 * (MIT), loaded lazily so it is only touched when a session actually starts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Debouncer,
	ReplyBudget,
	budgetWarning,
	chunkText,
	composePayload,
	extractText,
	formatToolTrace,
	isInjected,
	markInjected,
} from "./core.ts";
import { configPath, ensureExampleConfig, loadConfig, saveAllowFrom, saveConfig, type QQBotConfig } from "./config.ts";
import { acquireLock, readLock, releaseLock } from "./lock.ts";
import { freshMsgId, loadState, saveState } from "./state.ts";
import { logLine, logPath } from "./log.ts";

interface Target {
	scope: "c2c" | "group";
	targetId: string;
	msgId?: string;
}

const TYPING_THROTTLE_MS = 5000;
const TYPING_KEEPALIVE_SEC = 30;
const SEEN_MAX = 500;

export default function (pi: ExtensionAPI): void {
	let ctxRef: ExtensionContext | undefined;
	let bot: any;
	let abort: AbortController | undefined;
	let running = false;
	let busy = false;
	let binding = false;
	let cfg: QQBotConfig | undefined;

	let target: Target | undefined;
	const budget = new ReplyBudget();
	const budgetNotified = new Map<string, string>();
	const debouncer = new Debouncer(1200);
	function resetDebouncer(): void {
		debouncer.setWindow(cfg?.debounceMs ?? 1200);
	}
	const seen = new Set<string>();

	/** Remember where to send output; persisted so mirroring survives restarts. */
	function rememberTarget(scope: Target["scope"], targetId: string, msgId?: string): void {
		target = { scope, targetId, ...(msgId ? { msgId } : {}) };
		saveState({ scope, targetId, ...(msgId ? { msgId } : {}), at: Date.now() });
	}

	let pendingText: string[] = [];
	let pendingTools: string[] = [];
	let lastTypingAt = 0;
	let outCount = 0;
	let lastError: string | undefined;

	function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		try {
			ctxRef?.ui.notify(message, level);
		} catch {
			// UI may be unavailable in print/json mode.
		}
	}

	async function loadQQBotClass(): Promise<any> {
		// `PI_QQBOT_SDK` is a testing/advanced seam: point it at an alternate
		// module exporting a `QQBot` class (absolute path or file:// URL).
		const specifier = process.env.PI_QQBOT_SDK || "@tencent-connect/qqbot-nodejs";
		const mod: any = await import(specifier);
		return mod?.QQBot ?? mod?.default?.QQBot;
	}

	async function startBot(): Promise<void> {
		if (running) return;
		abort?.abort();
		const loaded = loadConfig();
		if (!loaded.ok) {
			lastError = loaded.error;
			logLine("config-error", loaded.error);
			notify(`pi-qqbot: ${loaded.error}（已生成模板 ${loaded.path}）`, "error");
			return;
		}
		cfg = loaded.config;
		resetDebouncer();

		const lock = acquireLock();
		if (!lock.ok) {
			lastError = `QQ 连接已被 PID ${lock.holder.pid} 占用`;
			logLine("lock-busy", JSON.stringify(lock.holder));
			notify(
				`pi-qqbot: QQ 已由 PID ${lock.holder.pid}（${lock.holder.host}）占用。请在那边执行 /qq-disconnect 后再 /qq-connect。`,
				"error",
			);
			return;
		}

		let QQBot: any;
		try {
			QQBot = await loadQQBotClass();
		} catch (err) {
			lastError = `加载 QQ SDK 失败：${(err as Error).message}`;
			logLine("sdk-error", lastError);
			notify(`pi-qqbot: ${lastError}`, "error");
			return;
		}

		try {
			bot = new QQBot({
				appId: cfg.appId,
				appSecret: cfg.appSecret,
				markdownSupport: cfg.markdownSupport,
				logger: {
					info: (m: string) => logLine("sdk", m),
					error: (m: string) => logLine("sdk-error", m),
					debug: () => {},
					warn: (m: string) => logLine("sdk-warn", m),
				},
			});
		} catch (err) {
			lastError = `创建 QQBot 失败：${(err as Error).message}`;
			logLine("bot-error", lastError);
			releaseLock();
			notify(`pi-qqbot: ${lastError}`, "error");
			return;
		}

		bot.on("message", onQQMessage);
		bot.on("ready", () => {
			logLine("ready");
			notify("pi-qqbot: QQ 已连接 ✓");
		});
		bot.on("resumed", () => {
			logLine("resumed");
			notify("pi-qqbot: QQ 已重连 ✓");
		});
		bot.on("error", (err: Error) => {
			lastError = err.message;
			logLine("ws-error", err.message);
			notify(`pi-qqbot: QQ 连接错误 ${err.message}`, "error");
		});

		abort = new AbortController();
		running = true;
		notify(`pi-qqbot: 正在连接 QQ…（${cfg.allowFrom.length ? `已授权 ${cfg.allowFrom.length} 个用户` : "绑定模式：请发 /qq-bind"}）`);
		bot.start(abort.signal).catch((err: Error) => {
			running = false;
			lastError = err.message;
			logLine("start-error", err.message);
			releaseLock();
			notify(`pi-qqbot: 连接失败 ${err.message}`, "error");
		});
	}

	function stopBot(reason: string): void {
		debouncer.cancel();
		try {
			abort?.abort();
			bot?.stop?.();
		} catch (err) {
			logLine("stop-error", (err as Error).message);
		}
		bot = undefined;
		abort = undefined;
		running = false;
		busy = false;
		pendingText = [];
		pendingTools = [];
		releaseLock();
		logLine("stopped", reason);
	}

	async function onQQMessage(_ctx: unknown, msg: any): Promise<void> {
		try {
			if (!msg || typeof msg !== "object") return;
			const kind = msg.kind as string;
			const senderId = String(msg.senderId ?? "");
			const text = typeof msg.content === "string" ? msg.content.trim() : "";
			const rt = msg.replyTarget;

			if (kind !== "c2c" && kind !== "group") return;
			if (kind === "group" && !cfg?.allowGroup) {
				logLine("inbound-ignored", "group disabled", senderId);
				return;
			}

			if (binding) {
				if (kind === "c2c" && senderId) {
					const ok = await confirmBind(senderId);
					if (ok && rt?.scope && rt?.targetId) rememberTarget(rt.scope, rt.targetId, rt.msgId);
				}
				return;
			}

			if (!cfg) return;
			if (cfg.allowFrom.length === 0) {
				logLine("inbound-ignored", "no allowFrom, run /qq-bind", senderId);
				return;
			}
			if (!cfg.allowFrom.includes(senderId)) {
				logLine("inbound-ignored", "not allowlisted", senderId);
				return;
			}
			if (msg.messageId && seen.has(String(msg.messageId))) {
				logLine("inbound-dedupe", String(msg.messageId));
				return;
			}
			if (msg.messageId) {
				seen.add(String(msg.messageId));
				if (seen.size > SEEN_MAX) {
					const first = seen.values().next().value;
					if (first !== undefined) seen.delete(first);
				}
			}

			if (!rt || !rt.scope || !rt.targetId) return;
			rememberTarget(rt.scope, rt.targetId, rt.msgId);

			logLine("inbound", kind, senderId, text.slice(0, 120));
			void sendTyping();
			if (!text) return;

			const payload = markInjected(text);
			const isBusy = busy || !ctxRef?.isIdle?.();
			try {
				if (isBusy) pi.sendUserMessage(payload, { deliverAs: "steer" });
				else pi.sendUserMessage(payload);
			} catch (err) {
				logLine("inject-retry", (err as Error).message);
				pi.sendUserMessage(payload, { deliverAs: "steer" });
			}
		} catch (err) {
			logLine("inbound-error", (err as Error).message);
		}
	}

	async function confirmBind(senderId: string): Promise<boolean> {
		binding = false;
		let ok = false;
		try {
			ok = await ctxRef!.ui.confirm(
				"pi-qqbot 绑定",
				`将 QQ openid ${senderId} 设为唯一允许驱动本会话的用户？`,
			);
		} catch {
			ok = false;
		}
		if (!ok) {
			notify("pi-qqbot: 已取消绑定", "info");
			return false;
		}
		const res = saveAllowFrom([senderId]);
		if (!res.ok) {
			notify(`pi-qqbot: 保存失败 ${res.error}`, "error");
			return false;
		}
		if (cfg) cfg.allowFrom = [senderId];
		notify(`pi-qqbot: 已绑定 ${senderId}`, "info");
		logLine("bound", senderId);
		return true;
	}

	async function sendTyping(): Promise<void> {
		if (!bot || !target || target.scope !== "c2c") return;
		const now = Date.now();
		if (now - lastTypingAt < TYPING_THROTTLE_MS) return;
		lastTypingAt = now;
		try {
			await bot.sendTyping(
				{ scope: target.scope, targetId: target.targetId, ...(target.msgId ? { msgId: target.msgId } : {}) },
				TYPING_KEEPALIVE_SEC,
			);
		} catch (err) {
			logLine("typing-error", (err as Error).message);
		}
	}

	/** Warn in the terminal once per inbound message as the reply budget runs out. */
	function maybeWarnBudget(msgId: string, remaining: number, allowed: boolean): void {
		const level = budgetWarning(remaining, allowed);
		if (level === "none") return;
		if (budgetNotified.get(msgId) === level) return;
		budgetNotified.set(msgId, level);
		if (budgetNotified.size > SEEN_MAX) {
			const first = budgetNotified.keys().next().value;
			if (first !== undefined) budgetNotified.delete(first);
		}
		if (level === "exhausted") {
			notify(
				"pi-qqbot: QQ 被动回复额度已用尽，本条改走主动消息（可能被 QQ 拦截）。在 QQ 里发一条消息即可刷新额度。",
				"warning",
			);
		} else {
			notify("pi-qqbot: QQ 被动回复额度仅剩 1 次，建议在 QQ 里发一条消息刷新。", "warning");
		}
	}

	async function sendToQQ(text: string, prefix?: string): Promise<void> {
		if (!bot) {
			logLine("outbound-skip", "no bot connection");
			return;
		}
		if (!target) {
			logLine("outbound-skip", "no reply target yet — send any QQ message once to set it");
			return;
		}
		const body = prefix ? `${prefix}\n${text}` : text;
		const limit = cfg?.maxChunkChars ?? 4500;
		for (const chunk of chunkText(body, limit)) {
			if (!chunk.trim()) continue;
			let msgId = target.msgId;
			if (msgId) {
				const check = budget.check(msgId);
				maybeWarnBudget(msgId, check.remaining, check.allowed);
				if (!check.allowed) {
					logLine("budget-exhausted", msgId);
					msgId = undefined; // fall back to a proactive message
				}
			}
			const to: Target = { scope: target.scope, targetId: target.targetId, ...(msgId ? { msgId } : {}) };
			try {
				await bot.sendText(to, chunk);
				if (msgId) budget.record(msgId);
				outCount += 1;
				logLine("outbound", msgId ? "passive" : "proactive", chunk.length, chunk.slice(0, 80));
			} catch (err) {
				lastError = (err as Error).message;
				logLine("outbound-error", lastError);
				notify(`pi-qqbot: 发送失败 ${lastError}`, "error");
			}
		}
	}

	async function flush(opts: { final?: boolean } = {}): Promise<void> {
		debouncer.cancel();
		const text = pendingText.join("\n\n").trim();
		if (!text) {
			// With no text, only report the tool trace at the very end of a turn.
			if (opts.final && pendingTools.length > 0) {
				const trace = formatToolTrace(pendingTools);
				pendingTools = [];
				if (trace) await sendToQQ(trace);
			}
			return;
		}
		const tools = pendingTools.slice();
		pendingText = [];
		pendingTools = [];
		const payload = composePayload(text, cfg?.showToolTrace ? tools : []);
		if (payload) await sendToQQ(payload);
	}

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event: any, ctx: any) => {
		ctxRef = ctx as ExtensionContext;
		busy = false;
		const persisted = loadState();
		target = persisted
			? { scope: persisted.scope, targetId: persisted.targetId, msgId: freshMsgId(persisted, Date.now()) }
			: undefined;
		budget.reset();
		budgetNotified.clear();
		seen.clear();
		pendingText = [];
		pendingTools = [];
		debouncer.cancel();
		ensureExampleConfig();
		const pre = loadConfig();
		if (pre.ok) cfg = pre.config;
		if (cfg?.autoConnect) {
			await startBot();
		} else {
			logLine("idle", "autoConnect=false — run /qq-connect to connect");
		}
	});

	pi.on("session_shutdown", async (_event: any) => {
		stopBot("session_shutdown");
	});

	// ------------------------------------------------------------- agent events

	pi.on("agent_start", async () => {
		busy = true;
		pendingText = [];
		pendingTools = [];
	});

	pi.on("agent_settled", async () => {
		busy = false;
		await flush({ final: true });
	});

	pi.on("tool_execution_start", async (event: any) => {
		void sendTyping();
		if (!cfg?.showToolTrace) return;
		const name = String(event?.toolName ?? "").trim();
		if (name) pendingTools.push(name);
	});

	pi.on("message_end", async (event: any) => {
		const message = event?.message;
		if (!message || typeof message !== "object") return;

		if (message.role === "assistant") {
			const text = extractText(message.content).trim();
			if (!text) return; // tool-only / thinking-only message: nothing to mirror
			pendingText.push(text);
			// Default: hold assistant output until the turn settles, so the final
			// answer is what consumes QQ's scarce passive-reply quota instead of
			// intermediate commentary. Opt into streaming with streamIntermediate.
			if (cfg?.streamIntermediate) {
				debouncer.schedule(() => {
					void flush();
				});
			}
			return;
		}

		if (message.role === "user") {
			if (!cfg?.forwardTerminal) return;
			const text = extractText(message.content).trim();
			if (!text || isInjected(text)) return; // never echo QQ-originated input
			if (text.startsWith("/")) return; // don't mirror slash commands
			await sendToQQ(text, "🖥 终端");
		}
	});

	// ------------------------------------------------------------------ commands

	pi.registerCommand("qq-status", {
		description: "Show pi-qqbot bridge status",
		handler: async (_args: string, ctx: any) => {
			const lines = [
				`pi-qqbot: ${running ? "running" : "stopped"}`,
				`autoConnect: ${cfg?.autoConnect ?? false}`,
				`lock holder: ${(() => { const h = readLock(); return h ? `pid ${h.pid} @ ${h.host}` : "(free)"; })()}`,
				`config: ${configPath()}`,
				`log: ${logPath()}`,
				`allowFrom: ${cfg?.allowFrom?.length ? cfg.allowFrom.join(", ") : "(none — run /qq-bind)"}`,
				`target: ${target ? `${target.scope}:${target.targetId}` : "(none)"}`,
				`passive budget: ${target?.msgId ? budget.remaining(target.msgId) : "-"} / 4`,
				`sent: ${outCount}`,
				`lastError: ${lastError ?? "-"}`,
			];
			(ctx as ExtensionContext).ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("qq-connect", {
		description: "Connect the QQ gateway",
		handler: async () => {
			await startBot();
		},
	});

	pi.registerCommand("qq-disconnect", {
		description: "Disconnect the QQ gateway",
		handler: async () => {
			stopBot("command");
			notify("pi-qqbot: 已断开", "info");
		},
	});

	pi.registerCommand("qq-bind", {
		description: "Bind the next QQ private sender as the only allowed owner",
		handler: async (_args: string, ctx: any) => {
			binding = true;
			if (!running) await startBot();
			(ctx as ExtensionContext).ui.notify("pi-qqbot: 请在 QQ 私聊机器人发送任意一条消息以完成绑定", "info");
		},
	});

	pi.registerCommand("qq-setup", {
		description: "交互式初始化：填写 QQ 机器人 AppID / AppSecret（不包含绑定）",
		handler: async (_args: string, ctx: any) => {
			const c = ctx as ExtensionContext;
			if (typeof c.ui?.input !== "function") {
				c.ui.notify(
					`pi-qqbot: 引导配置需要在交互式 TUI 中运行；也可手动编辑 ${configPath()}`,
					"error",
				);
				return;
			}
			const existing = loadConfig();
			if (existing.ok) {
				const again = await c.ui.confirm(
					"pi-qqbot 初始化",
					`当前已配置 appId=${existing.config.appId}。要重新配置吗？`,
				);
				if (!again) return;
			} else {
				c.ui.notify("pi-qqbot: 首次配置向导", "info");
			}

			const appId = (await c.ui.input("QQ Bot AppID", "例如 1905615480"))?.trim();
			if (!appId) {
				c.ui.notify("pi-qqbot: 已取消（AppID 为空）", "error");
				return;
			}
			const appSecret = (await c.ui.input("QQ Bot AppSecret", "在 QQ 开放平台获取"))?.trim();
			if (!appSecret) {
				c.ui.notify("pi-qqbot: 已取消（AppSecret 为空）", "error");
				return;
			}
			const markdownSupport = await c.ui.confirm(
				"Markdown 权限",
				"机器人是否已通过 QQ Markdown 权限审核？（不确定就选“否”，否则发 Markdown 会被平台拒绝）",
			);

			const saved = saveConfig({ appId, appSecret, markdownSupport });
			if (!saved.ok) {
				c.ui.notify(`pi-qqbot: 保存失败 ${saved.error}`, "error");
				return;
			}
			c.ui.notify(`pi-qqbot: 配置已保存到 ${configPath()}`);

			const reloaded = loadConfig();
			if (reloaded.ok) cfg = reloaded.config;
			if (running) stopBot("reconfigure");
			await startBot();

			if (cfg && cfg.allowFrom.length === 0) {
				c.ui.notify(
					"pi-qqbot: 配置已保存并连接。下一步：执行 /qq-bind 绑定你的 QQ 号。",
					"info",
				);
			} else {
				c.ui.notify("pi-qqbot: 配置已保存并连接。", "info");
			}
		},
	});
}
