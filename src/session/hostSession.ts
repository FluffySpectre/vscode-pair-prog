import * as vscode from "vscode";
import { PairProgServer } from "../network/server";
import { ShareDBServer } from "../network/sharedbServer";
import { BeaconBroadcaster } from "../network/beacon";
import {
  Message,
  MessageType,
  HelloPayload,
  WelcomePayload,
  CursorUpdatePayload,
  FollowUpdatePayload,
  FileSaveRequestPayload,
  FileContentRequestPayload,
  FileContentResponsePayload,
  createMessage,
} from "../network/protocol";
import { buildDirectoryTree } from "../vfs/directoryTreeBuilder";
import { DocumentSync } from "../sync/documentSync";
import { ShareDBBridge } from "../sync/sharedbBridge";
import { CursorSync } from "../sync/cursorSync";
import { FileOpsSync } from "../sync/fileOpsSync";
import { StatusBar } from "../ui/statusBar";
import { toRelativePath, toAbsoluteUri, getSystemUsername } from "../utils/pathUtils";
import { FeatureRegistry } from "../features";

/**
 * HostSession manages the entire host-side lifecycle:
 *  1. Starts the WebSocket server
 *  2. Waits for a client to connect
 *  3. Performs initial sync (sends open file contents)
 *  4. Relays edits, cursors, and file operations
 */
export class HostSession implements vscode.Disposable {
  private server: PairProgServer;
  private sharedbServer: ShareDBServer | null = null;
  private sharedbBridge: ShareDBBridge | null = null;
  private documentSync: DocumentSync | null = null;
  private cursorSync: CursorSync | null = null;
  private fileOpsSync: FileOpsSync | null = null;
  private statusBar: StatusBar;
  private featureRegistry: FeatureRegistry;

  private username: string;
  private address: string = "";
  private clientUsername: string = "";
  private passphrase: string = "";
  private broadcaster: BeaconBroadcaster | null = null;
  private isStopping = false;
  private _context: vscode.ExtensionContext;
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DISCONNECT_GRACE_MS = 6000;

  constructor(statusBar: StatusBar, context: vscode.ExtensionContext, featureRegistry: FeatureRegistry) {
    this.statusBar = statusBar;
    this._context = context;
    this.featureRegistry = featureRegistry;
    this.server = new PairProgServer();

    const config = vscode.workspace.getConfiguration("pairprog");
    this.username = config.get<string>("username") || getSystemUsername("Host");
  }

  // Start

  async start(): Promise<void> {
    const config = vscode.workspace.getConfiguration("pairprog");
    const port = config.get<number>("port") || 9876;

    const passphrase = await vscode.window.showInputBox({
      prompt: "Set a session passphrase (leave blank for no authentication)",
      password: true,
      placeHolder: "Optional passphrase",
    });
    if (passphrase === undefined) {
      return; // User pressed Escape
    }
    this.passphrase = passphrase;

    this.address = await this.server.start(port);
    this.sharedbServer = new ShareDBServer(this.server);
    this.statusBar.setHosting(this.address);

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    this.broadcaster = new BeaconBroadcaster({
      name: this.username,
      address: this.address,
      workspaceFolder: wsFolder?.name ?? "workspace",
      requiresPassphrase: !!this.passphrase,
    });
    this.broadcaster.on("error", (err: Error) => {
      console.warn("[PairProg Host] Beacon error:", err.message);
    });
    this.broadcaster.start();

    vscode.window.showInformationMessage(
      `Pair Programming session started on ${this.address}`,
      "Copy Address"
    ).then((action) => {
      if (action === "Copy Address") {
        vscode.env.clipboard.writeText(this.address);
      }
    });

    this.server.on("clientConnected", (hello: HelloPayload) => {
      this.onClientConnected(hello);
    });

    this.server.on("clientDisconnected", () => {
      this.onClientDisconnected();
    });

    this.server.on("message", (msg: Message) => {
      this.onMessage(msg);
    });

    this.server.on("error", (err: Error) => {
      console.error("[Pair Prog Host] Error:", err.message);
    });
  }

  // Stop

  stop(): void {
    this.isStopping = true;
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
    this.teardownSync();
    this.sharedbServer?.stop();
    this.sharedbServer = null;
    this.broadcaster?.stop();
    this.broadcaster = null;
    this.server.stop();
    this.statusBar.setDisconnected();
    vscode.window.showInformationMessage("Pair Programming session stopped.");
  }

  // Client Connected

  private async onClientConnected(hello: HelloPayload): Promise<void> {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }

    this.clientUsername = hello.username || "Anonymous";

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      this.server.send(
        createMessage(MessageType.Error, {
          message: "Host has no workspace open.",
        })
      );
      return;
    }

    if (this.passphrase && hello.passphrase !== this.passphrase) {
      this.server.rejectClient({
        message: "Incorrect passphrase.",
        code: "AUTH_FAILED",
      });
      return;
    }

    this.statusBar.setHostConnected(this.address, this.clientUsername);
    vscode.window.showInformationMessage(
      `${this.clientUsername} connected to your session.`
    );

    await this.setupSync();

    const openFiles = this.getOpenTextFiles();
    const welcome: WelcomePayload = { hostUsername: this.username, openFiles };
    this.server.send(createMessage(MessageType.Welcome, welcome));

    // Send directory tree so the client can build its virtual workspace
    const config = vscode.workspace.getConfiguration("pairprog");
    const ignored = config.get<string[]>("ignoredPatterns") || [];
    try {
      const entries = await buildDirectoryTree(wsFolder.uri, ignored);
      this.server.send(
        createMessage(MessageType.DirectoryTree, {
          entries,
          workspaceName: wsFolder.name,
        })
      );
    } catch (err) {
      console.warn("[PairProg Host] Failed to build directory tree:", err);
    }

    // Ensure ShareDB docs exist for all open files
    for (const filePath of openFiles) {
      try {
        const uri = toAbsoluteUri(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await this.sharedbBridge!.ensureDoc(filePath, doc.getText());
      } catch {
        // Skip files that can't be read
      }
    }

    this.cursorSync!.sendCurrentCursor();
  }

  // Client Disconnected

  private onClientDisconnected(): void {
    if (this.isStopping) {
      return; // stop() handles cleanup and status bar
    }
    this.teardownSync();
    this.statusBar.setHosting(this.address);

    const disconnectedUser = this.clientUsername || "Client";
    this.clientUsername = "";
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null;
      vscode.window.showInformationMessage(`${disconnectedUser} disconnected.`);
    }, this.DISCONNECT_GRACE_MS);
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

      case MessageType.FileSaveRequest:
        if (this.documentSync) {
          await this.documentSync.handleFileSaveRequest(msg.payload as FileSaveRequestPayload);
        }
        break;

      case MessageType.FileContentRequest:
        await this.handleFileContentRequest(msg.payload as FileContentRequestPayload);
        break;

      default:
        this.featureRegistry.routeMessage(msg);
        break;
    }
  }

  // Sync Setup / Teardown

  private async setupSync(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders![0];
    const config = vscode.workspace.getConfiguration("pairprog");
    const color = config.get<string>("highlightColor") || "#ec15ef";
    const ignored = config.get<string[]>("ignoredPatterns") || [];

    const sendFn = (msg: Message) => this.server.send(msg);

    const sharedbConnection = this.sharedbServer!.getHostConnection();
    this.sharedbBridge = new ShareDBBridge(sharedbConnection);
    this.sharedbBridge.activate();

    this.documentSync = new DocumentSync(sendFn, true);
    this.documentSync.activate();

    this.cursorSync = new CursorSync(sendFn, this.username, color);
    this.cursorSync.activate();
    this.cursorSync.onDidChangeFollowMode((following) => {
      this.statusBar.setFollowing(following);
    });

    this.fileOpsSync = new FileOpsSync(sendFn, true, wsFolder.uri.fsPath, ignored);
    this.fileOpsSync.activate();

    await this.featureRegistry.activateAll({
      sendFn,
      role: "host",
      username: this.username,
      partnerUsername: this.clientUsername,
      extensionContext: this._context,
    });
  }

  private teardownSync(): void {
    this.documentSync?.dispose();
    this.documentSync = null;

    this.sharedbBridge?.dispose();
    this.sharedbBridge = null;

    this.cursorSync?.dispose();
    this.cursorSync = null;

    this.fileOpsSync?.dispose();
    this.fileOpsSync = null;

    this.featureRegistry.deactivateAll();
  }

  // File content serving

  private async handleFileContentRequest(payload: FileContentRequestPayload): Promise<void> {
    try {
      const uri = toAbsoluteUri(payload.filePath);
      const rawBytes = await vscode.workspace.fs.readFile(uri);

      // Try to decode as UTF-8; fall back to base64 for binary files
      let content: string;
      let encoding: "utf8" | "base64";
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
        encoding = "utf8";
      } catch {
        content = Buffer.from(rawBytes).toString("base64");
        encoding = "base64";
      }

      const response: FileContentResponsePayload = {
        filePath: payload.filePath,
        content,
        encoding,
      };
      this.server.send(createMessage(MessageType.FileContentResponse, response));
    } catch (err) {
      console.warn(`[PairProg Host] Failed to read file ${payload.filePath}:`, err);
    }
  }

  // Utilities

  private getOpenTextFiles(): string[] {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return []; }

    const files: string[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== "file" || doc.isClosed) { continue; }
      const relativePath = toRelativePath(doc.uri);
      if (relativePath) {
        files.push(relativePath);
      }
    }
    return files;
  }

  toggleFollowMode(): void {
    this.cursorSync?.toggleFollow();
  }

  get isActive(): boolean {
    return this.server.isRunning;
  }

  // Dispose

  dispose(): void {
    this.stop();
  }
}
