import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e6
});

const rooms = new Map();
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
const cloudflareTurnCache = {
  iceServers: null,
  expiresAt: 0
};

app.use(express.json({ limit: "12mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createHostKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function serializeParticipant(participant) {
  return {
    id: participant.id,
    username: participant.username,
    isOwner: participant.isOwner,
    joinedAt: participant.joinedAt
  };
}

function ensureRoom(roomId) {
  return rooms.get(roomId) || null;
}

function getParticipants(room) {
  return Array.from(room.participants.values()).map(serializeParticipant);
}

function getPresenceState(room) {
  return {
    ownerId: room.ownerId,
    controllerId: room.controllerId,
    controlRequests: room.controlRequests,
    participants: getParticipants(room).map((item) => ({
      ...item,
      isOwner: item.id === room.ownerId
    }))
  };
}

function syncSocketRoomOwner(socket, room) {
  const matchesHostKey = Boolean(
    room.ownerKey &&
      socket.data.hostKey &&
      room.ownerKey === socket.data.hostKey
  );
  const matchesOwnerName = Boolean(
    room.ownerName &&
      socket.data.username &&
      room.ownerName === socket.data.username
  );

  if (!matchesHostKey && !matchesOwnerName) {
    return {
      isOwner: Boolean(room.ownerId && room.ownerId === socket.id),
      changed: false
    };
  }

  const changed = room.ownerId !== socket.id;
  room.ownerId = socket.id;

  room.participants.forEach((participant, participantId) => {
    participant.isOwner = participantId === socket.id;
  });

  const currentParticipant = room.participants.get(socket.id);
  if (currentParticipant?.username) {
    room.ownerName = currentParticipant.username;
  }

  return {
    isOwner: true,
    changed
  };
}

function isSocketRoomOwner(socket, room) {
  return syncSocketRoomOwner(socket, room).isOwner;
}

function reclaimRoomOwner(socket, roomId, username, hostKey) {
  const room = ensureRoom(roomId);
  if (!room) {
    return { ok: false, reason: "room-not-found" };
  }

  const cleanName = String(username || socket.data.username || "Guest").trim().slice(0, 32) || "Guest";
  const normalizedHostKey = String(hostKey || socket.data.hostKey || "").trim() || null;

  socket.data.roomId = roomId;
  socket.data.username = cleanName;
  socket.data.hostKey = normalizedHostKey;

  const canReclaim =
    Boolean(room.ownerKey && normalizedHostKey && room.ownerKey === normalizedHostKey) ||
    Boolean(room.ownerName && room.ownerName === cleanName);

  if (!canReclaim) {
    return { ok: false, reason: "not-authorized" };
  }

  const participant = room.participants.get(socket.id);
  if (participant) {
    participant.username = cleanName;
  }

  const ownerSync = syncSocketRoomOwner(socket, room);
  return {
    ok: ownerSync.isOwner,
    room,
    changed: ownerSync.changed
  };
}

function getStaticIceServers() {
  const urls = String(process.env.TURN_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!urls.length) {
    return DEFAULT_ICE_SERVERS;
  }

  const turnServer = {
    urls
  };

  if (process.env.TURN_USERNAME) {
    turnServer.username = process.env.TURN_USERNAME;
  }

  if (process.env.TURN_CREDENTIAL) {
    turnServer.credential = process.env.TURN_CREDENTIAL;
  }

  return [...DEFAULT_ICE_SERVERS, turnServer];
}

async function getCloudflareIceServers() {
  const keyId = String(process.env.CLOUDFLARE_TURN_KEY_ID || "").trim();
  const apiToken = String(process.env.CLOUDFLARE_TURN_TOKEN || "").trim();
  const ttl = Math.max(60, Math.min(Number(process.env.CLOUDFLARE_TURN_TTL || 3600), 86400));

  if (!keyId || !apiToken) {
    return null;
  }

  const now = Date.now();
  if (cloudflareTurnCache.iceServers && cloudflareTurnCache.expiresAt - now > 60_000) {
    return cloudflareTurnCache.iceServers;
  }

  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ttl })
  });

  if (!response.ok) {
    throw new Error(`Cloudflare TURN request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const iceServers = Array.isArray(payload?.iceServers) ? payload.iceServers : null;
  if (!iceServers?.length) {
    throw new Error("Cloudflare TURN response did not include iceServers.");
  }

  cloudflareTurnCache.iceServers = [...DEFAULT_ICE_SERVERS, ...iceServers];
  cloudflareTurnCache.expiresAt = now + ttl * 1000;
  return cloudflareTurnCache.iceServers;
}

async function getIceServers() {
  try {
    const cloudflareIceServers = await getCloudflareIceServers();
    if (cloudflareIceServers?.length) {
      return cloudflareIceServers;
    }
  } catch (error) {
    console.warn("Cloudflare TURN config unavailable:", error.message);
  }

  return getStaticIceServers();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", async (_req, res) => {
  res.json({
    iceServers: await getIceServers()
  });
});

app.post("/api/rooms", (_req, res) => {
  let roomId = createRoomId();
  while (rooms.has(roomId)) {
    roomId = createRoomId();
  }

  rooms.set(roomId, {
    id: roomId,
    ownerId: null,
    ownerKey: createHostKey(),
    ownerName: null,
    controllerId: null,
    controlRequests: [],
    participants: new Map(),
    chat: [],
    browserState: {
      url: "",
      query: "",
      status: "idle",
      updatedAt: Date.now(),
      frame: null,
      title: "Room browser",
      aspectRatio: 16 / 9
    }
  });

  res.json({ roomId, hostKey: rooms.get(roomId).ownerKey });
});

app.get("/api/rooms/:roomId/control", (req, res) => {
  const room = ensureRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return;
  }

  res.json({
    ownerId: room.ownerId,
    controllerId: room.controllerId,
    controlRequests: room.controlRequests
  });
});

app.post("/api/rooms/:roomId/control/request", (req, res) => {
  const room = ensureRoom(req.params.roomId);
  const { participantId } = req.body || {};
  if (!room) {
    res.status(404).json({ ok: false, reason: "room-not-found" });
    return;
  }
  if (!participantId) {
    res.status(400).json({ ok: false, reason: "missing-participant-id" });
    return;
  }
  if (!room.participants.has(participantId)) {
    res.status(400).json({ ok: false, reason: "participant-not-in-room" });
    return;
  }
  if (room.ownerId === participantId) {
    res.status(400).json({ ok: false, reason: "owner-cannot-request" });
    return;
  }

  if (!room.controlRequests.includes(participantId) && room.controllerId !== participantId) {
    room.controlRequests.push(participantId);
  }

  io.to(room.id).emit("browser-control-state", {
    controllerId: room.controllerId,
    controlRequests: room.controlRequests
  });

  res.json({
    ok: true,
    controllerId: room.controllerId,
    controlRequests: room.controlRequests
  });
});

app.post("/api/rooms/:roomId/control/approve", (req, res) => {
  const room = ensureRoom(req.params.roomId);
  const { ownerId, requesterId } = req.body || {};
  if (!room) {
    res.status(404).json({ ok: false, reason: "room-not-found" });
    return;
  }
  if (room.ownerId !== ownerId) {
    res.status(400).json({ ok: false, reason: "owner-mismatch" });
    return;
  }
  if (!requesterId) {
    res.status(400).json({ ok: false, reason: "missing-requester-id" });
    return;
  }
  if (!room.participants.has(requesterId)) {
    res.status(400).json({ ok: false, reason: "requester-not-in-room" });
    return;
  }

  room.controllerId = requesterId;
  room.controlRequests = room.controlRequests.filter((id) => id !== requesterId);

  io.to(room.id).emit("browser-control-state", {
    controllerId: room.controllerId,
    controlRequests: room.controlRequests
  });

  res.json({
    ok: true,
    controllerId: room.controllerId,
    controlRequests: room.controlRequests
  });
});

app.post("/api/rooms/:roomId/control/release", (req, res) => {
  const room = ensureRoom(req.params.roomId);
  const { participantId } = req.body || {};
  if (!room) {
    res.status(404).json({ ok: false, reason: "room-not-found" });
    return;
  }
  if (!participantId) {
    res.status(400).json({ ok: false, reason: "missing-participant-id" });
    return;
  }
  if (room.ownerId !== participantId && room.controllerId !== participantId) {
    res.status(400).json({ ok: false, reason: "participant-cannot-release" });
    return;
  }

  if (room.controllerId === participantId || room.ownerId === participantId) {
    room.controllerId = null;
  }
  room.controlRequests = room.controlRequests.filter((id) => id !== participantId);

  io.to(room.id).emit("browser-control-state", {
    controllerId: room.controllerId,
    controlRequests: room.controlRequests
  });

  res.json({
    ok: true,
    controllerId: room.controllerId,
    controlRequests: room.controlRequests
  });
});

app.get("/api/rooms/:roomId/frame", (req, res) => {
  const room = ensureRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return;
  }

  res.json(room.browserState);
});

app.post("/api/rooms/:roomId/frame", (req, res) => {
  const room = ensureRoom(req.params.roomId);
  const { frame, url, title, aspectRatio } = req.body || {};

  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return;
  }

  room.browserState = {
    ...room.browserState,
    url: url || room.browserState.url,
    title: title || room.browserState.title,
    status: "desktop-stream",
    frame: frame || room.browserState.frame,
    aspectRatio: aspectRatio || room.browserState.aspectRatio,
    updatedAt: Date.now()
  };

  io.to(room.id).emit("browser-update", {
    ...room.browserState,
    frame: null
  });

  res.json({
    ok: true,
    updatedAt: room.browserState.updatedAt
  });
});

const clientDistDir = path.join(rootDir, "dist");
app.use(express.static(clientDistDir));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) {
    next();
    return;
  }

  res.sendFile(path.join(clientDistDir, "index.html"), (error) => {
    if (error) {
      res.status(404).json({
        error: "Frontend build not found. Run `npm install` and `npm run client` for development."
      });
    }
  });
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, username, hostKey }) => {
    const room = ensureRoom(roomId);
    if (!room) {
      socket.emit("room-error", { message: "Room not found." });
      return;
    }

    const cleanName = String(username || "Guest").trim().slice(0, 32) || "Guest";
    const normalizedHostKey = String(hostKey || "").trim() || null;
    socket.data.roomId = roomId;
    socket.data.hostKey = normalizedHostKey;
    socket.data.username = cleanName;
    const isHostJoin =
      Boolean(room.ownerKey && normalizedHostKey && room.ownerKey === normalizedHostKey) ||
      Boolean(room.ownerName && room.ownerName === cleanName);
    const isFirstParticipant = room.participants.size === 0 && !room.ownerId;
    const shouldOwnRoom = isHostJoin || isFirstParticipant;
    const participant = {
      id: socket.id,
      username: cleanName,
      isOwner: shouldOwnRoom,
      joinedAt: Date.now()
    };

    room.participants.set(socket.id, participant);
    if (shouldOwnRoom) {
      room.ownerId = socket.id;
      room.ownerName = cleanName;
    }

    socket.join(roomId);
    const ownerSync = syncSocketRoomOwner(socket, room);

    socket.emit("room-state", {
      roomId,
      ownerId: room.ownerId,
      ownerKey: ownerSync.isOwner ? room.ownerKey : null,
      controllerId: room.controllerId,
      controlRequests: room.controlRequests,
      participants: getParticipants(room),
      browserState: room.browserState,
      chat: room.chat,
      hostReclaimed: isHostJoin || ownerSync.changed
    });

    socket.to(roomId).emit("participant-joined", {
      participant: serializeParticipant(participant)
    });

    io.to(roomId).emit("presence-update", getPresenceState(room));
  });

  socket.on("reclaim-room-owner", ({ roomId, username, hostKey }, ack) => {
    const result = reclaimRoomOwner(socket, roomId, username, hostKey);
    if (!result.ok || !result.room) {
      ack?.(result);
      return;
    }

    socket.emit("room-state", {
      roomId,
      ownerId: result.room.ownerId,
      ownerKey: result.room.ownerKey,
      controllerId: result.room.controllerId,
      controlRequests: result.room.controlRequests,
      participants: getParticipants(result.room),
      browserState: result.room.browserState,
      chat: result.room.chat,
      hostReclaimed: true
    });

    io.to(roomId).emit("presence-update", getPresenceState(result.room));
    ack?.({ ok: true, changed: result.changed, ownerId: result.room.ownerId });
  });

  socket.on("chat-message", ({ roomId, text }) => {
    const room = ensureRoom(roomId);
    if (!room || !room.participants.has(socket.id)) {
      return;
    }

    const trimmed = String(text || "").trim();
    if (!trimmed) {
      return;
    }

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: socket.id,
      senderName: room.participants.get(socket.id).username,
      text: trimmed.slice(0, 500),
      createdAt: Date.now()
    };

    room.chat.push(message);
    room.chat = room.chat.slice(-100);
    io.to(roomId).emit("chat-message", message);
  });

  socket.on("browser-update", ({ roomId, url, query, status, aspectRatio }, ack) => {
    const room = ensureRoom(roomId);
    if (!room) {
      ack?.({ ok: false });
      return;
    }
    const ownerSync = syncSocketRoomOwner(socket, room);
    if (!ownerSync.isOwner) {
      ack?.({ ok: false });
      return;
    }
    if (ownerSync.changed) {
      io.to(roomId).emit("presence-update", getPresenceState(room));
    }

    room.browserState = {
      ...room.browserState,
      url,
      query,
      status: status || "ready",
      aspectRatio: aspectRatio || room.browserState.aspectRatio,
      updatedAt: Date.now()
    };

    io.to(roomId).emit("browser-update", room.browserState);
    ack?.({ ok: true, updatedAt: room.browserState.updatedAt });
  });

  socket.on("browser-frame", ({ roomId, frame, url, title, aspectRatio }, ack) => {
    const room = ensureRoom(roomId);
    if (!room) {
      socket.emit("browser-frame-reject", { reason: "room-not-found", roomId });
      ack?.({ ok: false, reason: "room-not-found" });
      return;
    }
    const ownerSync = syncSocketRoomOwner(socket, room);
    if (!ownerSync.isOwner) {
      socket.emit("browser-frame-reject", {
        reason: "not-owner",
        roomId,
        ownerId: room.ownerId,
        socketId: socket.id
      });
      ack?.({ ok: false, reason: "not-owner" });
      return;
    }
    if (ownerSync.changed) {
      io.to(roomId).emit("presence-update", getPresenceState(room));
    }
    if (!frame) {
      socket.emit("browser-frame-reject", { reason: "missing-frame", roomId });
      ack?.({ ok: false, reason: "missing-frame" });
      return;
    }

    room.browserState = {
      ...room.browserState,
      url: url || room.browserState.url,
      title: title || room.browserState.title,
      status: "desktop-stream",
      frame,
      aspectRatio: aspectRatio || room.browserState.aspectRatio,
      updatedAt: Date.now()
    };

    io.to(roomId).emit("browser-frame", room.browserState);
    ack?.({ ok: true, updatedAt: room.browserState.updatedAt });
  });

  socket.on("browser-frame-debug", ({ roomId, size, sentAt }, ack) => {
    const room = ensureRoom(roomId);
    if (!room) {
      socket.emit("browser-frame-reject", { reason: "debug-room-not-found", roomId });
      ack?.({ ok: false, reason: "debug-room-not-found" });
      return;
    }
    const ownerSync = syncSocketRoomOwner(socket, room);
    if (!ownerSync.isOwner) {
      socket.emit("browser-frame-reject", {
        reason: "debug-not-owner",
        roomId,
        ownerId: room.ownerId,
        socketId: socket.id
      });
      ack?.({ ok: false, reason: "debug-not-owner" });
      return;
    }
    if (ownerSync.changed) {
      io.to(roomId).emit("presence-update", getPresenceState(room));
    }

    const payload = {
      roomId,
      ownerId: socket.id,
      size,
      sentAt,
      receivedAt: Date.now()
    };
    socket.emit("browser-frame-debug", payload);
    ack?.({ ok: true, ...payload });
  });

  socket.on("webrtc-signal", ({ roomId, targetId, signal }) => {
    const room = ensureRoom(roomId);
    if (!room || !room.participants.has(socket.id) || !room.participants.has(targetId)) {
      return;
    }

    io.to(targetId).emit("webrtc-signal", {
      roomId,
      senderId: socket.id,
      signal
    });
  });

  socket.on("browser-quality-request", ({ roomId, quality }) => {
    const room = ensureRoom(roomId);
    if (!room || !room.participants.has(socket.id) || !room.ownerId || isSocketRoomOwner(socket, room)) {
      return;
    }

    io.to(room.ownerId).emit("browser-quality-request", {
      requesterId: socket.id,
      quality
    });
  });

  socket.on("request-browser-control", ({ roomId }, ack) => {
    const room = ensureRoom(roomId);
    if (!room || !room.participants.has(socket.id) || isSocketRoomOwner(socket, room)) {
      ack?.({ ok: false });
      return;
    }

    if (!room.controlRequests.includes(socket.id) && room.controllerId !== socket.id) {
      room.controlRequests.push(socket.id);
    }

    io.to(roomId).emit("browser-control-state", {
      controllerId: room.controllerId,
      controlRequests: room.controlRequests
    });
    ack?.({ ok: true, controlRequests: room.controlRequests, controllerId: room.controllerId });
  });

  socket.on("approve-browser-control", ({ roomId, requesterId }, ack) => {
    const room = ensureRoom(roomId);
    if (!room || !isSocketRoomOwner(socket, room) || !room.participants.has(requesterId)) {
      ack?.({ ok: false });
      return;
    }

    room.controllerId = requesterId;
    room.controlRequests = room.controlRequests.filter((id) => id !== requesterId);

    io.to(roomId).emit("browser-control-state", {
      controllerId: room.controllerId,
      controlRequests: room.controlRequests
    });
    ack?.({ ok: true, controllerId: room.controllerId, controlRequests: room.controlRequests });
  });

  socket.on("deny-browser-control", ({ roomId, requesterId }, ack) => {
    const room = ensureRoom(roomId);
    if (!room) {
      ack?.({ ok: false, reason: "room-not-found" });
      return;
    }
    if (!isSocketRoomOwner(socket, room)) {
      ack?.({ ok: false, reason: "owner-mismatch" });
      return;
    }

    room.controlRequests = room.controlRequests.filter((id) => id !== requesterId);

    io.to(roomId).emit("browser-control-state", {
      controllerId: room.controllerId,
      controlRequests: room.controlRequests
    });
    ack?.({ ok: true, controllerId: room.controllerId, controlRequests: room.controlRequests });
  });

  socket.on("release-browser-control", ({ roomId }, ack) => {
    const room = ensureRoom(roomId);
    if (!room || (!isSocketRoomOwner(socket, room) && room.controllerId !== socket.id)) {
      ack?.({ ok: false });
      return;
    }

    if (room.controllerId === socket.id || isSocketRoomOwner(socket, room)) {
      room.controllerId = null;
    }

    room.controlRequests = room.controlRequests.filter((id) => id !== socket.id);

    io.to(roomId).emit("browser-control-state", {
      controllerId: room.controllerId,
      controlRequests: room.controlRequests
    });
    ack?.({ ok: true, controllerId: room.controllerId, controlRequests: room.controlRequests });
  });

  socket.on("browser-command", ({ roomId, command, payload }) => {
    const room = ensureRoom(roomId);
    if (!room || !room.participants.has(socket.id)) {
      return;
    }

    const allowed = isSocketRoomOwner(socket, room) || socket.id === room.controllerId;
    if (!allowed || !room.ownerId) {
      return;
    }

    io.to(room.ownerId).emit("browser-command", {
      senderId: socket.id,
      command,
      payload
    });
  });

  socket.on("disconnect", () => {
    const { roomId } = socket.data;
    if (!roomId) {
      return;
    }

    const room = ensureRoom(roomId);
    if (!room || !room.participants.has(socket.id)) {
      return;
    }

    const leavingParticipant = room.participants.get(socket.id);
    room.participants.delete(socket.id);

    if (room.ownerId === socket.id) {
      room.ownerId = null;
    }

    room.controlRequests = room.controlRequests.filter((id) => id !== socket.id);
    if (room.controllerId === socket.id) {
      room.controllerId = null;
    }

    io.to(roomId).emit("participant-left", {
      participantId: socket.id,
      participantName: leavingParticipant.username
    });

    io.to(roomId).emit("presence-update", getPresenceState(room));

    if (room.participants.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const port = Number(process.env.PORT || 3001);
server.listen(port, () => {
  console.log(`Watch party server listening on http://localhost:${port}`);
});
