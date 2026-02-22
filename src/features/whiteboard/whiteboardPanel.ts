import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  Message,
  MessageType,
  WhiteboardEntity,
  WhiteboardEntityAddPayload,
  WhiteboardEntityUpdatePayload,
  WhiteboardEntityDeletePayload,
  WhiteboardFullSyncPayload,
  WhiteboardCursorUpdatePayload,
  createMessage,
} from "../../network/protocol";

export class WhiteboardPanel {
  private panel: vscode.WebviewPanel;
  private sendFn: (msg: Message) => void;
  private _disposed = false;
  private entities: Map<string, WhiteboardEntity>;
  private username: string;
  private highlightColor: string;

  constructor(
    context: vscode.ExtensionContext,
    sendFn: (msg: Message) => void,
    entities: Map<string, WhiteboardEntity>,
    username: string
  ) {
    this.sendFn = sendFn;
    this.entities = entities;
    this.username = username;
    const config = vscode.workspace.getConfiguration("pairprog");
    this.highlightColor = config.get<string>("highlightColor") || "#ec15ef";

    const mediaDir = vscode.Uri.joinPath(context.extensionUri, "media");

    this.panel = vscode.window.createWebviewPanel(
      "pairprogWhiteboard",
      "Pair Programming Whiteboard",
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [mediaDir] }
    );

    const whiteboardDir = vscode.Uri.joinPath(mediaDir, "webviews", "whiteboard");
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(whiteboardDir, "whiteboard.js"));
    const styleUri  = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(whiteboardDir, "whiteboard.css"));
    const cspSource = this.panel.webview.cspSource;

    const htmlPath = path.join(context.extensionPath, "media", "webviews", "whiteboard",  "whiteboard.html");
    this.panel.webview.html = fs.readFileSync(htmlPath, "utf-8")
      .replace("{{scriptUri}}", scriptUri.toString())
      .replace("{{styleUri}}", styleUri.toString())
      .replace(/\{\{cspSource\}\}/g, cspSource);

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
          this.panel.webview.postMessage({
            type: "config",
            payload: { highlightColor: this.highlightColor },
          });
          break;
        }
        case "cursorMove": {
          const payload: WhiteboardCursorUpdatePayload = {
            username: this.username,
            x: msg.payload.x ?? 0,
            y: msg.payload.y ?? 0,
            visible: msg.payload.visible !== false,
          };
          this.sendFn(createMessage(MessageType.WhiteboardCursorUpdate, payload));
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

  handleRemoteCursorUpdate(payload: WhiteboardCursorUpdatePayload) {
    this.panel.webview.postMessage({ type: "cursorUpdate", payload });
  }

  getEntities(): WhiteboardEntity[] {
    return Array.from(this.entities.values());
  }
}
