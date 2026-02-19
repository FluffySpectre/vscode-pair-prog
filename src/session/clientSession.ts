import * as vscode from "vscode";
import { PairProgClient } from "../network/client";
import {
  Message,
  MessageType,
  HelloPayload,
  WelcomePayload,
  EditPayload,
  FullSyncPayload,
  CursorUpdatePayload,
  FollowUpdatePayload,
  FileCreatedPayload,
  FileDeletedPayload,
  FileRenamedPayload,
  createMessage,
  WhiteboardStrokePayload,
  TerminalSharedPayload,
  TerminalOutputPayload,
  TerminalClosedPayload,
  TerminalUnsharedPayload,
  TerminalReadonlyChangedPayload,
} from "../network/protocol";
import { DocumentSync } from "../sync/documentSync";
import { CursorSync } from "../sync/cursorSync";
import { FileOpsSync } from "../sync/fileOpsSync";
import { TerminalSync } from "../sync/terminalSync";
import { StatusBar } from "../ui/statusBar";
import { WhiteboardPanel } from "../ui/whiteboardPanel";

/**
 * ClientSession manages the client-side lifecycle:
 *  1. Connects to the host's WebSocket server
 *  2. Sends Hello, receives Welcome
 *  3. Receives initial FullSync for open files
 *  4. Relays local edits to host and applies confirmed edits from host
 */
export class ClientSession implements vscode.Disposable {
  private client: PairProgClient;
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

  constructor(statusBar: StatusBar, context: vscode.ExtensionContext) {
    this.statusBar = statusBar;
    this._context = context;
    this.client = new PairProgClient();

    const config = vscode.workspace.getConfiguration("pairprog");
    this.username = config.get<string>("username") || this.getDefaultUsername();
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

    // Setup event handlers before connecting
    this.setupClientEvents();

    // Connect to host
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
    this.statusBar.setConnected(this.address, this.hostUsername);

    vscode.window.showInformationMessage(
      `Connected to ${this.hostUsername}'s session.`
    );

    // Setup sync components
    this.setupSync();

    // Send initial cursor position
    this.cursorSync!.sendCurrentCursor();
  }

  // Disconnected

  private onDisconnected(): void {
    this.teardownSync();
    this.statusBar.setDisconnected();
    vscode.window.showWarningMessage(
      "Disconnected from pair programming session."
    );
  }

  // Message Router

  private async onMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case MessageType.Edit:
        if (this.documentSync) {
          await this.documentSync.handleRemoteEdit(msg.payload as EditPayload);
        }
        break;

      case MessageType.FullSync:
        if (this.documentSync) {
          await this.documentSync.handleFullSync(
            msg.payload as FullSyncPayload
          );
        }
        break;

      case MessageType.CursorUpdate:
        if (this.cursorSync) {
          this.cursorSync.handleRemoteCursorUpdate(
            msg.payload as CursorUpdatePayload
          );
        }
        break;

      case MessageType.FollowUpdate:
        if (this.cursorSync) {
          this.cursorSync.handleRemoteFollowUpdate(
            msg.payload as FollowUpdatePayload
          );
        }
        break;

      case MessageType.FileCreated:
        if (this.fileOpsSync) {
          await this.fileOpsSync.handleFileCreated(
            msg.payload as FileCreatedPayload
          );
        }
        break;

      case MessageType.FileDeleted:
        if (this.fileOpsSync) {
          await this.fileOpsSync.handleFileDeleted(
            msg.payload as FileDeletedPayload
          );
        }
        break;

      case MessageType.FileRenamed:
        if (this.fileOpsSync) {
          await this.fileOpsSync.handleFileRenamed(
            msg.payload as FileRenamedPayload
          );
        }
        break;

      case MessageType.WhiteboardStroke:
        this.ensureWhiteboard(this._context);
        if (this.whiteboard && !this.whiteboard.disposed) {
          this.whiteboard.handleRemoteStroke(
            msg.payload as WhiteboardStrokePayload
          );
        }
        break;

      case MessageType.WhiteboardClear:
        if (this.whiteboard && !this.whiteboard.disposed) {
          this.whiteboard.handleRemoteClear();
        }
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

    this.documentSync = new DocumentSync(sendFn, false, wsFolder.uri.fsPath);
    this.documentSync.activate();

    this.cursorSync = new CursorSync(sendFn, this.username, color);
    this.cursorSync.activate();

    this.cursorSync.onDidChangeFollowMode((following) => {
      this.statusBar.setFollowing(following);
    });

    this.fileOpsSync = new FileOpsSync(
      sendFn,
      false,
      wsFolder.uri.fsPath,
      ignored
    );
    this.fileOpsSync.activate();

    this.terminalSync = new TerminalSync(sendFn, false);
    this.terminalSync.activate();
  }

  private teardownSync(): void {
    this.documentSync?.dispose();
    this.documentSync = null;

    this.cursorSync?.dispose();
    this.cursorSync = null;

    this.fileOpsSync?.dispose();
    this.fileOpsSync = null;

    this.terminalSync?.dispose();
    this.terminalSync = null;
  }

  // Utilities

  private getDefaultUsername(): string {
    return require("os").userInfo().username || "Client";
  }

  toggleFollowMode(): void {
    if (!this.cursorSync) { return; }
    this.cursorSync.toggleFollow();
  }

  private ensureWhiteboard(context: vscode.ExtensionContext) {
    if (!this._sendFn) { return; }
    if (!this.whiteboard || this.whiteboard.disposed) {
      this.whiteboard = new WhiteboardPanel(context, this._sendFn);
    }
  }

  openWhiteboard() {
    this.ensureWhiteboard(this._context);
    if (this.whiteboard && !this.whiteboard.disposed) {
      this.whiteboard.reveal();
    }
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
