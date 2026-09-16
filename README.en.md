# pi-qqbot

<p align="center">
  <img src="./assets/pi-qqbot.png" alt="pi-qqbot" width="100%" />
</p>

**English** | [简体中文](./README.md)

Mirror a **live [pi](https://pi.dev) session** to a QQ private chat. Terminal and QQ stay in sync; reasoning (`thinking`) and tool calls never leave your machine.

Transport is the official Tencent SDK [`@tencent-connect/qqbot-nodejs`](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs) (MIT). This extension is a thin, auditable glue layer with no third-party plugin dependencies.

## Features

- **Two-way sync**: QQ messages are injected into the running pi session; pi's replies go back to QQ.
- **Terminal mirrored too**: what you type in the terminal is forwarded to QQ.
- **No reasoning leak**: only assistant `text` blocks are sent; `thinking` is never forwarded.
- **No spam**: tool calls are hidden from QQ by default.
- **Oversize-safe**: debounced coalescing plus chunking to QQ's per-message limit.
- **Budget-aware**: warns in the terminal when QQ's passive-reply budget runs low or out.
- **Single-instance lock**: only one pi process holds the QQ connection at a time.
- **Manual connect by default**: `autoConnect: false`, so no pi process grabs the bot by accident.

## Requirements

- [pi](https://pi.dev) installed (Node version follows pi).
- A QQ bot on the QQ Open Platform with **C2C / private-message** permission enabled, plus its `AppID` and `AppSecret`.

## Install

Install as a pi package (recommended):

```bash
pi install git:github.com/0x5c0f/pi-qqbot
```

Pin a version:

```bash
pi install git:github.com/0x5c0f/pi-qqbot@v0.1.0
```

Or via SSH / npm (once published):

```bash
pi install git:git@github.com:0x5c0f/pi-qqbot
pi install npm:@0x5c0f/pi-qqbot
```

Project-local install (`.pi/`):

```bash
pi install -l git:github.com/0x5c0f/pi-qqbot
```

**Fully quit and restart pi** after installing (extensions load at startup).

## Quick start

1. After restarting pi, run `/qq-setup` in the terminal.
   Enter AppID, AppSecret and whether the bot has Markdown permission — it saves and connects (**no binding**).
2. Run `/qq-bind` to enter binding mode.
3. Send **any message** to the bot in a QQ private chat.
4. The terminal shows a confirmation with the detected openid; confirm it to write the allowlist.

After that, terminal and QQ are in sync. Only the allowlisted openid can drive the session.

## Commands

| Command | Purpose |
| --- | --- |
| `/qq-setup` | Interactive config: enter AppID/AppSecret, save and connect (**no binding**) |
| `/qq-bind` | Enter binding mode: write the next QQ private sender's openid into the allowlist (use when switching QQ accounts or if the allowlist was lost) |
| `/qq-connect` | Connect the QQ gateway (acquires the single-instance lock) |
| `/qq-disconnect` | Disconnect the QQ gateway and release the lock |
| `/qq-status` | Show connection, `autoConnect`, lock holder, reply target, passive budget, log path, last error |

Switching terminals: run `/qq-disconnect` in the old instance, then `/qq-connect` in the new one.

## Configuration

`/qq-setup` writes `~/.pi/agent/pi-qqbot.json` (mode `0600`):

```json
{
  "appId": "YOUR_QQBOT_APP_ID",
  "appSecret": "YOUR_QQBOT_APP_SECRET",
  "markdownSupport": false,
  "allowFrom": [],
  "debounceMs": 1200,
  "maxChunkChars": 4500,
  "forwardTerminal": true,
  "showToolTrace": false,
  "allowGroup": false,
  "autoConnect": false
}
```

| Field | Default | Description |
| --- | --- | --- |
| `appId` / `appSecret` | required | QQ Open Platform bot credentials |
| `markdownSupport` | `false` | Whether the bot has Markdown permission. Keep `false` unless approved |
| `allowFrom` | `[]` | Allowlisted QQ openids. Empty = bind-only, messages ignored |
| `debounceMs` | `1200` | Coalescing window (ms) for assistant output |
| `maxChunkChars` | `4500` | Per-message chunk size (platform cap is ~5000) |
| `forwardTerminal` | `true` | Mirror terminal input to QQ |
| `showToolTrace` | `false` | Prefix the next message with called tool names |
| `allowGroup` | `false` | Also accept group @ messages |
| `autoConnect` | `false` | Connect automatically on pi startup. `false` = use `/qq-connect` |

Environment overrides: `PI_QQBOT_CONFIG`, `PI_QQBOT_LOG`, `PI_QQBOT_STATE`, `PI_QQBOT_LOCK`.

## Behavior and trade-offs

Three sync directions:

```
(1) QQ -> pi     inject into the current session (tagged [QQ] to prevent echo)
(2) pi -> QQ     assistant text blocks are sent back
(3) terminal -> QQ   terminal input is mirrored (prefixed with 🖥 终端)
```

- **No reasoning leak**: only `text` blocks are extracted; `thinking` / `toolCall` blocks are excluded by construction.
- **Tool calls hidden**: `showToolTrace` is off by default; while tools run, QQ only shows its native "typing" indicator (no message).
- **Debounce + chunk**: avoids notification storms and oversize failures.
- **Passive-reply budget**: a QQ C2C inbound message allows at most **4 passive replies per 60 minutes** (groups: 5 / 5 min). After that, replies fall back to proactive messages (rate-limited, may be intercepted). The terminal warns when 1 reply remains or the budget is exhausted — send any QQ message to refresh.
- **Single-instance lock**: `~/.pi/agent/pi-qqbot.lock`. If a live pi holds it, a second instance refuses to connect and reports the holder PID; stale locks from crashed processes are reclaimed automatically.
- **No history migration**: only the reply target (`scope` / `targetId` / `msgId`) is persisted — **no chat content**. Connecting a different pi session to QQ does not inject QQ history into it, so context stays clean. Use pi's own `/resume` if you want continuity.

## Logs

`~/.pi/agent/logs/pi-qqbot.log` (mode `0600`, truncated at 2 MB). `/qq-status` shows the path.

## Security

- **Only bind your own QQ account.** This extension turns your local coding agent into a remote QQ entry point — equivalent to remote execution access.
- While unbound (`allowFrom` empty), incoming QQ messages are ignored.
- Config, state and log files are `0600` and are git-ignored.

## Development and tests

```bash
git clone https://github.com/0x5c0f/pi-qqbot
cd pi-qqbot
npm install
npm test
```

Tests are fully offline and need **no real QQ credentials**:

- `test/core.test.ts`, `test/state.test.ts`, `test/lock.test.ts` — unit tests: text extraction (drops thinking), chunking, passive budget, debounce, injection marker, state persistence, single-instance lock.
- `test/load-harness.mjs` — loads the extension via jiti, checks event/command registration and safe failure on a placeholder config.
- `test/flow-harness.mjs` — end-to-end flow over a fake QQ transport (allowlist, dedupe, echo prevention, thinking filtering, debounce, terminal mirroring, budget fallback and warning).
- `test/bind-harness.mjs` — bind flow and reply-target persistence.
- `test/setup-harness.mjs` — separation between `/qq-setup` and `/qq-bind`.

> Unit tests run on Node's native TypeScript support and require **Node >= 22.18**; harnesses load the extension through the `jiti` devDependency.

## Layout

```
index.ts               pi extension entry: lifecycle / events / commands
core.ts                pure logic: text extraction, chunking, budget, debounce, marker
config.ts              config load / validate / save (0600)
state.ts               persisted reply target (survives restarts)
lock.ts                single-instance lock
log.ts                 file logger
pi-qqbot.example.json  example config
test/                  unit tests + offline harnesses
assets/                gallery banner (source HTML + PNG)
```

## Boundaries

- **C2C private chat, single owner** only. Group support needs mention gating and multi-session isolation; `allowGroup` is off by default.
- Text mirroring only — no local file/image sending.
- No streaming typewriter (uses debounced coalescing; the official `stream_messages` API is C2C-only and could be a future enhancement).

## License

[MIT](./LICENSE)
