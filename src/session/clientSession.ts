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
  DirectoryTreePayload,
  FileContentRequestPayload,
  FileContentResponsePayload,
  createMessage,
  PROTOCOL_VERSION,
} from "../network/protocol";
import { DocumentSync } from "../sync/documentSync";
import { ShareDBBridge } from "../sync/sharedbBridge";
import { CursorSync } from "../sync/cursorSync";
import { FileOpsSync } from "../sync/fileOpsSync";
import { StatusBar } from "../ui/statusBar";
import { getSystemUsername, toAbsoluteUri } from "../utils/pathUtils";
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";
import { FeatureRegistry } from "../features";
import { type as otText } from "ot-text";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ShareDBClient = require("sharedb/lib/client");
ShareDBClient.types.register(otText);

/**
 * ClientSession manages the client-side lifecycle:
 *  1. Connects to the host's WebSocket server
 *  2. Sends Hello, receives Welcome
 *  3. Receives DirectoryTree, builds virtual workspace
 *  4. Subscribes to ShareDB documents for open files
 *  5. Relays local edits via ShareDB and applies remote ops
 */
export class ClientSession implements vscode.Disposable {
  private client: PairProgClient;
  private sharedbBridge: ShareDBBridge | null = null;
  private sharedbSocket: ws.WebSocket | null = null;
  private documentSync: DocumentSync | null = null;
  private cursorSync: CursorSync | null = null;
  private fileOpsSync: FileOpsSync | null = null;
  private statusBar: StatusBar;
  private featureRegistry: FeatureRegistry;

  private username: string;
  private address: string = "";
  private hostUsername: string = "";
  private _context: vscode.ExtensionContext;
  private _openFiles: string[] = [];
  private vfsProvider: PairProgFileSystemProvider;

  constructor(statusBar: StatusBar, context: vscode.ExtensionContext, vfsProvider: PairProgFileSystemProvider, featureRegistry: FeatureRegistry) {
    this.statusBar = statusBar;
    this._context = context;
    this.vfsProvider = vfsProvider;
    this.featureRegistry = featureRegistry;
    this.client = new PairProgClient();

    const config = vscode.workspace.getConfiguration("pairprog");
    this.username = config.get<string>("username") || getSystemUsername("Client");
  }

  // Connect

  async connect(address: string, passphrase?: string): Promise<void> {
    this.address = address;

    const hello: HelloPayload = {
      username: this.username,
      workspaceFolder: "virtual",
      passphrase: passphrase || undefined,
      protocolVersion: PROTOCOL_VERSION,
    };

    this.setupClientEvents();
    await this.client.connect(address, hello);
  }

  // Disconnect

  disconnect(): void {
    this._context.globalState.update("pairprog.pendingReconnect", undefined);
    this.teardownSync();
    this.vfsProvider.teardown();
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

  // Connected - store welcome data, wait for DirectoryTree before setting up sync

  private onConnected(welcome: WelcomePayload): void {
    this.hostUsername = welcome.hostUsername;
    this._openFiles = welcome.openFiles || [];
    this.statusBar.setConnected(this.address, this.hostUsername);

    vscode.window.showInformationMessage(
      `Connected to ${this.hostUsername}'s session.`
    );
  }

  // Disconnected

  private onDisconnected(): void {
    this._context.globalState.update("pairprog.pendingReconnect", undefined);
    this.teardownSync();
    this.vfsProvider.teardown();
    this.statusBar.setDisconnected();
    vscode.window.showWarningMessage("Disconnected from pair programming session.");
  }

  // Virtual Filesystem Setup

  private async onDirectoryTree(payload: DirectoryTreePayload): Promise<void> {
    this.vfsProvider.setRequestSender((path) => {
      this.client.send(
        createMessage(MessageType.FileContentRequest, {
          filePath: path,
        } as FileContentRequestPayload)
      );
    });
    this.vfsProvider.populateTree(payload.entries);

    // Add the virtual workspace folder so the client can browse remote files in the explorer
    const alreadyHasFolder = (vscode.workspace.workspaceFolders || [])
      .some((f) => f.uri.scheme === PairProgFileSystemProvider.SCHEME);

    if (!alreadyHasFolder) {
      const wsUri = vscode.Uri.parse(`${PairProgFileSystemProvider.SCHEME}:/${payload.workspaceName}`);
      const numFolders = vscode.workspace.workspaceFolders?.length || 0;

      await this._context.globalState.update("pairprog.pendingReconnect", { address: this.address });

      vscode.workspace.updateWorkspaceFolders(numFolders, 0, {
        uri: wsUri,
        name: `Remote: ${payload.workspaceName}`,
      });
    }

    await this.setupSync();

    this.cursorSync!.sendCurrentCursor();

    // Open the files that the host currently has open
    await this.openHostFiles();
  }

  private async openHostFiles(): Promise<void> {
    if (this._openFiles.length === 0) { return; }

    for (const filePath of this._openFiles) {
      try {
        const uri = toAbsoluteUri(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
      } catch {
        // File might not exist in the tree, skip silently
      }
    }
    this._openFiles = [];
  }

  // Message Router

  private async onMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case MessageType.DirectoryTree:
        await this.onDirectoryTree(msg.payload as DirectoryTreePayload);
        break;

      case MessageType.FileContentResponse:
        this.vfsProvider.handleContentResponse(msg.payload as FileContentResponsePayload);
        break;

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

      default:
        this.featureRegistry.routeMessage(msg);
        break;
    }
  }

  // Sync Setup / Teardown

  private async setupSync(): Promise<void> {
    const config = vscode.workspace.getConfiguration("pairprog");
    const color = config.get<string>("highlightColor") || "#FF6B6B";
    const ignored = config.get<string[]>("ignoredPatterns") || [];

    const sendFn = (msg: Message) => this.client.send(msg);

    this.sharedbSocket = new ws.WebSocket(`ws://${this.address}/sharedb`, {
      perMessageDeflate: {
        zlibDeflateOptions: { level: 6 },
        threshold: 256,
      },
    });
    const sharedbConnection = new ShareDBClient.Connection(this.sharedbSocket);

    this.sharedbBridge = new ShareDBBridge(sharedbConnection);
    this.sharedbBridge.activate();

    this.documentSync = new DocumentSync(sendFn, false, this.vfsProvider);
    this.documentSync.activate();

    this.cursorSync = new CursorSync(sendFn, this.username, color);
    this.cursorSync.activate();
    this.cursorSync.onDidChangeFollowMode((following) => {
      this.statusBar.setFollowing(following);
    });

    this.fileOpsSync = new FileOpsSync(sendFn, false, "", ignored, this.vfsProvider);
    this.fileOpsSync.activate();

    await this.featureRegistry.activateAll({
      sendFn,
      role: "client",
      username: this.username,
      partnerUsername: this.hostUsername,
      extensionContext: this._context,
    });
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

    this.featureRegistry.deactivateAll();
  }

  // Utilities

  toggleFollowMode(): void {
    this.cursorSync?.toggleFollow();
  }

  get isActive(): boolean {
    return this.client.isConnected;
  }

  // Dispose

  dispose(): void {
    this.disconnect();
  }
}
