import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  Message,
  MessageType,
  WhiteboardStrokePayload,
  createMessage,
} from "../../network/protocol";

export class WhiteboardPanel {
  private panel: vscode.WebviewPanel;
  private sendFn: (msg: Message) => void;
  private _disposed = false;

  constructor(
    context: vscode.ExtensionContext,
    sendFn: (msg: Message) => void
  ) {
    this.sendFn = sendFn;

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
      if (msg.type === "stroke") {
        const payload: WhiteboardStrokePayload = msg.payload;
        this.sendFn(createMessage(MessageType.WhiteboardStroke, payload));
      }

      if (msg.type === "clear") {
        this.sendFn(createMessage(MessageType.WhiteboardClear, {}));
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

  handleRemoteStroke(payload: WhiteboardStrokePayload) {
    this.panel.webview.postMessage({
      type: "stroke",
      payload,
    });
  }

  handleRemoteClear() {
    this.panel.webview.postMessage({ type: "clear" });
  }
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}
