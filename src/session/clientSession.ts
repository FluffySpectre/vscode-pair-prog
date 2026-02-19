import * as vscode from "vscode";
import * as ws from "ws";
import { PairProgClient } from "../network/client";
import {
  Message,
  MessageType,
  HelloPayload,
  WelcomePayload,
  CursorUpdatePayload,
  FollowUpdatePayload,
  FileCreatedPayload,
  FileDeletedPayload,
  FileRenamedPayload,
  FileSavedPayload,
  createMessage,
  WhiteboardStrokePayload,
  ChatMessagePayload,
  TerminalSharedPayload,
  TerminalOutputPayload,
  TerminalClosedPayload,
  TerminalUnsharedPayload,
  TerminalReadonlyChangedPayload,
} from "../network/protocol";
import { DocumentSync } from "../sync/documentSync";
import { ShareDBBridge } from "../sync/sharedbBridge";
import { CursorSync } from "../sync/cursorSync";
import { FileOpsSync } from "../sync/fileOpsSync";
import { TerminalSync } from "../sync/terminalSync";
import { StatusBar } from "../ui/statusBar";
import { WhiteboardPanel } from "../ui/whiteboardPanel";
import { getSystemUsername } from "../utils/pathUtils";
import { showChatMessage, promptAndSendMessage } from "../utils/chatUtils";
import { type as otText } from "ot-text";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ShareDBClient = require("sharedb/lib/client");
ShareDBClient.types.register(otText);

/**
 * ClientSession manages the client-side lifecycle:
 *  1. Connects to the host's WebSocket server
 *  2. Sends Hello, receives Welcome
 *  3. Subscribes to ShareDB documents for open files
 *  4. Relays local edits via ShareDB and applies remote ops
 */
export class ClientSession implements vscode.Disposable {
  private client: PairProgClient;
  private sharedbBridge: ShareDBBridge | null = null;
  private sharedbSocket: ws.WebSocket | null = null;
  private documentSync: DocumentSync | null = null;
  private cursorSync: CursorSync | null = null;
  private fileOpsSync: FileOpsSync | null = null;
  private terminalSync: TerminalSync | null = null;
  private statusBar: StatusBar;
  private whiteboard?: WhiteboardPanel;
  private disposables: vscode.Disposable[] = [];

  private username: string;
  private address: string = "";
  private hostUsername: string = "";
  private _sendFn?: (msg: Message) => void;
  private _context: vscode.ExtensionContext;
  private _openFiles: string[] = [];

  constructor(statusBar: StatusBar, context: vscode.ExtensionContext) {
    this.statusBar = statusBar;
    this._context = context;
    this.client = new PairProgClient();

    const config = vscode.workspace.getConfiguration("pairprog");
    this.username = config.get<string>("username") || getSystemUsername("Client");
  }

  // Connect

  async connect(address: string): Promise<void> {
    this.address = address;

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      throw new Error("No workspace folder open.");
    }

    const hello: HelloPayload = {
      username: this.username,
      workspaceFolder: wsFolder.name,
    };

    this.setupClientEvents();
    await this.client.connect(address, hello);
  }

  // Disconnect

  disconnect(): void {
    this.teardownSync();
    this.client.disconnect();
    this.statusBar.setDisconnected();
    vscode.window.showInformationMessage("Disconnected from pair programming session.");
  }

  // Client Events

  private setupClientEvents(): void {
    this.client.on("connected", (welcome: WelcomePayload) => {
      this.onConnected(welcome);
    });

    this.client.on("disconnected", () => {
      this.onDisconnected();
    });

    this.client.on("reconnecting", (attempt: number) => {
      this.cursorSync?.clearDecorations();
      this.statusBar.setReconnecting(attempt);
    });

    this.client.on("message", (msg: Message) => {
      this.onMessage(msg);
    });

    this.client.on("error", (err: Error) => {
      console.error("[Pair Prog Client] Error:", err.message);
      vscode.window.showErrorMessage(`Pair Programming error: ${err.message}`);
    });
  }

  // Connected

  private onConnected(welcome: WelcomePayload): void {
    this.hostUsername = welcome.hostUsername;
    this._openFiles = welcome.openFiles || [];
    this.statusBar.setConnected(this.address, this.hostUsername);

    vscode.window.showInformationMessage(
      `Connected to ${this.hostUsername}'s session.`
    );

    this.setupSync();

    for (const filePath of this._openFiles) {
      this.sharedbBridge?.ensureDoc(filePath).catch((err) => {
        console.warn(`[PairProg Client] Failed to subscribe to ${filePath}:`, err);
      });
    }

    this.cursorSync!.sendCurrentCursor();
  }

  // Disconnected

  private onDisconnected(): void {
    this.teardownSync();
    this.statusBar.setDisconnected();
    vscode.window.showWarningMessage("Disconnected from pair programming session.");
  }

  // Message Router

  private async onMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case MessageType.CursorUpdate:
        this.cursorSync?.handleRemoteCursorUpdate(msg.payload as CursorUpdatePayload);
        break;

      case MessageType.FollowUpdate:
        this.cursorSync?.handleRemoteFollowUpdate(msg.payload as FollowUpdatePayload);
        break;

      case MessageType.FileCreated:
        if (this.fileOpsSync) {
          await this.fileOpsSync.handleFileCreated(msg.payload as FileCreatedPayload);
        }
        break;

      case MessageType.FileDeleted:
        if (this.fileOpsSync) {
          await this.fileOpsSync.handleFileDeleted(msg.payload as FileDeletedPayload);
        }
        break;

      case MessageType.FileRenamed:
        if (this.fileOpsSync) {
          await this.fileOpsSync.handleFileRenamed(msg.payload as FileRenamedPayload);
        }
        break;

      case MessageType.FileSaved:
        if (this.documentSync) {
          await this.documentSync.handleFileSaved(msg.payload as FileSavedPayload);
        }
        break;

      case MessageType.WhiteboardStroke:
        this.ensureWhiteboard();
        this.whiteboard?.handleRemoteStroke(msg.payload as WhiteboardStrokePayload);
        break;

      case MessageType.WhiteboardClear:
        this.whiteboard?.handleRemoteClear();
        break;

      case MessageType.ChatMessage:
        await showChatMessage(
          msg.payload as ChatMessagePayload,
          this.hostUsername || "Host",
          () => this.sendMessage()
        );
        break;

      case MessageType.TerminalShared:
        this.terminalSync?.handleTerminalShared(
          msg.payload as TerminalSharedPayload
        );
        break;

      case MessageType.TerminalOutput:
        this.terminalSync?.handleTerminalOutput(
          msg.payload as TerminalOutputPayload
        );
        break;

      case MessageType.TerminalClosed:
        this.terminalSync?.handleTerminalClosed(
          msg.payload as TerminalClosedPayload
        );
        break;

      case MessageType.TerminalUnshared:
        this.terminalSync?.handleTerminalUnshared(
          msg.payload as TerminalUnsharedPayload
        );
        break;

      case MessageType.TerminalReadonlyChanged:
        this.terminalSync?.handleTerminalReadonlyChanged(
          msg.payload as TerminalReadonlyChangedPayload
        );
        break;

      default:
        break;
    }
  }

  // Sync Setup / Teardown

  private setupSync(): void {
    const wsFolder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration("pairprog");
    const color = config.get<string>("highlightColor") || "#FF6B6B";
    const ignored = config.get<string[]>("ignoredPatterns") || [];

    const sendFn = (msg: Message) => this.client.send(msg);
    this._sendFn = sendFn;

    this.sharedbSocket = new ws.WebSocket(`ws://${this.address}/sharedb`);
    const sharedbConnection = new ShareDBClient.Connection(this.sharedbSocket);

    this.sharedbBridge = new ShareDBBridge(sharedbConnection);
    this.sharedbBridge.activate();

    this.documentSync = new DocumentSync(sendFn, false);
    this.documentSync.activate();

    this.cursorSync = new CursorSync(sendFn, this.username, color);
    this.cursorSync.activate();
    this.cursorSync.onDidChangeFollowMode((following) => {
      this.statusBar.setFollowing(following);
    });

    this.fileOpsSync = new FileOpsSync(sendFn, false, wsFolder.uri.fsPath, ignored);
    this.fileOpsSync.activate();

    this.terminalSync = new TerminalSync(sendFn, false);
    this.terminalSync.activate();
  }

  private teardownSync(): void {
    this.documentSync?.dispose();
    this.documentSync = null;

    this.sharedbBridge?.dispose();
    this.sharedbBridge = null;

    if (this.sharedbSocket) {
      try {
        this.sharedbSocket.close();
      } catch {
        // ignore
      }
      this.sharedbSocket = null;
    }

    this.cursorSync?.dispose();
    this.cursorSync = null;

    this.fileOpsSync?.dispose();
    this.fileOpsSync = null;

    this.terminalSync?.dispose();
    this.terminalSync = null;
  }

  // Utilities

  toggleFollowMode(): void {
    this.cursorSync?.toggleFollow();
  }

  private ensureWhiteboard(): void {
    if (!this._sendFn) { return; }
    if (!this.whiteboard || this.whiteboard.disposed) {
      this.whiteboard = new WhiteboardPanel(this._context, this._sendFn);
    }
  }

  openWhiteboard(): void {
    this.ensureWhiteboard();
    if (this.whiteboard && !this.whiteboard.disposed) {
      this.whiteboard.reveal();
    }
  }

  async sendMessage(): Promise<void> {
    await promptAndSendMessage(
      !!this._sendFn,
      "Not connected to a session.",
      this.hostUsername || "host",
      (text) => {
        this._sendFn!(
          createMessage(MessageType.ChatMessage, {
            text,
            username: this.username,
          } as ChatMessagePayload)
        );
      }
    );
  }

  get isActive(): boolean {
    return this.client.isConnected;
  }

  // Dispose

  dispose(): void {
    this.disconnect();
    this.disposables.forEach((d) => d.dispose());
  }
}
