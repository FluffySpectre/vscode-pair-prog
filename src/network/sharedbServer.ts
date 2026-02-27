import ShareDB from "sharedb";
import { type as otText } from "ot-text";
import WebSocketJSONStream from "@teamwork/websocket-json-stream";
import * as ws from "ws";
import { Connection } from "sharedb/lib/client";
import { PairProgServer } from "./server";

ShareDB.types.register(otText);

/**
 * ShareDBServer sets up a ShareDB backend and WebSocket server for real-time text synchronization.
 */
export class ShareDBServer {
  private backend: ShareDB;
  private wss: ws.Server;
  private hostConnection: Connection;

  constructor(pairProgServer: PairProgServer) {
    this.backend = new ShareDB();

    this.wss = new ws.Server({
      noServer: true,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        threshold: 256,
      },
    });
    this.wss.on("connection", (socket) => {
      const stream = new WebSocketJSONStream(socket);
      this.backend.listen(stream);
    });

    // PairProgServer emits 'upgrade' for /sharedb requests
    pairProgServer.on("upgrade", (request: any, socket: any, head: any) => {
      this.wss.handleUpgrade(request, socket, head, (client) => {
        this.wss.emit("connection", client, request);
      });
    });

    // Create an in-process connection for the host (no network round-trip)
    this.hostConnection = this.backend.connect();
  }

  getHostConnection(): Connection {
    return this.hostConnection;
  }

  adoptRelaySocket(socket: ws.WebSocket): void {
    const stream = new WebSocketJSONStream(socket);
    this.backend.listen(stream);
  }

  stop(): void {
    this.wss.close();
    this.backend.close();
  }
}
