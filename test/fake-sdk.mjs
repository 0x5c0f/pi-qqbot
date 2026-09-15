/**
 * Fake QQ Bot SDK used by flow-harness.mjs.
 * Records outbound calls and lets the test emit inbound messages.
 * Instances are registered on globalThis so the harness shares them
 * regardless of module identity.
 */

export class QQBot {
	constructor(options) {
		this.options = options;
		this.handlers = new Map();
		this.sent = [];
		this.typingCalls = [];
		this.started = false;
		this.stopped = false;
		const reg = (globalThis.__piQQBotFake ??= { instances: [] });
		reg.instances.push(this);
	}

	on(event, handler) {
		this.handlers.set(event, handler);
		return this;
	}

	async start(signal) {
		this.started = true;
		this.signal = signal;
		await new Promise((resolve) => {
			if (!signal) return;
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	}

	stop() {
		this.stopped = true;
	}

	async sendText(target, content) {
		this.sent.push({ target, content });
		return { id: `msg-${this.sent.length}`, timestamp: "0" };
	}

	async sendTyping(target, durationSec) {
		this.typingCalls.push({ target, durationSec });
		return {};
	}

	async emitMessage(ctx, msg) {
		const handler = this.handlers.get("message");
		if (handler) await handler(ctx, msg);
	}
}
