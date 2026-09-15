import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshMsgId, loadState, saveState, statePath } from "../state.ts";

const dir = mkdtempSync(join(tmpdir(), "piqq-state-"));
const file = join(dir, "state.json");

test("state: save/load round-trip (mode 0600)", () => {
	saveState({ scope: "c2c", targetId: "u1", msgId: "m1", at: 1000 }, file);
	const loaded = loadState(file);
	assert.deepEqual(loaded, { scope: "c2c", targetId: "u1", msgId: "m1", at: 1000 });
	assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("state: missing file -> undefined", () => {
	assert.equal(loadState(join(dir, "nope.json")), undefined);
});

test("state: corrupt file -> undefined", () => {
	const bad = join(dir, "bad.json");
	writeFileSync(bad, "{not json");
	assert.equal(loadState(bad), undefined);
});

test("state: invalid scope/targetId rejected", () => {
	const bad = join(dir, "bad2.json");
	writeFileSync(bad, JSON.stringify({ scope: "telegram", targetId: "x" }));
	assert.equal(loadState(bad), undefined);
});

test("freshMsgId: valid inside the TTL window", () => {
	const t = { scope: "c2c" as const, targetId: "u1", msgId: "m1", at: 0 };
	assert.equal(freshMsgId(t, 59 * 60 * 1000), "m1");
});

test("freshMsgId: dropped after the TTL window", () => {
	const t = { scope: "c2c" as const, targetId: "u1", msgId: "m1", at: 0 };
	assert.equal(freshMsgId(t, 61 * 60 * 1000), undefined);
});

test("freshMsgId: undefined when no msgId", () => {
	assert.equal(freshMsgId({ scope: "c2c", targetId: "u1", at: 0 }, 0), undefined);
	assert.equal(freshMsgId(undefined, 0), undefined);
});

test("statePath honours the PI_QQBOT_STATE override", () => {
	const prev = process.env.PI_QQBOT_STATE;
	process.env.PI_QQBOT_STATE = "/tmp/custom-state.json";
	try {
		assert.equal(statePath(), "/tmp/custom-state.json");
	} finally {
		if (prev === undefined) delete process.env.PI_QQBOT_STATE;
		else process.env.PI_QQBOT_STATE = prev;
	}
});
