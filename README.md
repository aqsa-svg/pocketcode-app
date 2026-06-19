# PocketCode — control Claude Code from your phone 📱

Run [Claude Code](https://docs.claude.com/claude-code) on your computer, drive it
from your phone. Scan a QR code and you're in — **end-to-end encrypted**, and
nothing runs on your machine until you **approve it from your phone**.

```
   📱 phone  ──prompt──▶  ☁️ relay (blind)  ──prompt──▶  💻 Claude Code (your laptop)
       ▲                                                       │
       └──────────────── encrypted events ─────────────────────┘
```

- 🔒 **End-to-end encrypted** (AES-256-GCM). The relay only ever sees ciphertext —
  the key rides in the QR link's URL fragment and never touches the server.
- ✋ **Approve from your phone.** Before Claude runs Bash / edits / writes a file,
  you get an Approve / Deny card. It blocks until you tap.
- 🔔 **Push notifications.** Your phone buzzes for approvals (and when a task
  finishes) — even with the app closed. Web Push payloads are encrypted to your
  browser, so push providers can't read them.
- 📷 **Scan to connect.** No room codes to type.
- 📲 **Installable.** Add the page to your home screen — it behaves like a real app.
- ♻️ **Auto-reconnect.** Survives the relay sleeping or a flaky connection.

> Not affiliated with Anthropic.

---

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org) 18+ and
[Claude Code](https://docs.claude.com/claude-code) installed and logged in on the
computer you want to control.

On that computer, run:

```bash
npx pocketcode
```

It prints a **QR code**. Scan it with your phone's camera — the PocketCode page
opens, already connected and encrypted. Type a prompt and go.

When Claude wants to run a command or change a file, your phone shows a
**✋ Approve / Deny** card. Approve it and watch it happen.

---

## How it works

Three parts:

- **cli/pocketcode.js** — the *host*. Runs on your computer, wraps Claude Code in
  headless streaming mode (`claude -p --output-format stream-json`), generates a
  per-session encryption key, and runs a tiny local broker for approvals.
- **cli/approve-hook.js** — a Claude Code `PreToolUse` hook. Before a guarded tool
  runs, it asks the broker (which asks your phone) and allows/denies accordingly.
  Fails safe: denies on any error or timeout.
- **relay/server.js** — a "blind" WebSocket forwarder that pairs your laptop and
  phone by room code. It also serves the phone-facing viewer page. It can't read
  your messages.
- **web/index.html** — the viewer (a PWA). Decrypts events, sends prompts, shows
  approval cards.

### Encryption

A fresh 256-bit AES key is generated per run and embedded in the QR link's
`#fragment` (fragments are never sent to a server). Every prompt and event is
encrypted as `iv(12) || ciphertext || authTag(16)` and wrapped as
`{type:"enc", data}`; the relay forwards these opaque blobs. The host uses Node's
`crypto`; the viewer uses the browser's Web Crypto — wire-compatible.

### Approvals

Guarded tools (`Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`) trigger a
`PreToolUse` hook wired via `--settings`. Read-only tools (Read/Glob/Grep) run
without prompting. No answer within 120s → auto-deny.

---

## Configuration

Environment variables (all optional):

| Var | Default | Purpose |
|-----|---------|---------|
| `RELAY_URL` | `wss://pocketcode-relay.onrender.com` | Relay to connect through |
| `ROOM` | random 6-char code | Fixed room code |
| `VIEWER_URL` | derived from `RELAY_URL` | Override the link shown in the QR |

n### Run your own relay

```bash
git clone https://github.com/aqsa-svg/pocketcode-app
cd pocketcode-app && npm install
npm run relay        # listens on :8080 (or $PORT), serves the viewer at /
```

Then point the host at it:

```bash
RELAY_URL=wss://your-relay.example.com npx pocketcode
```

A `render.yaml` is included for one-click deploy to Render's free tier.

---

## Security notes

- The relay is a blind forwarder, but **anyone with the QR link (room + key) can
  drive your session** — treat the link like a password.
- Approvals are enforced by Claude Code's hook system; the host fails safe (deny).
- The viewer needs a secure context (`https://` or `localhost`) for Web Crypto.
- **Notifications:** Android Chrome works out of the box. On iPhone you must first
  **Add to Home Screen** and open it from there (iOS 16.4+ only supports Web Push
  for installed PWAs). If push isn't available, everything else still works.

---

MIT © aqsa-svg
