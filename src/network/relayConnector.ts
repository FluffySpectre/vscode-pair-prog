import * as ws from "ws";
import * as http from "http";
import * as https from "https";
import { WS_DEFLATE_OPTIONS } from "./wsDefaults";

export interface RelaySessionInfo {
  code: string;
  name: string;
  workspace: string;
  requiresPassphrase: boolean;
  createdAt: number;
  adminToken?: string;
}

/**
 * Manages the extensions connection to a relay server
 */
export class RelayConnector {
  private relayUrl: string;

  constructor(relayUrl: string) {
    this.relayUrl = relayUrl.replace(/\/+$/, "");
  }

  // Register a new session on the relay server. Returns session info including the code.
  async register(name: string, workspace: string, requiresPassphrase: boolean): Promise<RelaySessionInfo> {
    const body = JSON.stringify({ name, workspace, requiresPassphrase });
    const data = await this.httpRequest("POST", "/api/sessions", body);
    return JSON.parse(data) as RelaySessionInfo;
  }

  // List all active sessions on the relay server.
  async listSessions(): Promise<RelaySessionInfo[]> {
    const data = await this.httpRequest("GET", "/api/sessions");
    const parsed = JSON.parse(data) as { sessions: RelaySessionInfo[] };
    return parsed.sessions;
  }

  // Unregister a session from the relay server.
  async unregister(code: string, adminToken: string): Promise<void> {
    await this.httpRequest("DELETE", `/api/sessions/${code}`, undefined, { "Authorization": `Bearer ${adminToken}` });
  }

  // Get the WebSocket URL for the main protocol channel (without opening a connection).
  getMainChannelUrl(code: string, role: "host" | "client"): string {
    return this.getChannelUrl(code, "main", role);
  }

  // Get the WebSocket URL for the ShareDB channel (without opening a connection).
  getShareDBChannelUrl(code: string, role: "host" | "client"): string {
    return this.getChannelUrl(code, "sharedb", role);
  }

  // Open a WebSocket to the relay for the main protocol channel.
  openMainChannel(code: string, role: "host" | "client"): ws.WebSocket {
    return this.openChannel(code, "main", role);
  }

  // Open a WebSocket to the relay for the ShareDB channel.
  openShareDBChannel(code: string, role: "host" | "client"): ws.WebSocket {
    return this.openChannel(code, "sharedb", role);
  }

  private getChannelUrl(code: string, channel: string, role: string): string {
    return this.relayUrl.replace(/^http/, "ws") + `/relay/${code}/${channel}?role=${role}`;
  }

  private openChannel(code: string, channel: string, role: string): ws.WebSocket {
    return new ws.WebSocket(this.getChannelUrl(code, channel, role), {
      perMessageDeflate: WS_DEFLATE_OPTIONS,
    });
  }

  private httpRequest(method: string, path: string, body?: string, extraHeaders?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.relayUrl + path);
      const isHttps = url.protocol === "https:";
      const mod = isHttps ? https : http;

      const headers: Record<string, string | number> = { ...extraHeaders };
      if (body) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
      }

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      };

      const req = mod.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Relay server returned ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      if (body) { req.write(body); }
      req.end();
    });
  }
}
