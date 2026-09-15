/** Minimal file logger for pi-qqbot (no console spam inside pi). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Dedicated log directory so the agent dir does not accumulate loose files. */
const LOG_DIR = path.join(os.homedir(), ".pi", "agent", "logs");
const LOG_PATH = process.env.PI_QQBOT_LOG || path.join(LOG_DIR, "pi-qqbot.log");
const MAX_BYTES = 2 * 1024 * 1024;

export function logPath(): string {
	return LOG_PATH;
}

export function logLine(...parts: unknown[]): void {
	try {
		fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
		const existed = fs.existsSync(LOG_PATH);
		if (existed && fs.statSync(LOG_PATH).size > MAX_BYTES) {
			fs.writeFileSync(LOG_PATH, "", { mode: 0o600 });
		}
		const rendered = parts
			.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
			.join(" ");
		// Logs may contain message previews: keep the file private (0600).
		fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${rendered}\n`, { mode: 0o600 });
		if (!existed) {
			try {
				fs.chmodSync(LOG_PATH, 0o600);
			} catch {
				// best-effort
			}
		}
	} catch {
		// Logging must never break the bridge.
	}
}
