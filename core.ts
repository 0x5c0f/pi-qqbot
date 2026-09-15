/**
 * pi-qqbot — pure, dependency-free core logic.
 *
 * Everything here is deterministic and has no I/O, so it can be unit-tested
 * with Node's native TypeScript support (`node --test test/`).
 *
 * Platform facts these helpers encode (from the QQ Open Platform docs and the
 * official `@tencent-connect/qqbot-nodejs` SDK source):
 *   - a single text message is capped at ~5000 characters;
 *   - a passive reply is only allowed 4 times per inbound C2C message, and the
 *     inbound message is only usable for 60 minutes (group: 5 replies / 5 min);
 *   - `sendText` does NOT chunk for you.
 */

/** Marker prefixed to messages injected into pi from QQ, so we never echo them back. */
export const QQ_MARKER = "[QQ]";

/** Default per-message passive-reply budget (C2C). */
export const PASSIVE_REPLY_LIMIT = 4;
/** Default passive-reply validity window (C2C, 60 minutes). */
export const PASSIVE_REPLY_TTL_MS = 60 * 60 * 1000;
/** Safe per-message chunk size, under the ~5000 char platform cap. */
export const DEFAULT_MAX_CHUNK_CHARS = 4500;

export interface BudgetCheck {
	allowed: boolean;
	remaining: number;
}

/**
 * Tracks the per-inbound-message passive reply budget.
 *
 * Keyed by the inbound `msg_id`. Once the budget is exhausted (or the window
 * expired), callers must fall back to a proactive message or stay silent.
 */
export class ReplyBudget {
	private readonly records = new Map<string, { count: number; firstAt: number }>();
	private readonly limit: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(
		limit: number = PASSIVE_REPLY_LIMIT,
		ttlMs: number = PASSIVE_REPLY_TTL_MS,
		now: () => number = () => Date.now(),
	) {
		this.limit = limit;
		this.ttlMs = ttlMs;
		this.now = now;
	}

	/** Whether another passive reply is allowed for `msgId`. */
	check(msgId: string): BudgetCheck {
		const rec = this.records.get(msgId);
		if (!rec) return { allowed: true, remaining: this.limit };
		if (this.now() - rec.firstAt > this.ttlMs) {
			this.records.delete(msgId);
			return { allowed: true, remaining: this.limit };
		}
		const remaining = this.limit - rec.count;
		return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
	}

	/** Record one passive reply against `msgId`. */
	record(msgId: string): void {
		const t = this.now();
		const rec = this.records.get(msgId);
		if (!rec || t - rec.firstAt > this.ttlMs) {
			this.records.set(msgId, { count: 1, firstAt: t });
		} else {
			rec.count += 1;
		}
	}

	/** Remaining passive replies for `msgId` (for status output). */
	remaining(msgId: string): number {
		return this.check(msgId).remaining;
	}

	reset(msgId?: string): void {
		if (msgId === undefined) this.records.clear();
		else this.records.delete(msgId);
	}

	size(): number {
		return this.records.size;
	}
}

/** Trailing-edge debouncer used to coalesce a burst of assistant messages. */
export class Debouncer {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private ms: number;

	constructor(ms: number) {
		this.ms = ms;
	}

	/** Change the debounce window (cancels any pending call). */
	setWindow(ms: number): void {
		this.cancel();
		this.ms = ms;
	}

	schedule(fn: () => void): void {
		this.cancel();
		this.timer = setTimeout(() => {
			this.timer = null;
			fn();
		}, this.ms);
	}

	cancel(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	get pending(): boolean {
		return this.timer !== null;
	}
}

/**
 * Extract only the human-visible text from a pi message `content`.
 *
 * pi assistant content is a block array; thinking and tool-call blocks are
 * independent block types, so selecting `type === "text"` naturally drops
 * reasoning and tool calls. User content may be a plain string.
 */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/**
 * Split text into chunks no longer than `limit`, preferring paragraph and line
 * boundaries. Falls back to a hard cut when no boundary exists (e.g. long URLs,
 * base64, or minified code).
 */
export function chunkText(text: string, limit: number = DEFAULT_MAX_CHUNK_CHARS): string[] {
	if (!text) return [];
	if (limit <= 0) return [text];
	if (text.length <= limit) return [text];

	const out: string[] = [];
	let rest = text;

	while (rest.length > limit) {
		const win = rest.slice(0, limit);
		let cut = win.lastIndexOf("\n\n");
		if (cut < limit * 0.5) cut = win.lastIndexOf("\n");
		if (cut < limit * 0.5) cut = win.lastIndexOf(" ");
		if (cut <= 0) cut = limit;

		let head = rest.slice(0, cut);
		if (!head.trim()) {
			cut = limit;
			head = rest.slice(0, cut);
		}

		out.push(head.replace(/\s+$/, ""));
		rest = rest.slice(cut).replace(/^\s+/, "");
	}

	if (rest.length > 0) out.push(rest);
	return out.filter((c) => c.length > 0);
}

/** Render a compact, de-duplicated tool trace line (or "" when empty). */
export function formatToolTrace(tools: readonly string[]): string {
	const uniq: string[] = [];
	for (const t of tools) {
		const name = String(t ?? "").trim();
		if (name && !uniq.includes(name)) uniq.push(name);
	}
	return uniq.length > 0 ? `🔧 ${uniq.join(" · ")}` : "";
}

/** Combine buffered assistant text with the tools called since the last send. */
export function composePayload(text: string, tools: readonly string[]): string {
	const trace = formatToolTrace(tools);
	const body = text.trim();
	if (trace && body) return `${trace}\n${body}`;
	return trace || body;
}

/** Tag a QQ-originated message before injecting it into pi. */
export function markInjected(text: string): string {
	return `${QQ_MARKER} ${text}`;
}

/** True when a user message came from QQ (and must not be echoed back). */
export function isInjected(text: string): boolean {
	return text.trimStart().startsWith(QQ_MARKER);
}

/** How urgent the remaining passive-reply budget is. */
export type BudgetWarning = "none" | "low" | "exhausted";

/**
 * Classify the remaining passive-reply budget for a user-facing hint.
 * `remaining` is the count still available BEFORE the current send.
 */
export function budgetWarning(remaining: number, allowed: boolean): BudgetWarning {
	if (!allowed) return "exhausted";
	if (remaining <= 1) return "low";
	return "none";
}
