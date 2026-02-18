import * as ws from "ws";
import * as os from "os";
import { EventEmitter } from "events";
import {
  Message,
  MessageType,
  HelloPayload,
  serialize,
  deserialize,
  createMessage,
} from "./protocol";

export interface ServerEvents {
  clientConnected: (hello: HelloPayload) => void;
  clientDisconnected: () => void;
  message: (msg: Message) => void;
  error: (err: Error) => void;
}

export class PairProgServer extends EventEmitter {
  private server: ws.Server | null = null;
  private client: ws.WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private readonly MAX_MISSED_PINGS = 3;
  private readonly PING_INTERVAL_MS = 5000;

  get isRunning(): boolean {
    return this.server !== null;
  }

  get hasClient(): boolean {
    return this.client !== null && this.client.readyState === ws.OPEN;
  }

  // Start

  async start(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = new ws.Server({ port, host: "0.0.0.0" }, () => {
        const lanIp = this.getLanIp();
        this.setupHeartbeat();
        resolve(`${lanIp}:${port}`);
      });

      this.server.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });

      this.server.on("connection", (socket) => {
        this.handleNewConnection(socket);
      });
    });
  }

  // Stop

  stop(): void {
    this.stopHeartbeat();

    if (this.client) {
      try {
        this.send(createMessage(MessageType.Disconnect, {}));
        this.client.close();
      } catch {
        // ignore close errors
      }
      this.client = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // Send

  send(msg: Message): void {
    if (this.client && this.client.readyState === ws.OPEN) {
      this.client.send(serialize(msg));
    }
  }

  // Connection Handling

  private handleNewConnection(socket: ws.WebSocket): void {
    // Only allow one client at a time
    if (this.client && this.client.readyState === ws.OPEN) {
      socket.send(
        serialize(
          createMessage(MessageType.Error, {
            message: "Session already has a connected client.",
            code: "SESSION_FULL",
          })
        )
      );
      socket.close();
      return;
    }

    this.client = socket;
    this.missedPings = 0;

    socket.on("message", (data) => {
      try {
        const msg = deserialize(data.toString());

        if (msg.type === MessageType.Hello) {
          this.emit("clientConnected", msg.payload as HelloPayload);
        } else if (msg.type === MessageType.Pong) {
          this.missedPings = 0;
        } else {
          this.emit("message", msg);
        }
      } catch (err) {
        this.emit("error", new Error(`Failed to parse message: ${err}`));
      }
    });

    socket.on("close", () => {
      this.client = null;
      this.missedPings = 0;
      this.emit("clientDisconnected");
    });

    socket.on("error", (err) => {
      this.emit("error", err);
    });
  }

  // Heartbeat

  private setupHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.client || this.client.readyState !== ws.OPEN) {
        return;
      }

      this.missedPings++;
      if (this.missedPings > this.MAX_MISSED_PINGS) {
        this.client.terminate();
        this.client = null;
        this.missedPings = 0;
        this.emit("clientDisconnected");
        return;
      }

      this.send(createMessage(MessageType.Ping, {}));
    }, this.PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // Utility

  private getLanIp(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      const addrs = interfaces[name];
      if (!addrs) { continue; }
      for (const addr of addrs) {
        if (addr.family === "IPv4" && !addr.internal) {
          return addr.address;
        }
      }
    }
    return "127.0.0.1";
  }
}
