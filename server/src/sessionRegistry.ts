import { randomInt, randomBytes } from "crypto";
import WebSocket from "ws";

export interface SessionInfo {
  code: string;
  name: string;
  workspace: string;
  requiresPassphrase: boolean;
  createdAt: number;
}

export interface SessionCreateResult {
  info: SessionInfo;
  adminToken: string;
}

export interface SessionRoom {
  info: SessionInfo;
  adminToken: string;
  channels: {
    main: { host?: WebSocket; client?: WebSocket };
    sharedb: { host?: WebSocket; client?: WebSocket };
  };
}

// Exclude ambiguous characters: 0/O, 1/I/L
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  }
  return code;
}

export class SessionRegistry {
  private sessions = new Map<string, SessionRoom>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Close all sessions
    const codes = Array.from(this.sessions.keys());
    for (const code of codes) {
      this.removeSession(code);
    }
  }

  createSession(name: string, workspace: string, requiresPassphrase: boolean): SessionCreateResult {
    let code: string;
    do {
      code = generateCode();
    } while (this.sessions.has(code));

    const adminToken = randomBytes(32).toString("hex");

    const info: SessionInfo = {
      code,
      name,
      workspace,
      requiresPassphrase,
      createdAt: Date.now(),
    };

    this.sessions.set(code, {
      info,
      adminToken,
      channels: {
        main: {},
        sharedb: {},
      },
    });

    return { info, adminToken };
  }

  validateAdminToken(code: string, token: string): boolean {
    const room = this.sessions.get(code);
    if (!room) { return false; }
    return room.adminToken === token;
  }

  getSession(code: string): SessionRoom | undefined {
    return this.sessions.get(code);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((r) => r.info);
  }

  removeSession(code: string): void {
    const room = this.sessions.get(code);
    if (!room) { return; }

    // Close all sockets in the room
    for (const channel of [room.channels.main, room.channels.sharedb]) {
      if (channel.host && channel.host.readyState === WebSocket.OPEN) {
        channel.host.close();
      }
      if (channel.client && channel.client.readyState === WebSocket.OPEN) {
        channel.client.close();
      }
    }

    this.sessions.delete(code);
  }

  setSocket(
    code: string,
    channel: "main" | "sharedb",
    role: "host" | "client",
    socket: WebSocket,
  ): boolean {
    const room = this.sessions.get(code);
    if (!room) { return false; }

    const ch = room.channels[channel];

    // If there's already a socket for this role, reject
    if (ch[role] && ch[role]!.readyState === WebSocket.OPEN) {
      return false;
    }

    ch[role] = socket;

    // Set up forwarding if both sides are connected
    this.setupForwarding(ch);

    // Clean up on close
    socket.on("close", () => {
      if (ch[role] === socket) {
        ch[role] = undefined;
      }

      if (role === "host" && channel === "main") {
        // Hosts main channel disconnected
      }

      if (role === "client") {
        const peer = ch.host;
        if (peer && peer.readyState === WebSocket.OPEN) {
          peer.close();
        }
        ch.host = undefined;
      }
    });

    return true;
  }

  private setupForwarding(channel: { host?: WebSocket; client?: WebSocket }): void {
    const { host, client } = channel;
    if (!host || !client) { return; }
    if (host.readyState !== WebSocket.OPEN || client.readyState !== WebSocket.OPEN) { return; }

    const hostListener = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    };
    const clientListener = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (host.readyState === WebSocket.OPEN) {
        host.send(data, { binary: isBinary });
      }
    };

    host.on("message", hostListener);
    client.on("message", clientListener);

    host.on("close", () => client.removeListener("message", clientListener));
    client.on("close", () => host.removeListener("message", hostListener));
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [code, room] of this.sessions) {
      if (now - room.info.createdAt > this.SESSION_TTL_MS) {
        console.log(`[Relay] Expiring session ${code}`);
        this.removeSession(code);
      }
    }
  }
}
