# PocketCode (MVP) — control Claude Code from your browser/phone

A working **vertical slice** of a Happy-style remote client for Claude Code.
Three parts, all in this folder:

```
  web viewer  ──prompt──▶  relay server  ──prompt──▶  CLI (host)
   (browser)  ◀──events──   (WebSocket)   ◀──events──  wraps Claude Code
```

- **relay/server.js** — forwards messages between the CLI and viewers (rooms by code).
- **cli/pocketcode.js** — runs on your computer, wraps Claude Code, streams its output.
- **web/index.html** — open in a browser, see the session live, send prompts.

> ⚠️ **MVP scope:** messages are **not encrypted yet**, and the relay runs locally.
> Encryption, deployment, and the React Native app are the next phases (see Roadmap).

---

## Run it (3 steps, ~2 minutes)

You'll use **two terminals**, both opened in this folder:
`c:\Users\aqsas\OneDrive\Desktop\pocketcode-app`

### One-time setup
```bash
npm install
```

### Terminal 1 — start the relay
```bash
npm run relay
```
Leave it running. It prints: `PocketCode relay listening on ws://localhost:8080`

### Terminal 2 — start the host (wraps Claude Code)
```bash
npm run host
```
It prints a **room code** (e.g. `a3f9c1`). Leave it running too.

### Browser — open the viewer
1. Open **web/index.html** in your browser (double-click it, or drag it into a tab).
2. Leave **Relay URL** as `ws://localhost:8080`.
3. Type the **room code** from Terminal 2.
4. Click **Connect**, then type a prompt (e.g. *"list the files here"*).

You'll see Claude Code's response stream into the browser in real time. ✅

---

## Test it on your phone (same WiFi)

The viewer is just a web page, so the easiest phone test is to serve it and
point the viewer at your computer's WiFi address instead of `localhost`.

1. Find your PC's WiFi IP (e.g. `192.168.1.13`).
2. Serve the `web/` folder, e.g.: `npx serve web` (gives a `http://192.168.1.13:3000`-style URL).
3. Start the relay with that IP reachable — viewers connect to `ws://192.168.1.13:8080`.
4. On your phone, open the served page, set **Relay URL** to `ws://192.168.1.13:8080`,
   enter the room code, Connect.

(Once we deploy the relay to Render/Railway in the next phase, you won't need WiFi —
it'll work over the internet with a `wss://` URL.)

---

## How the Claude Code integration works

The CLI runs Claude in headless streaming mode:

```bash
claude -p --output-format stream-json --verbose [--resume <session-id>]
```

It writes your prompt to Claude's stdin, reads the newline-delimited JSON events
it emits, and forwards each one to the viewer. It captures the `session_id` from
the first response and passes `--resume <id>` on later prompts so the
conversation stays continuous.

---

## Roadmap (next phases)

1. ✅ **MVP pipe** — relay + CLI + web viewer (this).
2. ⬜ **Encryption** — derive a shared key from a QR/code, encrypt every message
   so the relay only sees ciphertext (libsodium / `crypto_box`).
3. ⬜ **Deploy the relay** — Render or Railway, `wss://`, so it works over the
   internet (no same-WiFi requirement).
4. ⬜ **Permission prompts** — when Claude wants to run a tool, ask for approval
   from the viewer (the "approve from your phone" feature).
5. ⬜ **React Native app** — port the web viewer to a real mobile app (Expo).
6. ⬜ **Reconnection & multi-session** — survive drops, run several sessions.

---

Not affiliated with Anthropic.
