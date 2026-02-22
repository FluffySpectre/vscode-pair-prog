import * as ws from "ws";
import { EventEmitter } from "events";
import {
  Message,
  MessageType,
  WelcomePayload,
  serialize,
  deserialize,
  createMessage,
  HelloPayload,
  PROTOCOL_VERSION,
} from "./protocol";

export interface ClientEvents {
  connected: (welcome: WelcomePayload) => void;
  disconnected: () => void;
  message: (msg: Message) => void;
  reconnecting: (attempt: number) => void;
  error: (err: Error) => void;
}

export class PairProgClient extends EventEmitter {
  private socket: ws.WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 15;
  private readonly RECONNECT_INTERVAL_MS = 2000;
  private readonly HEARTBEAT_TIMEOUT_MS = 20000;
  private address: string = "";
  private helloPayload: HelloPayload | null = null;
  private intentionalDisconnect = false;

  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === ws.OPEN;
  }

  // Connect

  async connect(address: string, hello: HelloPayload): Promise<void> {
    this.address = address;
    this.helloPayload = hello;
    this.intentionalDisconnect = false;

    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://${this.address}`;
      this.socket = new ws.WebSocket(url, {
        perMessageDeflate: {
          zlibDeflateOptions: { level: 6 },
          threshold: 256,
        },
        rejectUnauthorized: false, // Accept the host's self-signed TLS certificate
      });

      const onOpen = () => {
        this.reconnectAttempts = 0;
        cleanup();

        // Send Hello
        if (this.helloPayload) {
          this.send(createMessage(MessageType.Hello, this.helloPayload));
        }

        this.setupSocketListeners();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.socket?.removeListener("open", onOpen);
        this.socket?.removeListener("error", onError);
      };

      this.socket.on("open", onOpen);
      this.socket.on("error", onError);
    });
  }

  // Disconnect

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopReconnect();
    this.stopHeartbeat();

    if (this.socket) {
      try {
        this.send(createMessage(MessageType.Disconnect, {}));
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
  }

  // Send

  send(msg: Message): void {
    if (this.socket && this.socket.readyState === ws.OPEN) {
      this.socket.send(serialize(msg));
    }
  }

  // Heartbeat

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      // Server hasn't sent a Ping in too long - assume connection is dead
      if (this.socket) {
        this.socket.terminate();
      }
    }, this.HEARTBEAT_TIMEOUT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // Socket Listeners

  private setupSocketListeners(): void {
    if (!this.socket) { return; }

    this.resetHeartbeatTimeout();

    this.socket.on("message", (data) => {
      try {
        const msg = deserialize(data.toString());

        switch (msg.type) {
          case MessageType.Welcome: {
            const welcome = msg.payload as WelcomePayload;
            if (welcome.protocolVersion !== PROTOCOL_VERSION) {
              this.intentionalDisconnect = true;
              this.emit("error", new Error(
                `Protocol version mismatch: host uses v${welcome.protocolVersion ?? "unknown"}, this extension requires v${PROTOCOL_VERSION}. Please ensure both sides run the same extension version.`
              ));
              this.socket?.close();
              return;
            }
            this.emit("connected", welcome);
            break;
          }

          case MessageType.Ping:
            this.resetHeartbeatTimeout();
            this.send(createMessage(MessageType.Pong, {}));
            break;

          case MessageType.Disconnect:
            this.intentionalDisconnect = true;
            this.socket?.close();
            this.emit("disconnected");
            break;

          case MessageType.Error: {
            const errorPayload = msg.payload as { message: string; code?: string };
            if (errorPayload.code === "AUTH_FAILED" || errorPayload.code === "VERSION_MISMATCH" || errorPayload.code === "SESSION_FULL") {
              this.intentionalDisconnect = true;
              this.stopReconnect();
              this.stopHeartbeat();
              this.socket?.close();
            }
            this.emit("error", new Error(errorPayload.message));
            break;
          }

          default:
            this.emit("message", msg);
            break;
        }
      } catch (err) {
        this.emit("error", new Error(`Failed to parse message: ${err}`));
      }
    });

    this.socket.on("close", () => {
      this.socket = null;
      this.stopHeartbeat();
      if (!this.intentionalDisconnect) {
        this.attemptReconnect();
      } else {
        this.emit("disconnected");
      }
    });

    this.socket.on("error", (err) => {
      this.emit("error", err);
    });
  }

  // Reconnection

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.emit("disconnected");
      return;
    }

    this.reconnectAttempts++;
    this.emit("reconnecting", this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.doConnect();
      } catch {
        this.attemptReconnect();
      }
    }, this.RECONNECT_INTERVAL_MS);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }
}
