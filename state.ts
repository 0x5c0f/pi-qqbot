/** Persisted last-known reply target, so terminal mirroring survives restarts. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PASSIVE_REPLY_TTL_MS } from "./core.ts";

export type Scope = "c2c" | "group";

export interface PersistedTarget {
	scope: Scope;
	targetId: string;
	/** Inbound message id; only usable for passive replies inside the TTL window. */
	msgId?: string;
	/** Epoch ms when this target was last observed. */
	at: number;
}

export function statePath(): string {
	return process.env.PI_QQBOT_STATE || path.join(os.homedir(), ".pi", "agent", "pi-qqbot.state.json");
}

export function loadState(filePath: string = statePath()): PersistedTarget | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
		if (!raw || typeof raw !== "object") return undefined;
		const scope = raw.scope === "group" ? "group" : raw.scope === "c2c" ? "c2c" : undefined;
		const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
		if (!scope || !targetId) return undefined;
		return {
			scope,
			targetId,
			msgId: typeof raw.msgId === "string" && raw.msgId ? raw.msgId : undefined,
			at: typeof raw.at === "number" ? raw.at : 0,
		};
	} catch {
		return undefined;
	}
}

export function saveState(t: PersistedTarget, filePath: string = statePath()): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(t)}\n`, { mode: 0o600 });
	} catch {
		// Persisting the target is best-effort.
	}
}

/**
 * Return the persisted msgId only while it is still valid for a passive reply.
 * After the TTL the platform rejects it, so callers must send proactively
 * (no msgId) instead.
 */
export function freshMsgId(
	t: PersistedTarget | undefined,
	now: number,
	ttlMs: number = PASSIVE_REPLY_TTL_MS,
): string | undefined {
	if (!t || !t.msgId) return undefined;
	return now - t.at <= ttlMs ? t.msgId : undefined;
}
