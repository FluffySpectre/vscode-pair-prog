import fs from "fs";
import http from "http";
import https from "https";
import { WebSocketServer, WebSocket } from "ws";
import { SessionRegistry } from "./sessionRegistry";

const PORT = parseInt(process.env.PORT || "3000", 10);
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const registry = new SessionRegistry();

const requestHandler: http.RequestListener = (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // POST /api/sessions - Register a new session
  if (req.method === "POST" && url.pathname === "/api/sessions") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const { name, workspace, requiresPassphrase } = JSON.parse(body);
        if (!name || !workspace) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "name and workspace are required" }));
          return;
        }
        const session = registry.createSession(name, workspace, !!requiresPassphrase);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  }

  // GET /api/sessions - List active sessions
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const sessions = registry.listSessions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // DELETE /api/sessions/:code - Remove a session
  if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
    const code = url.pathname.split("/")[3];
    if (!code) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session code required" }));
      return;
    }
    registry.removeSession(code);
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
};

let httpServer: http.Server | https.Server;
if (TLS_CERT_PATH && TLS_KEY_PATH) {
  const cert = fs.readFileSync(TLS_CERT_PATH, "utf-8");
  const key = fs.readFileSync(TLS_KEY_PATH, "utf-8");
  httpServer = https.createServer({ cert, key }, requestHandler);
} else {
  httpServer = http.createServer(requestHandler);
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
  console.log(`[Relay] Server listening on port ${PORT} (${protocol})`);
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
