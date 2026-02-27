import * as ws from "ws";
import * as https from "https";
import * as os from "os";
import selfsigned from "selfsigned";
import { EventEmitter } from "events";
import {
  Message,
  MessageType,
  HelloPayload,
  ErrorPayload,
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
  private _httpServer: https.Server | null = null;
  private wsServer: ws.Server | null = null;
  private client: ws.WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private readonly MAX_MISSED_PINGS = 5;
  private readonly PING_INTERVAL_MS = 10000;

  get isRunning(): boolean {
    return this.wsServer !== null;
  }

  get hasClient(): boolean {
    return this.client !== null && this.client.readyState === ws.OPEN;
  }

  get httpServer(): https.Server | null {
    return this._httpServer;
  }

  // Start

  async start(port: number): Promise<string> {
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "pairprog-lan" }],
      {
        keySize: 2048,
        algorithm: "sha256",
        notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    );

    return new Promise((resolve, reject) => {
      this._httpServer = https.createServer({ key: pems.private, cert: pems.cert });
      this.wsServer = new ws.Server({
        noServer: true,
        perMessageDeflate: {
          zlibDeflateOptions: { level: 6 },
          threshold: 256,
        },
      });

      this._httpServer.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });

      // Route WebSocket upgrade requests by path
      this._httpServer.on("upgrade", (request, socket, head) => {
        const { pathname } = new URL(request.url || "/", "http://localhost");

        if (pathname === "/sharedb") {
          // Let the ShareDB ws.Server handle this - it registers its own
          // upgrade handler via the 'sharedbUpgrade' event we emit.
          this.emit("upgrade", request, socket, head);
        } else {
          // Default path: handle with the protocol ws.Server
          this.wsServer!.handleUpgrade(request, socket, head, (client) => {
            this.wsServer!.emit("connection", client, request);
          });
        }
      });

      this.wsServer.on("connection", (socket) => {
        this.handleNewConnection(socket);
      });

      this._httpServer.listen(port, "0.0.0.0", () => {
        const lanIp = this.getLanIp();
        this.setupHeartbeat();
        resolve(`${lanIp}:${port}`);
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

    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }

    if (this._httpServer) {
      this._httpServer.close();
      this._httpServer = null;
    }
  }

  // Send

  send(msg: Message): void {
    if (this.client && this.client.readyState === ws.OPEN) {
      this.client.send(serialize(msg));
    }
  }

  // Reject and disconnect the current client

  rejectClient(error: ErrorPayload): void {
    if (this.client && this.client.readyState === ws.OPEN) {
      this.client.send(
        serialize(createMessage(MessageType.Error, error))
      );
      this.client.close();
      this.client = null;
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

  // Relay support

  adoptRelaySocket(socket: ws.WebSocket): void {
    const onFirstMessage = (data: ws.RawData) => {
      socket.removeListener("message", onFirstMessage);
      socket.removeListener("close", onClose);

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

      this.handleNewConnection(socket);
      socket.emit("message", data);
    };

    const onClose = () => {
      socket.removeListener("message", onFirstMessage);
    };

    socket.on("message", onFirstMessage);
    socket.on("close", onClose);
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
