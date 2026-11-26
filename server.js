// Setup: npm install   then   npm start   and open http://localhost:8080
"use strict";

const crypto = require("crypto");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

// ---------- Configuration (override with environment variables) ----------
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "127.0.0.1"; // localhost only by default
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  `http://localhost:${PORT},http://127.0.0.1:${PORT}`
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const ANNOUNCEMENT = process.env.ANNOUNCEMENT || "Only 5hr class left";

const MAX_MESSAGE_LENGTH = 500;
const HISTORY_SIZE = 50;
const MAX_CONNECTIONS_PER_IP = 5;
const MSG_LIMIT = { max: 8, windowMs: 10_000 }; // 8 messages / 10 s
const TYPING_LIMIT = { max: 1, windowMs: 1_500 };
const MAX_VIOLATIONS = 10;

// ---------- HTTP server ----------
const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.use(express.static(path.join(__dirname, "public"), { dotfiles: "ignore" }));

const httpserver = http.createServer(app);

// ---------- Socket.IO ----------
const io = new Server(httpserver, {
  transports: ["websocket"],
  maxHttpBufferSize: 4 * 1024, // reject oversized payloads
  // Only accept connections that come from a page we serve (blocks cross-site hijacking)
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    callback(null, Boolean(origin) && ALLOWED_ORIGINS.includes(origin));
  },
});

const rooms = new Map(); // code -> { users: Map(lowercase name -> socket.id), history: [], emptySince }
const ipCounts = new Map(); // ip -> open connections
const ipFails = new Map(); // ip -> timestamps of failed room/name attempts

const ROOM_CAPACITY = Number(process.env.ROOM_CAPACITY) || 10; // set 2 for strict pairs
const ROOM_EMPTY_TTL = 2 * 60_000; // an empty room is deleted after 2 minutes
const FAIL_LIMIT = { max: 10, windowMs: 60_000 };
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,18}[\p{L}\p{N}]$/u; // 2-20 chars
// control chars, zero-width and bidi-override characters (used for spoofing)
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function cleanName(raw) {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return NAME_RE.test(name) ? name : null;
}

function cleanRoom(raw) {
  if (typeof raw !== "string" || raw.length > 20) return null;
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  return CODE_RE.test(code) ? code : null;
}

function newRoomCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function cleanText(raw) {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH * 2) return null;
  const text = raw
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text || text.length > MAX_MESSAGE_LENGTH) return null;
  return text;
}

function allow(socket, key, { max, windowMs }) {
  const now = Date.now();
  const bucket = (socket.data.rate[key] ||= []);
  while (bucket.length && now - bucket[0] > windowMs) bucket.shift();
  if (bucket.length >= max) {
    if (++socket.data.violations >= MAX_VIOLATIONS) socket.disconnect(true);
    return false;
  }
  bucket.push(now);
  return true;
}

// Failed room-code guesses are throttled per IP so codes can't be brute-forced.
function recentFails(ip) {
  const now = Date.now();
  const list = (ipFails.get(ip) || []).filter((t) => now - t < FAIL_LIMIT.windowMs);
  ipFails.set(ip, list);
  return list;
}
function fail(ip, code, next) {
  recentFails(ip).push(Date.now());
  return next(new Error(code));
}

// Runs before the connection is established: validates name and room.
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const auth = socket.handshake.auth || {};
  if ((ipCounts.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) return next(new Error("TOO_MANY_CONNECTIONS"));
  if (recentFails(ip).length >= FAIL_LIMIT.max) return next(new Error("TOO_MANY_ATTEMPTS"));

  const name = cleanName(auth.name);
  if (!name) return next(new Error("NAME_INVALID"));

  let code;
  if (auth.create === true) {
    code = newRoomCode(); // the server picks the code, never the client
  } else {
    code = cleanRoom(auth.room);
    if (!code) return fail(ip, "ROOM_INVALID", next);
    const room = rooms.get(code);
    if (!room) return fail(ip, "ROOM_NOT_FOUND", next);
    if (room.users.size >= ROOM_CAPACITY) return next(new Error("ROOM_FULL"));
    if (room.users.has(name.toLowerCase())) return next(new Error("NAME_TAKEN"));
  }
  socket.data = { name, ip, code, rate: {}, violations: 0 };
  next();
});

io.on("connection", (socket) => {
  const { name, ip, code } = socket.data;
  const key = name.toLowerCase();

  let room = rooms.get(code);
  if (!room) {
    room = { users: new Map(), history: [], emptySince: null };
    rooms.set(code, room);
  }
  if (room.users.has(key) || room.users.size >= ROOM_CAPACITY) return socket.disconnect(true);
  room.users.set(key, socket.id);
  room.emptySince = null;
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  socket.join(code); // messages are only sent to sockets in the same room
  console.log(`Room ${code}: ${room.users.size} active`);

  socket.emit("room", { code, capacity: ROOM_CAPACITY });
  socket.emit("history", room.history);
  socket.emit("announce", ANNOUNCEMENT);
  socket.to(code).emit("join", { user: name, ts: Date.now() });
  io.to(code).emit("active", room.users.size);

  // client -> server: a chat message. The optional ack tells the sender if it worked.
  socket.on("msg", (text, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!allow(socket, "msg", MSG_LIMIT)) {
      return reply({ ok: false, error: "You're sending messages too fast. Wait a moment." });
    }
    const clean = cleanText(text);
    if (!clean) {
      return reply({ ok: false, error: `Messages must be 1-${MAX_MESSAGE_LENGTH} characters.` });
    }
    // The server decides sender, id and time, so clients can't spoof them.
    const message = { id: crypto.randomUUID(), user: name, text: clean, ts: Date.now() };
    room.history.push(message);
    if (room.history.length > HISTORY_SIZE) room.history.shift();
    io.to(code).emit("chat", message);
    reply({ ok: true });
  });

  socket.on("typing", () => {
    if (allow(socket, "typing", TYPING_LIMIT)) socket.to(code).emit("typing", { user: name });
  });

  socket.on("disconnect", () => {
    if (room.users.get(key) === socket.id) room.users.delete(key);
    if (room.users.size === 0) room.emptySince = Date.now();
    const left = (ipCounts.get(ip) || 1) - 1;
    if (left <= 0) ipCounts.delete(ip);
    else ipCounts.set(ip, left);
    socket.to(code).emit("leave", { user: name, ts: Date.now() });
    io.to(code).emit("active", room.users.size);
    console.log(`Room ${code}: ${room.users.size} active`);
  });
});

// Remove rooms (and their history) that have been empty for a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.users.size === 0 && room.emptySince && now - room.emptySince > ROOM_EMPTY_TTL) {
      rooms.delete(code);
    }
  }
}, 30_000).unref();

httpserver.listen(PORT, HOST, () => {
  console.log(`Server started at http://${HOST}:${PORT}`);
});
