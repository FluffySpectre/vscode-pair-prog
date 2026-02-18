import * as vscode from "vscode";
import * as path from "path";
import {
  Message,
  MessageType,
  FileCreatedPayload,
  FileDeletedPayload,
  FileRenamedPayload,
  createMessage,
} from "../network/protocol";

/**
 * FileOpsSync watches for file create/delete/rename events on the host
 * and propagates them to the client. On the client side, it applies
 * those operations to keep the workspace structure in sync.
 */
export class FileOpsSync implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private isHost: boolean;
  private workspaceRoot: string;
  private isApplyingRemoteOp = false;
  private ignoredPatterns: string[]; // Glob patterns to ignore

  constructor(
    sendFn: (msg: Message) => void,
    isHost: boolean,
    workspaceRoot: string,
    ignoredPatterns: string[]
  ) {
    this.sendFn = sendFn;
    this.isHost = isHost;
    this.workspaceRoot = workspaceRoot;
    this.ignoredPatterns = ignoredPatterns;
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
        if (this.isApplyingRemoteOp) { return; }
        for (const file of e.files) {
          this.onFileCreated(file);
        }
      })
    );

    // Watch for file deletion
    this.disposables.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        if (this.isApplyingRemoteOp) { return; }
        for (const file of e.files) {
          this.onFileDeleted(file);
        }
      })
    );

    // Watch for file rename
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        if (this.isApplyingRemoteOp) { return; }
        for (const { oldUri, newUri } of e.files) {
          this.onFileRenamed(oldUri, newUri);
        }
      })
    );
  }

  // Host: Broadcast Events

  private async onFileCreated(uri: vscode.Uri): Promise<void> {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath || this.isIgnored(relativePath)) { return; }

    let content = "";
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      content = doc.getText();
    } catch {
      // Not a text file or unreadable - send empty content
    }

    const payload: FileCreatedPayload = {
      filePath: relativePath,
      content,
    };
    this.sendFn(createMessage(MessageType.FileCreated, payload));
  }

  private onFileDeleted(uri: vscode.Uri): void {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath || this.isIgnored(relativePath)) { return; }

    const payload: FileDeletedPayload = { filePath: relativePath };
    this.sendFn(createMessage(MessageType.FileDeleted, payload));
  }

  private onFileRenamed(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const oldPath = this.toRelativePath(oldUri);
    const newPath = this.toRelativePath(newUri);
    if (!oldPath || !newPath) { return; }
    if (this.isIgnored(oldPath) && this.isIgnored(newPath)) { return; }

    const payload: FileRenamedPayload = {
      oldPath,
      newPath,
    };
    this.sendFn(createMessage(MessageType.FileRenamed, payload));
  }

  // Client: Apply Remote File Operations

  async handleFileCreated(payload: FileCreatedPayload): Promise<void> {
    const uri = this.toAbsoluteUri(payload.filePath);

    this.isApplyingRemoteOp = true;
    try {
      // Ensure parent directory exists
      const dir = vscode.Uri.joinPath(uri, "..");
      try {
        await vscode.workspace.fs.createDirectory(dir);
      } catch {
        // Directory might already exist
      }

      const content = Buffer.from(payload.content, "utf-8");
      await vscode.workspace.fs.writeFile(uri, content);
    } finally {
      this.isApplyingRemoteOp = false;
    }
  }

  async handleFileDeleted(payload: FileDeletedPayload): Promise<void> {
    const uri = this.toAbsoluteUri(payload.filePath);

    this.isApplyingRemoteOp = true;
    try {
      await vscode.workspace.fs.delete(uri, { recursive: false });
    } catch {
      // File might not exist locally - that's fine
    } finally {
      this.isApplyingRemoteOp = false;
    }
  }

  async handleFileRenamed(payload: FileRenamedPayload): Promise<void> {
    const oldUri = this.toAbsoluteUri(payload.oldPath);
    const newUri = this.toAbsoluteUri(payload.newPath);

    this.isApplyingRemoteOp = true;
    try {
      await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
    } catch {
      // Source might not exist locally - skip
    } finally {
      this.isApplyingRemoteOp = false;
    }
  }

  // Path Utilities

  private toRelativePath(uri: vscode.Uri): string | null {
    const filePath = uri.fsPath;
    if (!filePath.startsWith(this.workspaceRoot)) {
      return null;
    }
    return filePath
      .slice(this.workspaceRoot.length + 1)
      .replace(/\\/g, "/");
  }

  private toAbsoluteUri(relativePath: string): vscode.Uri {
    const wsFolder = vscode.workspace.workspaceFolders![0];
    return vscode.Uri.joinPath(wsFolder.uri, relativePath);
  }

  private isIgnored(relativePath: string): boolean {
    // Simple glob matching using minimatch-style patterns
    for (const pattern of this.ignoredPatterns) {
      if (this.simpleGlobMatch(pattern, relativePath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Very simple glob matcher supporting:
   *  - `*` matches any single path segment
   *  - `**` matches any number of path segments
   *  - `*.ext` matches files with a given extension
   */
  private simpleGlobMatch(pattern: string, filePath: string): boolean {
    // Handle "dir/**" - matches anything under that directory
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return filePath.startsWith(prefix + "/") || filePath === prefix;
    }

    // Handle "*.ext" - matches files ending with that extension
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1); // e.g., ".lock"
      return filePath.endsWith(ext);
    }

    // Exact match
    return filePath === pattern;
  }

  // Dispose

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
