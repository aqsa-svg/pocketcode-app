#!/usr/bin/env node
/*
 * PocketCode — CLI (the "host")
 * --------------------------------------------------------------------------
 * Runs on YOUR computer. It:
 *   1. Connects to the relay server and joins a room (a short code).
 *   2. Waits for "prompt" messages coming from the viewer (your browser/phone).
 *   3. For each prompt, runs Claude Code in headless streaming mode and
 *      forwards every event Claude emits back to the viewer in real time.
 *   4. Keeps the conversation going by reusing Claude's session id (--resume).
 *
 * Run it with:   npm run host
 * Override defaults with env vars, e.g.:
 *   RELAY_URL=wss://your-relay.onrender.com ROOM=mycode npm run host
 */

const WebSocket = require("ws");
const { spawn } = require("child_process");
const crypto = require("crypto");

// Defaults to your deployed cloud relay so phones can reach it from anywhere.
// Override for local testing:  RELAY_URL=ws://localhost:8080 npm run host
const RELAY_URL = process.env.RELAY_URL || "wss://pocketcode-relay.onrender.com";
const ROOM = process.env.ROOM || crypto.randomBytes(3).toString("hex"); // 6-char code
// Where to open the viewer. When using the cloud relay it serves the viewer
// itself, so just open the relay URL in a browser / on your phone.
const VIEWER_HINT =
  process.env.VIEWER_URL ||
  (RELAY_URL.startsWith("ws")
    ? RELAY_URL.replace(/^ws/, "http")
    : "web/index.html");

let sessionId = null; // Claude Code session id, for conversation continuity
let busy = false; // don't run two Claude turns at once

const ws = new WebSocket(RELAY_URL);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "join", room: ROOM, role: "host" }));
  console.log("\n  ┌─────────────────────────────────────────────┐");
  console.log("  │   PocketCode CLI connected ✓                  │");
  console.log("  ├─────────────────────────────────────────────┤");
  console.log(`  │   Room code:  ${ROOM.padEnd(32)}│`);
  console.log("  └─────────────────────────────────────────────┘");
  console.log(`\n  Open the viewer (${VIEWER_HINT}),`);
  console.log(`  enter room code "${ROOM}", and start typing.\n`);
  console.log("  Waiting for prompts…\n");
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.type === "prompt") runClaude(msg.text);
  else if (msg.type === "status") {
    console.log(`  [status] viewers online: ${msg.viewers}`);
  }
});

ws.on("close", () => console.log("\n  relay disconnected. Restart to reconnect.\n"));
ws.on("error", (e) => console.error("\n  relay error:", e.message, "\n"));

function forward(event) {
  try {
    ws.send(JSON.stringify({ type: "event", event }));
  } catch {
    /* ignore */
  }
}

function runClaude(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) return;
  if (busy) {
    forward({ type: "busy" });
    return;
  }
  busy = true;

  // echo the prompt back so the viewer shows what was asked
  forward({ type: "user_prompt", text: prompt });
  console.log(`  ▶ prompt: ${prompt}`);

  // Claude Code in headless, streaming-JSON mode.
  // --resume keeps the SAME conversation across prompts.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (sessionId) args.push("--resume", sessionId);

  // shell:true lets Windows resolve claude.exe via PATH.
  const child = spawn("claude", args, { shell: true });

  // send the prompt to Claude via stdin (avoids any arg-quoting issues)
  child.stdin.write(prompt);
  child.stdin.end();

  // Claude emits newline-delimited JSON. Buffer and parse line by line.
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // skip partial/non-JSON lines
      }
      // capture the session id so the next prompt continues the convo
      if (evt.type === "system" && evt.session_id) sessionId = evt.session_id;
      forward(evt);
      process.stdout.write("."); // local heartbeat
    }
  });

  child.stderr.on("data", (d) => forward({ type: "stderr", text: d.toString() }));

  child.on("error", (err) => {
    busy = false;
    forward({ type: "error", text: `Failed to launch Claude Code: ${err.message}` });
    console.error("\n  spawn error:", err.message, "\n");
  });

  child.on("close", (code) => {
    busy = false;
    forward({ type: "turn_complete", code });
    console.log(`\n  ✓ turn complete (exit ${code})\n`);
  });
}
