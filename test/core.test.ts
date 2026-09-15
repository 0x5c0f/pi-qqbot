import { test } from "node:test";
import assert from "node:assert/strict";
import {
	Debouncer,
	ReplyBudget,
	budgetWarning,
	chunkText,
	composePayload,
	extractText,
	formatToolTrace,
	isInjected,
	markInjected,
} from "../core.ts";

test("extractText: plain string", () => {
	assert.equal(extractText("hello"), "hello");
	assert.equal(extractText(undefined), "");
});

test("extractText: keeps only text blocks (drops thinking and toolCall)", () => {
	const content = [
		{ type: "thinking", thinking: "SECRET REASONING" },
		{ type: "text", text: "visible answer" },
		{ type: "toolCall", name: "bash", arguments: { command: "rm -rf /" } },
		{ type: "text", text: "second paragraph" },
	];
	const out = extractText(content);
	assert.equal(out, "visible answer\nsecond paragraph");
	assert.ok(!out.includes("SECRET REASONING"));
});

test("chunkText: short text passes through", () => {
	assert.deepEqual(chunkText("hi", 100), ["hi"]);
	assert.deepEqual(chunkText("", 100), []);
});

test("chunkText: every chunk respects the limit and content is preserved", () => {
	const para = "x".repeat(300);
	const text = Array.from({ length: 20 }, () => para).join("\n\n");
	const chunks = chunkText(text, 1000);
	assert.ok(chunks.length > 1);
	for (const c of chunks) assert.ok(c.length <= 1000, `chunk too long: ${c.length}`);
	// Content preserved modulo collapsed boundary whitespace.
	assert.equal(chunks.join("").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("chunkText: prefers paragraph boundaries", () => {
	const text = `${"a".repeat(100)}\n\n${"b".repeat(100)}`;
	const chunks = chunkText(text, 150);
	assert.equal(chunks[0], "a".repeat(100));
	assert.equal(chunks[1], "b".repeat(100));
});

test("chunkText: hard-cuts an unbreakable run", () => {
	const text = "c".repeat(2500);
	const chunks = chunkText(text, 1000);
	assert.deepEqual(chunks.map((c) => c.length), [1000, 1000, 500]);
});

test("ReplyBudget: allows exactly 4 passive replies per message", () => {
	const b = new ReplyBudget(4, 60 * 60 * 1000, () => 0);
	for (let i = 0; i < 4; i++) {
		assert.equal(b.check("m1").allowed, true, `reply ${i + 1} should be allowed`);
		b.record("m1");
	}
	const after = b.check("m1");
	assert.equal(after.allowed, false);
	assert.equal(after.remaining, 0);
	// A different inbound message has its own budget.
	assert.equal(b.check("m2").allowed, true);
});

test("ReplyBudget: expires after the TTL", () => {
	let now = 0;
	const b = new ReplyBudget(4, 1000, () => now);
	for (let i = 0; i < 4; i++) {
		b.record("m1");
	}
	assert.equal(b.check("m1").allowed, false);
	now = 1001;
	assert.equal(b.check("m1").allowed, true);
});

test("formatToolTrace: de-dupes and preserves first-seen order", () => {
	assert.equal(formatToolTrace([]), "");
	assert.equal(formatToolTrace(["read", "bash", "read"]), "🔧 read · bash");
});

test("composePayload: prepends the tool trace to the text", () => {
	assert.equal(composePayload("answer", ["read", "edit"]), "🔧 read · edit\nanswer");
	assert.equal(composePayload("answer", []), "answer");
	assert.equal(composePayload("", ["read"]), "🔧 read");
	assert.equal(composePayload("", []), "");
});

test("budgetWarning: classifies remaining passive replies", () => {
	assert.equal(budgetWarning(4, true), "none");
	assert.equal(budgetWarning(2, true), "none");
	assert.equal(budgetWarning(1, true), "low");
	assert.equal(budgetWarning(0, true), "low");
	assert.equal(budgetWarning(0, false), "exhausted");
	assert.equal(budgetWarning(3, false), "exhausted");
});

test("injection marker round-trips and is detected", () => {
	const marked = markInjected("hello from qq");
	assert.ok(isInjected(marked));
	assert.ok(!isInjected("hello from terminal"));
	assert.ok(isInjected("   [QQ] leading spaces"));
});

test("Debouncer: coalesces rapid schedules into one call", async () => {
	const d = new Debouncer(30);
	let calls = 0;
	d.schedule(() => calls++);
	d.schedule(() => calls++);
	d.schedule(() => calls++);
	assert.ok(d.pending);
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(calls, 1);
	assert.ok(!d.pending);
});

test("Debouncer: cancel prevents the call", async () => {
	const d = new Debouncer(30);
	let calls = 0;
	d.schedule(() => calls++);
	d.cancel();
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(calls, 0);
});

test("Debouncer: setWindow changes the effective delay", async () => {
	const d = new Debouncer(2000);
	let calls = 0;
	d.setWindow(30);
	d.schedule(() => calls++);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(calls, 1);
});
