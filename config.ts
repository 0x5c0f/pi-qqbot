/** Config loading / validation / persistence for pi-qqbot. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_CHUNK_CHARS } from "./core.ts";

export interface QQBotConfig {
	appId: string;
	appSecret: string;
	/** Bot has QQ markdown permission. Keep false unless reviewed/approved. */
	markdownSupport: boolean;
	/** QQ openids allowed to drive the session. Empty = bind mode only. */
	allowFrom: string[];
	/** Coalesce window for assistant output, milliseconds. */
	debounceMs: number;
	/** Per-message chunk size, characters. */
	maxChunkChars: number;
	/** Mirror terminal-typed user messages to QQ. */
	forwardTerminal: boolean;
	/** Prefix assistant output with the tools called since the last send. */
	showToolTrace: boolean;
	/** Also accept group @ messages (off by default). */
	allowGroup: boolean;
	/** Connect automatically on session start. Off = connect via /qq-connect. */
	autoConnect: boolean;
	/** Send assistant messages as they arrive (may exhaust QQ's passive reply quota). Off = one consolidated message per turn. */
	streamIntermediate: boolean;
}

export type LoadResult =
	| { ok: true; config: QQBotConfig; path: string }
	| { ok: false; error: string; path: string };

export function configPath(): string {
	return process.env.PI_QQBOT_CONFIG || path.join(os.homedir(), ".pi", "agent", "pi-qqbot.json");
}

function clampInt(value: unknown, lo: number, hi: number, dflt: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(hi, Math.max(lo, Math.round(n)));
}

function strArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}

/** Validate a raw parsed object into a normalized config. */
export function normalizeConfig(raw: unknown, filePath = configPath()): LoadResult {
	if (!raw || typeof raw !== "object") {
		return { ok: false, path: filePath, error: "配置必须是 JSON 对象" };
	}
	const r = raw as Record<string, unknown>;

	const appId = typeof r.appId === "string" ? r.appId.trim() : "";
	const appSecret = typeof r.appSecret === "string" ? r.appSecret.trim() : "";
	if (!appId) return { ok: false, path: filePath, error: "缺少 appId" };
	if (!appSecret) return { ok: false, path: filePath, error: "缺少 appSecret" };
	if (appId.startsWith("YOUR_") || appSecret.startsWith("YOUR_")) {
		return { ok: false, path: filePath, error: `请先在 ${filePath} 填入真实的 appId / appSecret` };
	}

	const config: QQBotConfig = {
		appId,
		appSecret,
		markdownSupport: r.markdownSupport === true,
		allowFrom: strArray(r.allowFrom),
		debounceMs: clampInt(r.debounceMs, 200, 10_000, 1200),
		maxChunkChars: clampInt(r.maxChunkChars, 500, 4800, DEFAULT_MAX_CHUNK_CHARS),
		forwardTerminal: r.forwardTerminal !== false,
		showToolTrace: r.showToolTrace === true,
		allowGroup: r.allowGroup === true,
		autoConnect: r.autoConnect === true,
		streamIntermediate: r.streamIntermediate === true,
	};

	return { ok: true, config, path: filePath };
}

export function loadConfig(filePath = configPath()): LoadResult {
	if (!fs.existsSync(filePath)) {
		return { ok: false, path: filePath, error: `配置文件不存在：${filePath}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (err) {
		return { ok: false, path: filePath, error: `配置文件解析失败：${(err as Error).message}` };
	}
	return normalizeConfig(parsed, filePath);
}

function writeMerged(filePath: string, patch: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
	let existing: Record<string, unknown> = {};
	if (fs.existsSync(filePath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
			if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
		} catch {
			// Keep going: overwrite a corrupt file with the patch.
		}
	}
	const merged = { ...existing, ...patch };
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/** Persist the allowlist (used by `/qq-bind`). File mode is 0600. */
export function saveAllowFrom(openids: string[], filePath = configPath()): { ok: true } | { ok: false; error: string } {
	return writeMerged(filePath, { allowFrom: strArray(openids) });
}

/** Persist an arbitrary config patch (used by `/qq-setup`). File mode is 0600. */
export function saveConfig(
	patch: Partial<QQBotConfig>,
	filePath = configPath(),
): { ok: true } | { ok: false; error: string } {
	return writeMerged(filePath, patch as Record<string, unknown>);
}

/** Create a starter config file if none exists. */
export function ensureExampleConfig(filePath = configPath()): { created: boolean } {
	if (fs.existsSync(filePath)) return { created: false };
	const sample = {
		appId: "YOUR_QQBOT_APP_ID",
		appSecret: "YOUR_QQBOT_APP_SECRET",
		markdownSupport: false,
		allowFrom: [] as string[],
		debounceMs: 1200,
		maxChunkChars: DEFAULT_MAX_CHUNK_CHARS,
		forwardTerminal: true,
		showToolTrace: false,
		allowGroup: false,
		autoConnect: false,
		streamIntermediate: false,
	};
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(sample, null, 2)}\n`, { mode: 0o600 });
		return { created: true };
	} catch {
		return { created: false };
	}
}
