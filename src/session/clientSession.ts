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
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";
import { type as otText } from "ot-text";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ShareDBClient = require("sharedb/lib/client");
ShareDBClient.types.register(otText);

const VFS_SCHEME = "pairprog";

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
  private vfsProvider: PairProgFileSystemProvider;
  private pendingContentRequests = new Map<string, (content: Uint8Array) => void>();

  constructor(statusBar: StatusBar, context: vscode.ExtensionContext, vfsProvider: PairProgFileSystemProvider) {
    this.statusBar = statusBar;
    this._context = context;
    this.vfsProvider = vfsProvider;
    this.client = new PairProgClient();

    const config = vscode.workspace.getConfiguration("pairprog");
    this.username = config.get<string>("username") || getSystemUsername("Client");
  }

  // Connect

  async connect(address: string): Promise<void> {
    this.address = address;

    const hello: HelloPayload = {
      username: this.username,
      workspaceFolder: "virtual",
    };

    this.setupClientEvents();
    await this.client.connect(address, hello);
  }

  // Disconnect

  disconnect(): void {
    this.teardownSync();
    this.teardownVfs();
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
    this.teardownSync();
    this.teardownVfs();
    this.statusBar.setDisconnected();
    vscode.window.showWarningMessage("Disconnected from pair programming session.");
  }

  // Virtual Filesystem Setup

  private async onDirectoryTree(payload: DirectoryTreePayload): Promise<void> {
    this.vfsProvider.setContentRequester((path) => this.requestFileContent(path));
    this.vfsProvider.populateTree(payload.entries);

    // Add the virtual workspace folder so the client can browse remote files in the explorer
    const alreadyHasFolder = (vscode.workspace.workspaceFolders || [])
      .some((f) => f.uri.scheme === VFS_SCHEME);

    if (!alreadyHasFolder) {
      const wsUri = vscode.Uri.parse(`${VFS_SCHEME}:/${payload.workspaceName}`);
      const numFolders = vscode.workspace.workspaceFolders?.length || 0;

      vscode.workspace.updateWorkspaceFolders(numFolders, 0, {
        uri: wsUri,
        name: `Remote: ${payload.workspaceName}`,
      });
    }

    this.setupSync();

    this.cursorSync!.sendCurrentCursor();
  }

  private requestFileContent(relativePath: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve) => {
      this.pendingContentRequests.set(relativePath, resolve);
      this.client.send(
        createMessage(MessageType.FileContentRequest, {
          filePath: relativePath,
        } as FileContentRequestPayload)
      );

      // Timeout after 10 seconds to avoid hanging forever
      setTimeout(() => {
        if (this.pendingContentRequests.has(relativePath)) {
          this.pendingContentRequests.delete(relativePath);
          resolve(new Uint8Array(0));
        }
      }, 10000);
    });
  }

  private onFileContentResponse(payload: FileContentResponsePayload): void {
    const resolver = this.pendingContentRequests.get(payload.filePath);
    if (!resolver) {
      return;
    }
    this.pendingContentRequests.delete(payload.filePath);

    let content: Uint8Array;
    if (payload.encoding === "base64") {
      content = Uint8Array.from(Buffer.from(payload.content, "base64"));
    } else {
      content = new TextEncoder().encode(payload.content);
    }

    resolver(content);
  }

  private teardownVfs(): void {
    // Resolve any pending content requests to avoid hanging promises
    for (const resolver of this.pendingContentRequests.values()) {
      resolver(new Uint8Array(0));
    }
    this.pendingContentRequests.clear();

    // Close all editor tabs that belong to the virtual filesystem
    const vfsTabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.scheme === VFS_SCHEME) {
          vfsTabs.push(tab);
        } else if (input instanceof vscode.TabInputTextDiff) {
          if (input.original.scheme === VFS_SCHEME || input.modified.scheme === VFS_SCHEME) {
            vfsTabs.push(tab);
          }
        }
      }
    }
    if (vfsTabs.length > 0) {
      vscode.window.tabGroups.close(vfsTabs);
    }

    // Remove the virtual workspace folder
    const folders = vscode.workspace.workspaceFolders || [];
    const vfsIndex = folders.findIndex((f) => f.uri.scheme === VFS_SCHEME);
    if (vfsIndex !== -1) {
      vscode.workspace.updateWorkspaceFolders(vfsIndex, 1);
    }

    // Clear the VFS provider state
    this.vfsProvider.clear();
  }

  // Message Router

  private async onMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case MessageType.DirectoryTree:
        await this.onDirectoryTree(msg.payload as DirectoryTreePayload);
        break;

      case MessageType.FileContentResponse:
        this.onFileContentResponse(msg.payload as FileContentResponsePayload);
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
    const config = vscode.workspace.getConfiguration("pairprog");
    const color = config.get<string>("highlightColor") || "#FF6B6B";
    const ignored = config.get<string[]>("ignoredPatterns") || [];

    const sendFn = (msg: Message) => this.client.send(msg);
    this._sendFn = sendFn;

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
