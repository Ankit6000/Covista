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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/rooms", (_req, res) => {
  let roomId = createRoomId();
  while (rooms.has(roomId)) {
    roomId = createRoomId();
  }

  rooms.set(roomId, {
    id: roomId,
    ownerId: null,
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

  res.json({ roomId });
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
  socket.on("join-room", ({ roomId, username }) => {
    const room = ensureRoom(roomId);
    if (!room) {
      socket.emit("room-error", { message: "Room not found." });
      return;
    }

    const cleanName = String(username || "Guest").trim().slice(0, 32) || "Guest";
    const isFirstParticipant = room.participants.size === 0;
    const participant = {
      id: socket.id,
      username: cleanName,
      isOwner: isFirstParticipant,
      joinedAt: Date.now()
    };

    room.participants.set(socket.id, participant);
    if (isFirstParticipant) {
      room.ownerId = socket.id;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit("room-state", {
      roomId,
      ownerId: room.ownerId,
      controllerId: room.controllerId,
      controlRequests: room.controlRequests,
      participants: getParticipants(room),
      browserState: room.browserState,
      chat: room.chat
    });

    socket.to(roomId).emit("participant-joined", {
      participant: serializeParticipant(participant)
    });

    io.to(roomId).emit("presence-update", {
      ownerId: room.ownerId,
      controllerId: room.controllerId,
      controlRequests: room.controlRequests,
      participants: getParticipants(room).map((item) => ({
        ...item,
        isOwner: item.id === room.ownerId
      }))
    });
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
    if (!room || room.ownerId !== socket.id) {
      ack?.({ ok: false });
      return;
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
    if (room.ownerId !== socket.id) {
      socket.emit("browser-frame-reject", {
        reason: "not-owner",
        roomId,
        ownerId: room.ownerId,
        socketId: socket.id
      });
      ack?.({ ok: false, reason: "not-owner" });
      return;
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
    if (room.ownerId !== socket.id) {
      socket.emit("browser-frame-reject", {
        reason: "debug-not-owner",
        roomId,
        ownerId: room.ownerId,
        socketId: socket.id
      });
      ack?.({ ok: false, reason: "debug-not-owner" });
      return;
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
    if (!room || !room.participants.has(socket.id) || !room.ownerId || room.ownerId === socket.id) {
      return;
    }

    io.to(room.ownerId).emit("browser-quality-request", {
      requesterId: socket.id,
      quality
    });
  });

  socket.on("request-browser-control", ({ roomId }, ack) => {
    const room = ensureRoom(roomId);
    if (!room || !room.participants.has(socket.id) || room.ownerId === socket.id) {
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
    if (!room || room.ownerId !== socket.id || !room.participants.has(requesterId)) {
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
    if (room.ownerId !== socket.id) {
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
    if (!room || (room.ownerId !== socket.id && room.controllerId !== socket.id)) {
      ack?.({ ok: false });
      return;
    }

    if (room.controllerId === socket.id || room.ownerId === socket.id) {
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

    const allowed = socket.id === room.ownerId || socket.id === room.controllerId;
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
      const nextOwner = room.participants.values().next().value;
      room.ownerId = nextOwner ? nextOwner.id : null;
      if (nextOwner) {
        nextOwner.isOwner = true;
      }
    }

    room.controlRequests = room.controlRequests.filter((id) => id !== socket.id);
    if (room.controllerId === socket.id) {
      room.controllerId = null;
    }

    io.to(roomId).emit("participant-left", {
      participantId: socket.id,
      participantName: leavingParticipant.username
    });

    io.to(roomId).emit("presence-update", {
      ownerId: room.ownerId,
      controllerId: room.controllerId,
      controlRequests: room.controlRequests,
      participants: getParticipants(room).map((item) => ({
        ...item,
        isOwner: item.id === room.ownerId
      }))
    });

    if (room.participants.size === 0) {
      rooms.delete(roomId);
    }
  });
});

const port = Number(process.env.PORT || 3001);
server.listen(port, () => {
  console.log(`Watch party server listening on http://localhost:${port}`);
});
