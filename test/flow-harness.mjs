/**
 * Full offline flow test for pi-qqbot using a fake QQ SDK.
 *
 * Verifies: allowlist, dedupe, [QQ] echo prevention, thinking/tool-only
 * filtering, tool-trace prefix, debounce coalescing, terminal mirroring,
 * and passive-reply-budget fallback to proactive.
 *
 * Run: node test/flow-harness.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..");

const home = mkdtempSync(join(tmpdir(), "piqq-flow-"));
const configFile = join(home, "pi-qqbot.json");
writeFileSync(
	configFile,
	JSON.stringify({
		appId: "123456",
		appSecret: "s3cret",
		markdownSupport: false,
		allowFrom: ["owner-1"],
		debounceMs: 250,
		maxChunkChars: 500,
		forwardTerminal: true,
		showToolTrace: true,
		allowGroup: false,
		autoConnect: true,
	}),
);

process.env.HOME = home;
process.env.PI_QQBOT_CONFIG = configFile;
process.env.PI_QQBOT_LOG = join(home, "log.txt");
process.env.PI_QQBOT_LOCK = join(home, "qq.lock");
process.env.PI_QQBOT_SDK = pathToFileURL(join(here, "fake-sdk.mjs")).href;
globalThis.__piQQBotFake = { instances: [] };

const jiti = createJiti(pathToFileURL(join(extDir, "index.ts")).href);
const extension = await jiti.import("./index.ts");

const handlers = new Map();
const commands = new Map();
const userMessages = [];
const mockPi = {
	on: (e, h) => handlers.set(e, h),
	registerCommand: (n, o) => commands.set(n, o),
	sendUserMessage: (content, options) => userMessages.push({ content, options }),
};

extension.default(mockPi);

const notifications = [];
const ctx = {
	ui: { notify: (m, l) => notifications.push({ m, l }), confirm: async () => false },
	isIdle: () => true,
};

await handlers.get("session_start")({ reason: "startup" }, ctx);
const bot = globalThis.__piQQBotFake.instances.at(-1);
assert.ok(bot, "fake QQBot should have been constructed");
assert.ok(bot.started, "fake QQBot should have been started");
console.log("ok  session_start constructed and started the QQ transport");

const send = (event, payload = {}) => handlers.get(event)(payload, ctx);
const inbound = (over = {}) => ({
	kind: "c2c",
	senderId: "owner-1",
	content: "你好",
	messageId: "m1",
	replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m1" },
	...over,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. allowlisted inbound -> injected with the [QQ] marker
await bot.emitMessage({}, inbound());
assert.deepEqual(userMessages.at(-1).content, "[QQ] 你好");
assert.ok(bot.typingCalls.length > 0, "typing indicator should be sent");
console.log("ok  inbound QQ message injected as [QQ] <text>");

// 2. non-allowlisted sender ignored
const before = userMessages.length;
await bot.emitMessage({}, inbound({ senderId: "stranger", messageId: "m2" }));
assert.equal(userMessages.length, before, "stranger must not reach pi");
console.log("ok  non-allowlisted sender ignored");

// 3. duplicate message id deduped
await bot.emitMessage({}, inbound());
assert.equal(userMessages.length, before, "duplicate messageId must be deduped");
console.log("ok  duplicate inbound message deduped");

// 4. thinking-only assistant message produces no QQ send
await send("message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] } });
await send("agent_settled", {});
assert.equal(bot.sent.length, 0, "thinking-only output must not be mirrored");
console.log("ok  thinking-only output dropped (reasoning never leaves the terminal)");

// 5. assistant text mirrored with tool trace prefix, as a passive reply
await send("tool_execution_start", { toolName: "read" });
await send("message_end", {
	message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "看完了" }] },
});
await send("agent_settled", {});
assert.equal(bot.sent.at(-1).content, "🔧 read\n看完了");
assert.equal(bot.sent.at(-1).target.msgId, "m1", "should be a passive reply");
console.log("ok  assistant text mirrored with tool trace, as passive reply");

// 6. debounce coalesces a burst into a single QQ message
const sentBefore = bot.sent.length;
await send("message_end", { message: { role: "assistant", content: [{ type: "text", text: "第一段" }] } });
await send("message_end", { message: { role: "assistant", content: [{ type: "text", text: "第二段" }] } });
await sleep(400);
assert.equal(bot.sent.length, sentBefore + 1, "burst should coalesce into one send");
assert.equal(bot.sent.at(-1).content, "第一段\n\n第二段");
console.log("ok  burst of assistant messages coalesced into one QQ send");

// 7. terminal-typed user message mirrored with the 终端 prefix
await send("message_end", { message: { role: "user", content: "终端输入" } });
assert.equal(bot.sent.at(-1).content, "🖥 终端\n终端输入");
console.log("ok  terminal input mirrored to QQ");

// 8. QQ-originated input is never echoed back
const beforeEcho = bot.sent.length;
await send("message_end", { message: { role: "user", content: "[QQ] 你好" } });
assert.equal(bot.sent.length, beforeEcho, "QQ input must not be echoed");
console.log("ok  QQ-originated input not echoed back");

// 9. slash commands are not mirrored
await send("message_end", { message: { role: "user", content: "/model" } });
assert.equal(bot.sent.length, beforeEcho, "slash commands must not be mirrored");
console.log("ok  slash commands not mirrored");

// 10. passive reply budget: 4 passive, then proactive fallback
await bot.emitMessage({}, inbound({ content: "go", messageId: "m3", replyTarget: { scope: "c2c", targetId: "owner-1", msgId: "m3" } }));
const mark = bot.sent.length;
await send("message_end", { message: { role: "assistant", content: [{ type: "text", text: "z".repeat(2200) }] } });
await send("agent_settled", {});
const forM3 = bot.sent.slice(mark).filter((s) => s.target.targetId === "owner-1" && s.content.startsWith("z"));
assert.ok(forM3.length >= 5, `expected >=5 chunks, got ${forM3.length}`);
const passive = forM3.filter((s) => s.target.msgId === "m3").length;
const proactive = forM3.filter((s) => !s.target.msgId).length;
assert.equal(passive, 4, "exactly 4 passive replies allowed");
assert.ok(proactive >= 1, "overflow must fall back to proactive");
console.log(`ok  passive budget enforced (${passive} passive, ${proactive} proactive)`);
assert.ok(
	notifications.some((n) => String(n.m).includes("被动回复额度已用尽")),
	"terminal should be warned when the passive budget is exhausted",
);
console.log("ok  terminal warned about exhausted passive budget");

// 11. disconnect stops the transport
await send("session_shutdown", { reason: "quit" });
assert.ok(bot.stopped, "session_shutdown should stop the transport");
console.log("ok  session_shutdown stopped the transport");

console.log("\nFLOW HARNESS PASSED");
