/**
 * Setup harness — verifies the guided `/qq-setup` command and the separation
 * between configuration and binding:
 *
 *   /qq-setup  -> saves credentials (0600) + connects, but MUST NOT arm binding
 *   QQ message -> ignored while no owner is bound
 *   /qq-bind   -> arms binding; the next QQ message binds the owner
 *
 * Run: node test/setup-harness.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..");

const home = mkdtempSync(join(tmpdir(), "piqq-setup-"));
const configFile = join(home, "config.json");

process.env.HOME = home;
// Points at a path that does not exist yet.
process.env.PI_QQBOT_CONFIG = configFile;
process.env.PI_QQBOT_STATE = join(home, "state.json");
process.env.PI_QQBOT_LOCK = join(home, "qq.lock");
process.env.PI_QQBOT_LOG = join(home, "log.txt");
process.env.PI_QQBOT_SDK = pathToFileURL(join(here, "fake-sdk.mjs")).href;
globalThis.__piQQBotFake = { instances: [] };

const jiti = createJiti(pathToFileURL(join(extDir, "index.ts")).href);
const extension = await jiti.import("./index.ts");

const handlers = new Map();
const commands = new Map();
const mockPi = {
	on: (e, h) => handlers.set(e, h),
	registerCommand: (n, o) => commands.set(n, o),
	sendUserMessage: () => {},
};
extension.default(mockPi);

const readConfig = () => JSON.parse(readFileSync(configFile, "utf8"));
const notifications = [];
const answers = ["123456789", "sup3r-secret"];
let confirmAnswer = false; // markdown permission: no
const ctx = {
	ui: {
		notify: (m) => notifications.push(String(m)),
		confirm: async () => confirmAnswer,
		input: async () => answers.shift(),
	},
	isIdle: () => true,
};
const msg = (id, sender = "OWNER-9") => ({
	kind: "c2c",
	senderId: sender,
	content: "hi",
	messageId: id,
	replyTarget: { scope: "c2c", targetId: sender, msgId: id },
});

await handlers.get("session_start")({}, ctx);
assert.equal(globalThis.__piQQBotFake.instances.length, 0, "must not connect before setup");

await commands.get("qq-setup").handler("", ctx);

const saved = readConfig();
assert.equal(saved.appId, "123456789");
assert.equal(saved.appSecret, "sup3r-secret");
assert.equal(saved.markdownSupport, false);
assert.equal(statSync(configFile).mode & 0o777, 0o600, "config must be 0600");
console.log("ok  /qq-setup persisted appId/appSecret with 0600");

const bot = globalThis.__piQQBotFake.instances.at(-1);
assert.ok(bot, "setup should have started the transport");
assert.ok(bot.started, "transport should be running");
console.log("ok  /qq-setup connected the QQ transport");

assert.ok(
	notifications.some((m) => m.includes("/qq-bind")),
	"setup must instruct the user to run /qq-bind",
);
console.log("ok  /qq-setup instructs the user to run /qq-bind");

// A QQ message right after setup must NOT bind (setup no longer arms binding).
await bot.emitMessage({}, msg("x1"));
assert.deepEqual(readConfig().allowFrom, [], "setup must not auto-bind");
console.log("ok  QQ message before /qq-bind is ignored (no auto-bind)");

// Explicit /qq-bind arms binding; the next message binds the owner.
confirmAnswer = true;
await commands.get("qq-bind").handler("", ctx);
await bot.emitMessage({}, msg("x2"));
assert.deepEqual(readConfig().allowFrom, ["OWNER-9"]);
console.log("ok  explicit /qq-bind bound the owner");

await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
console.log("ok  shutdown released the transport");

console.log("\nSETUP HARNESS PASSED");
