/**
 * Single-instance lock for the QQ gateway connection.
 *
 * QQ allows one Gateway session per bot; two pi processes connecting at once
 * will fight and flap. This lock guarantees only one pi process holds the
 * connection. Stale locks (dead PID) are reclaimed automatically.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LockInfo {
	pid: number;
	host: string;
	at: number;
}

export type AcquireResult = { ok: true; info: LockInfo } | { ok: false; holder: LockInfo };

export interface LockOptions {
	path?: string;
	pid?: number;
	host?: string;
	isAlive?: (pid: number) => boolean;
	now?: () => number;
}

export function lockPath(): string {
	return process.env.PI_QQBOT_LOCK || path.join(os.homedir(), ".pi", "agent", "pi-qqbot.lock");
}

/** True when a process with `pid` exists (EPERM still means it exists). */
export function defaultIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

export function readLock(p: string = lockPath()): LockInfo | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
		if (raw && typeof raw.pid === "number") {
			return {
				pid: raw.pid,
				host: typeof raw.host === "string" ? raw.host : "unknown",
				at: typeof raw.at === "number" ? raw.at : 0,
			};
		}
	} catch {
		// Missing or corrupt lock: treat as unlocked.
	}
	return undefined;
}

/**
 * Try to become the lock holder.
 * - no lock / stale lock / lock already ours -> ok
 * - live lock held by another pid -> refused, returns the holder
 */
export function acquireLock(opts: LockOptions = {}): AcquireResult {
	const p = opts.path ?? lockPath();
	const pid = opts.pid ?? process.pid;
	const host = opts.host ?? os.hostname();
	const isAlive = opts.isAlive ?? defaultIsAlive;
	const info: LockInfo = { pid, host, at: (opts.now ?? Date.now)() };

	for (let attempt = 0; attempt < 3; attempt++) {
		const holder = readLock(p);
		if (holder) {
			if (holder.pid === pid) return { ok: true, info: holder };
			if (isAlive(holder.pid)) return { ok: false, holder };
			// Stale holder: reclaim and retry.
			try {
				fs.rmSync(p, { force: true });
			} catch {
				// fall through and retry
			}
			continue;
		}
		// No readable holder: clear any corrupt remnant so `wx` can succeed.
		try {
			if (fs.existsSync(p)) fs.rmSync(p, { force: true });
		} catch {
			// fall through and retry
		}
		try {
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, `${JSON.stringify(info)}\n`, { flag: "wx", mode: 0o600 });
			return { ok: true, info };
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue; // lost a race
			const raced = readLock(p);
			return { ok: false, holder: raced ?? info };
		}
	}

	const finalHolder = readLock(p);
	if (finalHolder && finalHolder.pid === pid) return { ok: true, info: finalHolder };
	return { ok: false, holder: finalHolder ?? info };
}

/** Release the lock, but only if this process owns it. */
export function releaseLock(opts: LockOptions = {}): void {
	const p = opts.path ?? lockPath();
	const pid = opts.pid ?? process.pid;
	const holder = readLock(p);
	if (!holder || holder.pid !== pid) return;
	try {
		fs.rmSync(p, { force: true });
	} catch {
		// best-effort
	}
}
