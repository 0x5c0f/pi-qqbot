/**
 * Load harness: verifies pi-qqbot loads through jiti (the loader pi uses),
 * that the factory registers the expected events/commands, that session_start
 * fails safe on a placeholder config, and that the official QQ SDK is
 * resolvable from the extension directory.
 *
 * Run: node test/load-harness.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..");

// Isolate config/log paths into a throwaway HOME.
const home = mkdtempSync(join(tmpdir(), "piqq-home-"));
process.env.HOME = home;
process.env.PI_QQBOT_LOG = join(home, "pi-qqbot.log");
delete process.env.PI_QQBOT_CONFIG;


const jiti = createJiti(pathToFileURL(join(extDir, "index.ts")).href);

// -- 1. jiti can load the official ESM SDK --------------------------------
const sdk = await jiti.import("@tencent-connect/qqbot-nodejs");
assert.equal(typeof sdk.QQBot, "function", "QQBot class should be importable via jiti");
console.log("ok  jiti resolves @tencent-connect/qqbot-nodejs (QQBot:", typeof sdk.QQBot + ")");

// -- 2. extension loads and registers the expected surface ----------------
const extension = await jiti.import("./index.ts");
assert.equal(typeof extension.default, "function", "default export must be a factory");
console.log("ok  extension default export is a factory");

const handlers = new Map();
const commands = new Map();
const notifications = [];
const mockPi = {
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: (name, opts) => commands.set(name, opts),
	sendUserMessage: () => {},
};

extension.default(mockPi);

for (const ev of ["session_start", "session_shutdown", "agent_start", "agent_settled", "tool_execution_start", "message_end"]) {
	assert.ok(handlers.has(ev), `missing handler: ${ev}`);
}
console.log("ok  events registered:", [...handlers.keys()].join(", "));

for (const cmd of ["qq-status", "qq-setup", "qq-connect", "qq-disconnect", "qq-bind"]) {
	assert.ok(commands.has(cmd), `missing command: ${cmd}`);
}
console.log("ok  commands registered:", [...commands.keys()].join(", "));

// -- 3. autoConnect defaults to false: session_start must stay idle ----
const ctx = {
	ui: {
		notify: (msg, level) => notifications.push({ msg, level }),
		confirm: async () => false,
	},
	isIdle: () => true,
};
await handlers.get("session_start")({ reason: "startup" }, ctx);
assert.equal(notifications.length, 0, "autoConnect=false must not connect on session_start");
console.log("ok  session_start idle with autoConnect=false (no auto-connect)");

// -- 4. explicit connect fails safe on the placeholder config (no network) -
await commands.get("qq-connect").handler("", ctx);
assert.ok(
	notifications.some((n) => String(n.msg).includes("appId") || String(n.msg).includes("appSecret")),
	"placeholder config should be rejected with a visible notification",
);
console.log("ok  placeholder config rejected safely on explicit connect:");
for (const n of notifications) console.log("      -", n.msg);

// -- 5. commands are invokable without throwing ---------------------------
for (const [name, opts] of commands) {
	await opts.handler("", ctx);
}
console.log("ok  all commands invoked without throwing");

console.log("\nLOAD HARNESS PASSED");
