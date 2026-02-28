import fs from "fs";
import http from "http";
import https from "https";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { SessionRegistry } from "./sessionRegistry";

const PORT = parseInt(process.env.PORT || "3000", 10);
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const DISCOVERY_ENABLED = process.env.DISCOVERY_ENABLED?.toLowerCase() !== "false";
const registry = new SessionRegistry();

const app = express();
app.use(express.json());

// CORS
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options("/{*path}", (_req, res) => { res.sendStatus(204); });

// POST /api/sessions - Register a new session
app.post("/api/sessions", (req, res) => {
  const { name, workspace, requiresPassphrase } = req.body;
  if (!name || !workspace) {
    res.status(400).json({ error: "name and workspace are required" });
    return;
  }
  const session = registry.createSession(name, workspace, !!requiresPassphrase);
  res.status(201).json(session);
});

// GET /api/sessions - List active sessions
app.get("/api/sessions", (_req, res) => {
  if (!DISCOVERY_ENABLED) {
    res.status(403).json({ error: "Session discovery is disabled" });
    return;
  }
  const sessions = registry.listSessions();
  res.json({ sessions });
});

// DELETE /api/sessions/:code - Remove a session
app.delete("/api/sessions/:code", (req, res) => {
  registry.removeSession(req.params.code);
  res.sendStatus(204);
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

let httpServer: http.Server | https.Server;
if (TLS_CERT_PATH && TLS_KEY_PATH) {
  const cert = fs.readFileSync(TLS_CERT_PATH, "utf-8");
  const key = fs.readFileSync(TLS_KEY_PATH, "utf-8");
  httpServer = https.createServer({ cert, key }, app);
} else {
  httpServer = http.createServer(app);
}

// WebSocket server for relay channels
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket: WebSocket, req) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // Expected paths: /relay/:code/main or /relay/:code/sharedb
  const parts = url.pathname.split("/").filter(Boolean);
  // parts: ["relay", code, "main"|"sharedb"]

  if (parts.length !== 3 || parts[0] !== "relay") {
    socket.close(4000, "Invalid relay path");
    return;
  }

  const code = parts[1];
  const channelName = parts[2];
  const role = url.searchParams.get("role");

  if (channelName !== "main" && channelName !== "sharedb") {
    socket.close(4001, "Invalid channel name");
    return;
  }

  if (role !== "host" && role !== "client") {
    socket.close(4002, "Invalid role (must be host or client)");
    return;
  }

  const session = registry.getSession(code);
  if (!session) {
    socket.close(4004, "Session not found");
    return;
  }

  const success = registry.setSocket(code, channelName, role, socket);
  if (!success) {
    socket.close(4003, `${role} already connected to ${channelName} channel`);
    return;
  }

  console.log(`[Relay] ${role} connected to ${code}/${channelName}`);

  socket.on("close", () => {
    console.log(`[Relay] ${role} disconnected from ${code}/${channelName}`);
  });
});

// Start
registry.start();
const protocol = TLS_CERT_PATH && TLS_KEY_PATH ? "HTTPS" : "HTTP";
httpServer.listen(PORT, () => {
  console.log(`[Relay] Server listening on port ${PORT} (${protocol}), discovery ${DISCOVERY_ENABLED ? "enabled" : "disabled"}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[Relay] Shutting down...");
  registry.stop();
  wss.close();
  httpServer.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  registry.stop();
  wss.close();
  httpServer.close(() => process.exit(0));
});
