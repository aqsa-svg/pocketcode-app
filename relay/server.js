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
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

// A real HTTP server so hosts like Render can health-check the service
// (and so you can open the relay URL in a browser to confirm it's alive).
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("PocketCode relay is running ✓\n");
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
