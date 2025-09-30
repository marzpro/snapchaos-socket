import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { nanoid } from "nanoid";
import { PROMPTS } from "./prompts.js";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // lock this down later to your Vercel domain(s)
    methods: ["GET", "POST"]
  }
});

// In-memory rooms (works because this process is long-lived on Render)
const rooms = new Map();

const ensureRoom = (code) => {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      hostId: null,
      players: new Map(),
      mode: null,
      round: 0,
      prompt: null,
      deadline: null,
      submissions: [],
      votes: new Map(),
      rejections: new Map(),
    });
  }
  return rooms.get(code);
};

const serializeRoom = (room) => ({
  code: room.code,
  hostId: room.hostId,
  players: Array.from(room.players, ([sid, p]) => ({ sid, name: p.name, score: p.score })),
  mode: room.mode,
  round: room.round,
});

const serializeScores = (room) =>
  Array.from(room.players, ([sid, p]) => ({ sid, name: p.name, score: p.score }));

io.on("connection", (socket) => {
  socket.on("create_room", ({ name }, cb) => {
    const code = nanoid(4).toUpperCase();
    const room = ensureRoom(code);
    room.hostId = socket.id;
    room.players.set(socket.id, { name: name || "Host", score: 0 });
    socket.join(code);
    cb && cb({ code });
    io.to(code).emit("room_update", serializeRoom(room));
  });

  socket.on("join_room", ({ code, name }, cb) => {
    const room = ensureRoom(code);
    room.players.set(socket.id, { name: name || "Guest", score: 0 });
    socket.join(code);
    if (!room.hostId) room.hostId = socket.id; // auto-promote first joiner to host if needed
    cb && cb({ ok: true, room: serializeRoom(room) });
    io.to(code).emit("room_update", serializeRoom(room));
  });

  socket.on("start_round", ({ code, mode, durationSec }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    room.mode = mode;
    room.round += 1;
    room.prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    room.deadline = Date.now() + (durationSec || 30) * 1000;
    room.submissions = [];
    room.votes = new Map();
    room.rejections = new Map();
    io.to(code).emit("round_started", {
      round: room.round,
      mode: room.mode,
      prompt: room.prompt,
      deadline: room.deadline,
    });
    cb && cb({ ok: true });
  });

  socket.on("submit_photo", ({ code, dataURL }, cb) => {
    const room = rooms.get(code);
    if (!room) return;
    const already = room.submissions.find((s) => s.sid === socket.id);
    if (!already) room.submissions.push({ sid: socket.id, dataURL });
    else already.dataURL = dataURL;
    io.to(code).emit("submission_update", { count: room.submissions.length });
    cb && cb({ ok: true });
  });

  socket.on("vote_best", ({ code, targetSid }, cb) => {
    const room = rooms.get(code);
    if (!room) return;
    room.votes.set(socket.id, targetSid);
    io.to(code).emit("vote_update", { votes: room.votes.size });
    cb && cb({ ok: true });
  });

  socket.on("flag_lazy", ({ code, targetSid }, cb) => {
    const room = rooms.get(code);
    if (!room) return;
    if (!room.rejections.has(targetSid)) room.rejections.set(targetSid, new Set());
    room.rejections.get(targetSid).add(socket.id);
    io.to(code).emit("rejection_update", { targetSid, count: room.rejections.get(targetSid).size });
    cb && cb({ ok: true });
  });

  socket.on("end_round", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return;
    const totalPlayers = room.players.size;
    const majority = Math.floor(totalPlayers / 2) + 1;
    const submittedSids = new Set(room.submissions.map((s) => s.sid));

    for (const [sid, p] of room.players.entries()) {
      if (!submittedSids.has(sid)) p.score -= 2;
      else p.score += 1;
    }
    for (const [targetSid, voters] of room.rejections.entries()) {
      if (voters.size >= majority) {
        const target = room.players.get(targetSid);
        if (target) target.score -= 2;
      }
    }
    const tally = {};
    for (const [, targetSid] of room.votes.entries()) {
      tally[targetSid] = (tally[targetSid] || 0) + 1;
    }
    const maxVotes = Math.max(0, ...Object.values(tally));
    const winners = Object.keys(tally).filter((sid) => tally[sid] === maxVotes);
    winners.forEach((sid) => {
      const w = room.players.get(sid);
      if (w) w.score += 2;
    });

    io.to(code).emit("round_results", {
      prompt: room.prompt,
      submissions: room.submissions.map((s) => ({ sid: s.sid, dataURL: s.dataURL })),
      votes: tally,
      winners,
      scores: serializeScores(room),
    });
    cb && cb({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.hostId === socket.id) {
          const [nextHost] = room.players.keys();
          room.hostId = nextHost || null;
        }
        io.to(room.code).emit("room_update", serializeRoom(room));
      }
    }
  });
});

app.get("/", (_req, res) => res.send("SnapChaos Socket Server is running"));
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Socket server on :${PORT}`));