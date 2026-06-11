#!/usr/bin/env node
/*
 * PocketCode — PreToolUse approval hook
 * --------------------------------------------------------------------------
 * Claude Code runs this script (configured via --settings) right before it
 * uses a guarded tool. It receives the tool call as JSON on stdin, asks the
 * local PocketCode broker (which forwards to your phone) for a decision, and
 * prints the permission decision back to Claude.
 *
 * Fails safe: if anything goes wrong (no broker, timeout, bad response) it
 * DENIES, so a tool can never run un-approved because of an error.
 */

const http = require("http");

function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision, // "allow" | "deny"
        permissionDecisionReason: reason || "",
      },
    })
  );
  process.exit(0);
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let info;
  try {
    info = JSON.parse(input);
  } catch {
    info = {};
  }

  const port = process.env.POCKETCODE_BROKER_PORT;
  const token = process.env.POCKETCODE_TOKEN;
  if (!port || !token) return decide("deny", "PocketCode broker not available");

  const payload = JSON.stringify({
    token,
    tool: info.tool_name,
    input: info.tool_input,
    tool_use_id: info.tool_use_id,
  });

  const req = http.request(
    {
      host: "127.0.0.1",
      port: Number(port),
      path: "/ask",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let j;
        try {
          j = JSON.parse(body);
        } catch {
          return decide("deny", "Bad response from PocketCode broker");
        }
        decide(j.decision === "allow" ? "allow" : "deny", j.reason || "");
      });
    }
  );

  // Slightly longer than the broker's own timeout so the broker's default-deny
  // wins first; this is just a backstop.
  req.setTimeout(300000, () => decide("deny", "Approval timed out"));
  req.on("error", () => decide("deny", "Could not reach PocketCode broker"));
  req.write(payload);
  req.end();
});
