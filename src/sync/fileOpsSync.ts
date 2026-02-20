import * as vscode from "vscode";
import {
  Message,
  MessageType,
  FileCreatedPayload,
  FileDeletedPayload,
  FileRenamedPayload,
  createMessage,
} from "../network/protocol";
import { toRelativePathFromRoot, toAbsoluteUri } from "../utils/pathUtils";
import { isIgnoredByPatterns } from "../utils/globUtils";
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";

/**
 * FileOpsSync watches for file create/delete/rename events on the host
 * and propagates them to the client. On the client side, it applies
 * those operations to the virtual filesystem (or disk if no VFS).
 */
export class FileOpsSync implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private isHost: boolean;
  private workspaceRoot: string;
  private remoteOpGuard = 0;
  private ignoredPatterns: string[];
  private vfsProvider?: PairProgFileSystemProvider;

  constructor(
    sendFn: (msg: Message) => void,
    isHost: boolean,
    workspaceRoot: string,
    ignoredPatterns: string[],
    vfsProvider?: PairProgFileSystemProvider
  ) {
    this.sendFn = sendFn;
    this.isHost = isHost;
    this.workspaceRoot = workspaceRoot;
    this.ignoredPatterns = ignoredPatterns;
    this.vfsProvider = vfsProvider;
  }

  // Activation

  activate(): void {
    if (!this.isHost) {
      // Client doesn't broadcast file ops - only receives them
      return;
    }

    // Watch for file creation
    this.disposables.push(
      vscode.workspace.onDidCreateFiles((e) => {
        if (this.remoteOpGuard > 0) { return; }
        for (const file of e.files) {
          this.onFileCreated(file);
        }
      })
    );

    // Watch for file deletion
    this.disposables.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        if (this.remoteOpGuard > 0) { return; }
        for (const file of e.files) {
          this.onFileDeleted(file);
        }
      })
    );

    // Watch for file rename
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        if (this.remoteOpGuard > 0) { return; }
        for (const { oldUri, newUri } of e.files) {
          this.onFileRenamed(oldUri, newUri);
        }
      })
    );
  }

  // Host: Broadcast Events

  private async onFileCreated(uri: vscode.Uri): Promise<void> {
    const relativePath = toRelativePathFromRoot(uri, this.workspaceRoot);
    if (!relativePath || this.isIgnored(relativePath)) { return; }

    let content = "";
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      content = doc.getText();
    } catch {
      // Not a text file or unreadable - send empty content
    }

    const payload: FileCreatedPayload = { filePath: relativePath, content };
    this.sendFn(createMessage(MessageType.FileCreated, payload));
  }

  private onFileDeleted(uri: vscode.Uri): void {
    const relativePath = toRelativePathFromRoot(uri, this.workspaceRoot);
    if (!relativePath || this.isIgnored(relativePath)) { return; }

    const payload: FileDeletedPayload = { filePath: relativePath };
    this.sendFn(createMessage(MessageType.FileDeleted, payload));
  }

  private onFileRenamed(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const oldPath = toRelativePathFromRoot(oldUri, this.workspaceRoot);
    const newPath = toRelativePathFromRoot(newUri, this.workspaceRoot);
    if (!oldPath || !newPath) { return; }
    if (this.isIgnored(oldPath) && this.isIgnored(newPath)) { return; }

    const payload: FileRenamedPayload = { oldPath, newPath };
    this.sendFn(createMessage(MessageType.FileRenamed, payload));
  }

  // Client: Apply Remote File Operations

  async handleFileCreated(payload: FileCreatedPayload): Promise<void> {
    if (this.vfsProvider) {
      this.vfsProvider.applyFileCreated(payload.filePath, payload.content);
      return;
    }

    // Fallback: write to disk (legacy behavior)
    const uri = toAbsoluteUri(payload.filePath);
    this.remoteOpGuard++;
    try {
      const dir = vscode.Uri.joinPath(uri, "..");
      try {
        await vscode.workspace.fs.createDirectory(dir);
      } catch {
        // Directory might already exist
      }
      const content = Buffer.from(payload.content, "utf-8");
      await vscode.workspace.fs.writeFile(uri, content);
    } finally {
      this.remoteOpGuard--;
    }
  }

  async handleFileDeleted(payload: FileDeletedPayload): Promise<void> {
    if (this.vfsProvider) {
      this.vfsProvider.applyFileDeleted(payload.filePath);
      return;
    }

    // Fallback: delete from disk (legacy behavior)
    const uri = toAbsoluteUri(payload.filePath);
    this.remoteOpGuard++;
    try {
      await vscode.workspace.fs.delete(uri, { recursive: false });
    } catch {
      // File might not exist locally - that's fine
    } finally {
      this.remoteOpGuard--;
    }
  }

  async handleFileRenamed(payload: FileRenamedPayload): Promise<void> {
    if (this.vfsProvider) {
      this.vfsProvider.applyFileRenamed(payload.oldPath, payload.newPath);
      return;
    }

    // Fallback: rename on disk (legacy behavior)
    const oldUri = toAbsoluteUri(payload.oldPath);
    const newUri = toAbsoluteUri(payload.newPath);
    this.remoteOpGuard++;
    try {
      await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
    } catch {
      // Source might not exist locally - skip
    } finally {
      this.remoteOpGuard--;
    }
  }

  // Glob Matching

  private isIgnored(relativePath: string): boolean {
    return isIgnoredByPatterns(relativePath, this.ignoredPatterns);
  }

  // Dispose

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
