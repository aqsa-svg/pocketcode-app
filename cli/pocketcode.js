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
 * END-TO-END ENCRYPTION:
 *   A fresh 256-bit key is generated on each run and embedded in the QR link
 *   as a URL #fragment (which browsers never send to the server). Every prompt
 *   and event is encrypted with AES-256-GCM before it touches the relay, so the
 *   relay is a "blind" forwarder — it only ever sees ciphertext. Only your
 *   laptop (this CLI) and the phone that scanned the QR hold the key.
 *
 * APPROVE-FROM-PHONE (permissions):
 *   Before Claude runs a sensitive tool (Bash/Edit/Write/…), a PreToolUse hook
 *   fires and asks a tiny local "broker" (HTTP on 127.0.0.1) for a decision.
 *   The broker forwards the request to your phone (encrypted) and BLOCKS until
 *   you tap Approve / Deny. So nothing runs on your machine without your okay.
 *
 * Run it with:   npm run host
 * Override defaults with env vars, e.g.:
 *   RELAY_URL=wss://your-relay.onrender.com ROOM=mycode npm run host
 */

const WebSocket = require("ws");
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const qrcode = require("qrcode-terminal");

// --- End-to-end encryption -------------------------------------------------
// One random key per session. base64url so it's safe inside a URL fragment.
const KEY = crypto.randomBytes(32); // AES-256
const KEY_B64URL = KEY.toString("base64url");

// Wire format for an encrypted blob: iv(12) || ciphertext || authTag(16),
// base64-encoded. This exact layout is what the browser's Web Crypto expects,
// so Node and the browser interoperate without any extra framing.
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// --- Web push notifications -------------------------------------------------
// Lets your phone get a notification (e.g. "approve this command?") even when
// the PocketCode page is closed. The host signs pushes with a per-session VAPID
// key; the Web Push payload is itself encrypted to the browser, so the push
// provider (Google/Apple) can't read it. Optional — if `web-push` isn't
// installed the app still works, just without background notifications.
let webpush = null;
try {
  webpush = require("web-push");
} catch {
  /* optional dependency */
}
let VAPID_PUBLIC = null;
const pushSubs = new Map(); // endpoint -> PushSubscription
if (webpush) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC = keys.publicKey;
  webpush.setVapidDetails("mailto:pocketcode@users.noreply.github.com", keys.publicKey, keys.privateKey);
}

function sendPush(payload) {
  if (!webpush || pushSubs.size === 0) return;
  const body = JSON.stringify(payload);
  for (const [endpoint, sub] of pushSubs) {
    webpush.sendNotification(sub, body).catch((err) => {
      // 404/410 = the subscription is gone; stop trying it.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) pushSubs.delete(endpoint);
    });
  }
}

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

// --- Approve-from-phone -----------------------------------------------------
// Which tools must be approved on the phone before they run. Read-only tools
// (Read/Glob/Grep/…) are allowed automatically by Claude's default mode.
const GUARDED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch"];
const APPROVAL_TIMEOUT_MS = 120000; // auto-deny if the phone never answers

const BROKER_TOKEN = crypto.randomBytes(16).toString("hex"); // local auth
const pendingApprovals = new Map(); // id -> resolve(decision)
let brokerPort = 0;

// The hook script Claude runs for each guarded tool (absolute path, fwd slashes
// so the same string works on Windows and *nix shells).
const HOOK_PATH = path.join(__dirname, "approve-hook.js").replace(/\\/g, "/");
const SETTINGS_FILE = path.join(os.tmpdir(), `pocketcode-hooks-${ROOM}.json`);

function writeSettingsFile() {
  const settings = {
    hooks: {
      PreToolUse: GUARDED_TOOLS.map((tool) => ({
        matcher: tool,
        hooks: [{ type: "command", command: `node "${HOOK_PATH}"`, timeout: 300 }],
      })),
    },
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings));
}

// Local broker: the hook (a separate process Claude spawns) POSTs here; we
// relay the request to the phone and hold the response open until it answers.
const broker = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/ask") {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (j.token !== BROKER_TOKEN) {
      res.writeHead(403);
      res.end();
      return;
    }
    const id = j.tool_use_id || crypto.randomBytes(6).toString("hex");
    let settled = false;
    const respond = (decision, reason) => {
      if (settled) return;
      settled = true;
      pendingApprovals.delete(id);
      try {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision, reason }));
      } catch {
        /* ignore */
      }
    };
    pendingApprovals.set(id, (decision) =>
      respond(decision, decision === "allow" ? "Approved on phone" : "Denied on phone")
    );
    // Ask the phone (encrypted via forward()) + buzz it with a push.
    forward({ type: "approval_request", id, tool: j.tool, input: j.input });
    sendPush({ title: "PocketCode", body: `✋ Approve ${j.tool}?`, tag: `approval-${id}` });
    console.log(`  ✋ approval needed: ${j.tool} — waiting for your phone…`);
    setTimeout(() => respond("deny", "No response from phone (timed out)"), APPROVAL_TIMEOUT_MS);
  });
});
broker.listen(0, "127.0.0.1", () => {
  brokerPort = broker.address().port;
});

const ws = new WebSocket(RELAY_URL);

// The full link that opens the viewer already pointed at this room.
// The key rides in the #fragment, which is NEVER sent to the relay server.
// Scanning the QR (or opening this URL) connects with zero typing.
const CONNECT_URL = `${VIEWER_HINT.replace(/\/$/, "")}/?room=${ROOM}#k=${KEY_B64URL}`;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "join", room: ROOM, role: "host" }));
  console.log("\n  ┌─────────────────────────────────────────────┐");
  console.log("  │   PocketCode CLI connected ✓                  │");
  console.log("  ├─────────────────────────────────────────────┤");
  console.log(`  │   Room code:  ${ROOM.padEnd(32)}│`);
  console.log("  │   🔒 end-to-end encrypted (AES-256-GCM)       │");
  console.log("  │   ✋ approve-from-phone enabled               │");
  if (webpush) console.log("  │   🔔 push notifications ready                 │");
  console.log("  └─────────────────────────────────────────────┘");
  console.log("\n  📷 Scan this with your phone camera to connect instantly:\n");
  qrcode.generate(CONNECT_URL, { small: true });
  console.log(`\n  …or open this link on your phone:\n  ${CONNECT_URL}\n`);
  console.log("  The relay only ever sees ciphertext — your key never leaves this link.");
  console.log("  Waiting for prompts…\n");
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  // Encrypted payloads from the viewer (prompts) arrive wrapped as {type:"enc"}.
  if (msg.type === "enc") {
    let inner;
    try {
      inner = JSON.parse(decrypt(msg.data));
    } catch {
      console.error("  ⚠ failed to decrypt a message (wrong key?)");
      return;
    }
    if (inner.type === "prompt") runClaude(inner.text);
    else if (inner.type === "approval_response") {
      const resolve = pendingApprovals.get(inner.id);
      if (resolve) {
        const decision = inner.decision === "allow" ? "allow" : "deny";
        console.log(`  ${decision === "allow" ? "✓ approved" : "✗ denied"} on phone`);
        resolve(decision);
      }
    } else if (inner.type === "client_hello") {
      // A viewer connected; hand it the VAPID public key so it can subscribe.
      if (VAPID_PUBLIC) forward({ type: "vapid", key: VAPID_PUBLIC });
    } else if (inner.type === "push_subscription" && inner.sub && inner.sub.endpoint) {
      pushSubs.set(inner.sub.endpoint, inner.sub);
      console.log("  🔔 phone subscribed to notifications");
    }
    return;
  }
  // Plaintext relay metadata (not secret).
  if (msg.type === "status") {
    console.log(`  [status] viewers online: ${msg.viewers}`);
  }
});

ws.on("close", () => console.log("\n  relay disconnected. Restart to reconnect.\n"));
ws.on("error", (e) => console.error("\n  relay error:", e.message, "\n"));

function forward(event) {
  try {
    // Encrypt the whole event envelope; the relay forwards it as opaque bytes.
    const data = encrypt(JSON.stringify({ type: "event", event }));
    ws.send(JSON.stringify({ type: "enc", data }));
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
  // --settings wires our PreToolUse approval hook for guarded tools.
  writeSettingsFile();
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    SETTINGS_FILE,
  ];
  if (sessionId) args.push("--resume", sessionId);

  // shell:true lets Windows resolve claude.exe via PATH. The hook reads the
  // broker port + token from these env vars (inherited through Claude).
  const child = spawn("claude", args, {
    shell: true,
    env: {
      ...process.env,
      POCKETCODE_BROKER_PORT: String(brokerPort),
      POCKETCODE_TOKEN: BROKER_TOKEN,
    },
  });

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
    sendPush({ title: "PocketCode", body: "✓ Claude finished your task", tag: "turn-complete" });
    console.log(`\n  ✓ turn complete (exit ${code})\n`);
  });
}
