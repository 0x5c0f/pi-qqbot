/**
 * Bind-flow harness — reproduces the reported bug:
 * "after /qq-bind, nothing reaches QQ from the terminal".
 *
 * Root cause was that the bind message never set the reply target, so every
 * outbound send was silently dropped. This verifies the fix: binding now
 * remembers the target, persists it, and terminal output flows immediately.
 *
 * Run: node test/bind-harness.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..");

const home = mkdtempSync(join(tmpdir(), "piqq-bind-"));
const configFile = join(home, "config.json");
const stateFile = join(home, "state.json");

writeFileSync(
	configFile,
	JSON.stringify({
		appId: "123456",
		appSecret: "s3cret",
		allowFrom: [], // bind mode
		debounceMs: 250,
		maxChunkChars: 500,
		forwardTerminal: true,
		showToolTrace: false,
	}),
);
process.env.HOME = home;
process.env.PI_QQBOT_CONFIG = configFile;
process.env.PI_QQBOT_STATE = stateFile;
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

const notifications = [];
const ctx = {
	ui: { notify: (m) => notifications.push(m), confirm: async () => true },
	isIdle: () => true,
};

await handlers.get("session_start")({}, ctx);

// Enter bind mode (this is what starts the transport when autoConnect=false).
await commands.get("qq-bind").handler("", ctx);
const bot = globalThis.__piQQBotFake.instances.at(-1);
assert.ok(bot, "qq-bind should have started the QQ transport");
const send = (event, payload = {}) => handlers.get(event)(payload, ctx);

// Receive the first private message while in bind mode.
await bot.emitMessage(
	{},
	{
		kind: "c2c",
		senderId: "OWNER-1",
		content: "bind me",
		messageId: "b1",
		replyTarget: { scope: "c2c", targetId: "OWNER-1", msgId: "b1" },
	},
);

assert.ok(notifications.some((m) => String(m).includes("已绑定")), "should notify a successful bind");
const savedConfig = JSON.parse(readFileSync(configFile, "utf8"));
assert.deepEqual(savedConfig.allowFrom, ["OWNER-1"], "allowFrom should be persisted");
assert.ok(existsSync(stateFile), "target state should be persisted");
const savedState = JSON.parse(readFileSync(stateFile, "utf8"));
assert.equal(savedState.targetId, "OWNER-1");
assert.equal(savedState.msgId, "b1");
console.log("ok  /qq-bind persisted allowFrom and remembered the reply target");

// The fix: terminal output right after binding must reach QQ using that target.
await send("message_end", { message: { role: "user", content: "hello from terminal" } });
assert.equal(bot.sent.at(-1).content, "🖥 终端\nhello from terminal");
assert.equal(bot.sent.at(-1).target.msgId, "b1", "should reuse the bind message as a passive reply");
console.log("ok  terminal output flows to QQ immediately after binding (bug fixed)");

// Assistant output also reaches QQ without any further QQ message.
await send("message_end", { message: { role: "assistant", content: [{ type: "text", text: "reply text" }] } });
await send("agent_settled", {});
assert.equal(bot.sent.at(-1).content, "reply text");
console.log("ok  assistant output reaches QQ right after binding");

// Tool calls must not leak into QQ when showToolTrace is disabled.
await send("tool_execution_start", { toolName: "read" });
await send("message_end", { message: { role: "assistant", content: [{ type: "text", text: "after tool" }] } });
await send("agent_settled", {});
assert.equal(bot.sent.at(-1).content, "after tool", "tool trace must be omitted when disabled");
console.log("ok  tool calls are not shown in QQ (showToolTrace=false)");

// Clean shutdown so the lock watchdog interval is cleared.
await send("session_shutdown", { reason: "quit" });
assert.ok(bot.stopped, "session_shutdown should stop the transport");
console.log("ok  session_shutdown stopped the transport and released the lock");

console.log("\nBIND HARNESS PASSED");
