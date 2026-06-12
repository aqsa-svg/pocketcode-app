/*
 * PocketCode — Relay Server
 * --------------------------------------------------------------------------
 * A "dumb post office." It forwards messages between the CLI (the "host",
 * running on your computer) and one or more web/mobile "viewers".
 *
 * It groups connections into ROOMS by a short code. The host and the viewer
 * use the SAME room code, so the relay knows who to forward messages to.
 *
 *   viewer  ──prompt──▶  RELAY  ──prompt──▶  host (CLI)
 *   viewer  ◀──events──  RELAY  ◀──events──  host (CLI)
 *
 * MVP NOTE: messages are NOT encrypted yet. That's a later phase. Right now
 * the goal is just to prove the pipe works end-to-end.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const WEB_DIR = path.join(__dirname, "..", "web");
const VIEWER_FILE = path.join(WEB_DIR, "index.html");

// Static files the viewer needs (for the installable PWA + icon).
// Anything not listed here falls through to the viewer page.
const STATIC = {
  "/manifest.json": { file: "manifest.json", type: "application/manifest+json; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml; charset=utf-8" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
};

// A real HTTP server that (a) serves the viewer web app + its assets, and
// (b) answers a health check. WebSocket upgrades are handled separately by
// `wss` below, so normal page loads and the live connection share one port.
const httpServer = http.createServer((req, res) => {
  // strip any query string (e.g. /?room=abc) before matching the path
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  // Serve a known static asset with the right content type.
  const asset = STATIC[urlPath];
  if (asset) {
    fs.readFile(path.join(WEB_DIR, asset.file), (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": asset.type });
      res.end(data);
    });
    return;
  }

  // Everything else → the viewer page.
  fs.readFile(VIEWER_FILE, (err, data) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("PocketCode relay is running ✓\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

// Attach the WebSocket server to that same HTTP server.
const wss = new WebSocketServer({ server: httpServer });

// roomId -> { host: ws|null, viewers: Set<ws> }
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { host: null, viewers: new Set() });
  return rooms.get(id);
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket closed mid-send — ignore */
  }
}

// Tell everyone in a room who's currently online.
function broadcastStatus(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const status = {
    type: "status",
    hostOnline: !!room.host,
    viewers: room.viewers.size,
  };
  if (room.host) send(room.host, status);
  for (const v of room.viewers) send(v, status);
}

wss.on("connection", (ws) => {
  ws.role = null;
  ws.room = null;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }

    // First message must be a "join" to assign a room + role.
    if (msg.type === "join") {
      ws.room = String(msg.room || "").trim();
      ws.role = msg.role === "host" ? "host" : "viewer";
      if (!ws.room) return;

      const room = getRoom(ws.room);
      if (ws.role === "host") room.host = ws;
      else room.viewers.add(ws);

      send(ws, { type: "joined", room: ws.room, role: ws.role });
      broadcastStatus(ws.room);
      console.log(`[join] ${ws.role} -> room ${ws.room}`);
      return;
    }

    if (!ws.room) return;
    const room = getRoom(ws.room);

    // Route: viewer -> host, host -> all viewers.
    if (ws.role === "viewer") {
      if (room.host) send(room.host, msg);
    } else {
      for (const v of room.viewers) send(v, msg);
    }
  });

  ws.on("close", () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.role === "host" && room.host === ws) room.host = null;
    else room.viewers.delete(ws);
    broadcastStatus(ws.room);
    // garbage-collect empty rooms
    if (!room.host && room.viewers.size === 0) rooms.delete(ws.room);
    console.log(`[leave] ${ws.role} <- room ${ws.room}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`PocketCode relay listening on port ${PORT}`);
});
