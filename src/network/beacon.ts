import * as dgram from "dgram";
import * as os from "os";
import { EventEmitter } from "events";
import { BeaconPayload, BEACON_PORT, BEACON_MAGIC } from "./protocol";

const BROADCAST_INTERVAL_MS = 2000;
const LISTEN_DURATION_MS = 2500;

// BeaconBroadcaster

export class BeaconBroadcaster extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private payload: BeaconPayload;

  constructor(payload: Omit<BeaconPayload, "magic">) {
    super();
    this.payload = { magic: BEACON_MAGIC, ...payload };
  }

  start(): void {
    if (this.socket) { return; }

    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    this.socket.on("error", (err) => {
      this.emit("error", err);
      this.stop();
    });

    this.socket.bind(() => {
      try {
        this.socket!.setBroadcast(true);
      } catch (err) {
        this.emit("error", err);
        this.stop();
        return;
      }
      this.sendBeacon();
      this.timer = setInterval(() => this.sendBeacon(), BROADCAST_INTERVAL_MS);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  private getBroadcastAddresses(): string[] {
    const result: string[] = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] ?? []) {
        if (addr.family !== "IPv4" || addr.internal) { continue; }
        const ipParts = addr.address.split(".").map(Number);
        const maskParts = addr.netmask.split(".").map(Number);
        const broadcast = ipParts.map((b, i) => (b | (~maskParts[i] & 0xff))).join(".");
        result.push(broadcast);
      }
    }
    return result.length > 0 ? result : ["255.255.255.255"];
  }

  private sendBeacon(): void {
    if (!this.socket) { return; }
    const msg = Buffer.from(JSON.stringify(this.payload), "utf8");
    for (const broadcastAddr of this.getBroadcastAddresses()) {
      this.socket.send(msg, 0, msg.length, BEACON_PORT, broadcastAddr, (err) => {
        if (err) { this.emit("error", err); }
      });
    }
  }
}

// BeaconListener

export interface DiscoveredSession {
  name: string;
  address: string;
  workspaceFolder: string;
  requiresPassphrase?: boolean;
  lastSeen: number;
}

export class BeaconListener extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private sessions = new Map<string, DiscoveredSession>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  listen(): void {
    if (this.socket) { return; }

    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    this.socket.on("error", (err) => {
      this.emit("error", err);
      this.stop();
    });

    this.socket.on("message", (msg) => {
      this.handleMessage(msg);
    });

    this.socket.bind(BEACON_PORT, () => {
      this.timer = setTimeout(() => {
        const found = Array.from(this.sessions.values());
        this.stop();
        this.emit("done", found);
      }, LISTEN_DURATION_MS);
    });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  private handleMessage(msg: Buffer): void {
    try {
      const beacon = JSON.parse(msg.toString("utf8")) as BeaconPayload;
      if (beacon.magic !== BEACON_MAGIC) { return; }

      const session: DiscoveredSession = {
        name: beacon.name,
        address: beacon.address,
        workspaceFolder: beacon.workspaceFolder,
        requiresPassphrase: beacon.requiresPassphrase,
        lastSeen: Date.now(),
      };

      const isNew = !this.sessions.has(beacon.address);
      this.sessions.set(beacon.address, session);

      if (isNew) {
        this.emit("session", session);
      }
    } catch {
      // Malformed packet - ignore
    }
  }
}
