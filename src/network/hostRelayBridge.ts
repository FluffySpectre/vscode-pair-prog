import * as ws from "ws";
import { RelayConnector } from "./relayConnector";
import { PairProgServer } from "./server";
import { ShareDBServer } from "../network/sharedbServer";

export class HostRelayBridge {
  private connector: RelayConnector;
  private code = "";
  private adminToken = "";
  private mainSocket: ws.WebSocket | null = null;
  private sharedbSocket: ws.WebSocket | null = null;

  constructor(private readonly relayUrl: string) {
    this.connector = new RelayConnector(relayUrl);
  }

  get sessionCode(): string {
    return this.code;
  }

  get baseUrl(): string {
    return this.relayUrl;
  }

  async register(name: string, workspace: string, requiresPassphrase: boolean): Promise<void> {
    const session = await this.connector.register(name, workspace, requiresPassphrase);
    this.code = session.code;
    this.adminToken = session.adminToken ?? "";
  }

  openChannels(server: PairProgServer, sharedbServer: ShareDBServer): void {
    this.closeChannels();

    this.mainSocket = this.connector.openMainChannel(this.code, "host");
    this.mainSocket.on("open", () => {
      server.adoptRelaySocket(this.mainSocket!);
    });
    this.mainSocket.on("error", (err) => {
      console.warn("[PairProg Host] Relay main socket error:", err.message);
    });

    this.sharedbSocket = this.connector.openShareDBChannel(this.code, "host");
    this.sharedbSocket.on("open", () => {
      sharedbServer.adoptRelaySocket(this.sharedbSocket!);
    });
    this.sharedbSocket.on("error", (err) => {
      console.warn("[PairProg Host] Relay ShareDB socket error:", err.message);
    });
  }

  closeChannels(): void {
    if (this.mainSocket) {
      try { this.mainSocket.close(); } catch { }
      this.mainSocket = null;
    }
    if (this.sharedbSocket) {
      try { this.sharedbSocket.close(); } catch { }
      this.sharedbSocket = null;
    }
  }

  async unregister(): Promise<void> {
    if (this.code) {
      await this.connector.unregister(this.code, this.adminToken).catch(() => {});
    }
  }

  dispose(): void {
    this.closeChannels();
  }
}
