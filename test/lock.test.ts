import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, readLock, releaseLock } from "../lock.ts";

const dir = mkdtempSync(join(tmpdir(), "piqq-lock-"));
const p = join(dir, "l.lock");

test("lock: acquire when free", () => {
	const r = acquireLock({ path: p, pid: 100 });
	assert.equal(r.ok, true);
	assert.equal(readLock(p)?.pid, 100);
});

test("lock: refused while a live holder owns it", () => {
	const r = acquireLock({ path: p, pid: 200, isAlive: () => true });
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.holder.pid, 100);
});

test("lock: same pid re-acquire is allowed", () => {
	const r = acquireLock({ path: p, pid: 100 });
	assert.equal(r.ok, true);
});

test("lock: stale holder (dead pid) is reclaimed", () => {
	const r = acquireLock({ path: p, pid: 300, isAlive: () => false });
	assert.equal(r.ok, true);
	assert.equal(readLock(p)?.pid, 300);
});

test("lock: release only removes the owner's lock", () => {
	releaseLock({ path: p, pid: 999 });
	assert.equal(readLock(p)?.pid, 300, "non-owner release must not clear it");
	releaseLock({ path: p, pid: 300 });
	assert.equal(readLock(p), undefined);
});

test("lock: corrupt lock file is treated as free", () => {
	const bad = join(dir, "bad.lock");
	writeFileSync(bad, "not json");
	assert.equal(readLock(bad), undefined);
	const r = acquireLock({ path: bad, pid: 7 });
	assert.equal(r.ok, true);
});
