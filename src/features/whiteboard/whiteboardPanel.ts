import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  Message,
  MessageType,
  WhiteboardEntity,
  WhiteboardEntityAddPayload,
  WhiteboardEntityUpdatePayload,
  WhiteboardEntityDeletePayload,
  WhiteboardFullSyncPayload,
  createMessage,
} from "../../network/protocol";

export class WhiteboardPanel {
  private panel: vscode.WebviewPanel;
  private sendFn: (msg: Message) => void;
  private _disposed = false;
  private entities: Map<string, WhiteboardEntity>;

  constructor(
    context: vscode.ExtensionContext,
    sendFn: (msg: Message) => void,
    entities: Map<string, WhiteboardEntity>
  ) {
    this.sendFn = sendFn;
    this.entities = entities;

    this.panel = vscode.window.createWebviewPanel(
      "pairprogWhiteboard",
      "Pair Programming Whiteboard",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const htmlPath = path.join(context.extensionPath, "media", "webviews", "whiteboard.html");
    const nonce = getNonce();
    this.panel.webview.html = fs.readFileSync(htmlPath, "utf-8")
      .replace(/\{\{nonce\}\}/g, nonce);

    this.panel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case "entityAdd": {
          const entity = msg.payload.entity as WhiteboardEntity;
          this.entities.set(entity.id, entity);
          this.sendFn(createMessage(MessageType.WhiteboardEntityAdd, msg.payload));
          break;
        }
        case "entityUpdate": {
          const existing = this.entities.get(msg.payload.id);
          if (existing) {
            Object.assign(existing, msg.payload.changes);
          }
          this.sendFn(createMessage(MessageType.WhiteboardEntityUpdate, msg.payload));
          break;
        }
        case "entityDelete": {
          this.entities.delete(msg.payload.id);
          this.sendFn(createMessage(MessageType.WhiteboardEntityDelete, msg.payload));
          break;
        }
        case "clear": {
          this.entities.clear();
          this.sendFn(createMessage(MessageType.WhiteboardClear, {}));
          break;
        }
        case "requestFullSync": {
          this.panel.webview.postMessage({
            type: "fullSync",
            payload: { entities: Array.from(this.entities.values()) },
          });
          break;
        }
        case "savePng": {
          (async () => {
            const dataUrl = msg.payload.dataUrl as string;
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
            const buffer = Buffer.from(base64, "base64");
            const now = new Date();
            const timestamp = now.getFullYear().toString()
              + (now.getMonth() + 1).toString().padStart(2, "0")
              + now.getDate().toString().padStart(2, "0")
              + "-"
              + now.getHours().toString().padStart(2, "0")
              + now.getMinutes().toString().padStart(2, "0")
              + now.getSeconds().toString().padStart(2, "0");
            const uri = await vscode.window.showSaveDialog({
              filters: { "PNG Image": ["png"] },
              defaultUri: vscode.Uri.file(`whiteboard-${timestamp}.png`),
            });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, buffer);
              vscode.window.showInformationMessage(`Whiteboard saved to ${uri.fsPath}`);
            }
          })();
          break;
        }
      }
    });

    this.panel.onDidDispose(() => {
      this._disposed = true;
    });
  }

  get disposed(): boolean {
    return this._disposed;
  }

  reveal() {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  handleRemoteEntityAdd(payload: WhiteboardEntityAddPayload) {
    this.panel.webview.postMessage({ type: "entityAdd", payload });
  }

  handleRemoteEntityUpdate(payload: WhiteboardEntityUpdatePayload) {
    this.panel.webview.postMessage({ type: "entityUpdate", payload });
  }

  handleRemoteEntityDelete(payload: WhiteboardEntityDeletePayload) {
    this.panel.webview.postMessage({ type: "entityDelete", payload });
  }

  handleRemoteFullSync(payload: WhiteboardFullSyncPayload) {
    this.panel.webview.postMessage({ type: "fullSync", payload });
  }

  handleRemoteClear() {
    this.panel.webview.postMessage({ type: "clear" });
  }

  getEntities(): WhiteboardEntity[] {
    return Array.from(this.entities.values());
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}
