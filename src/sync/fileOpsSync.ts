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
import { RemoteOpGuard } from "./remoteOpGuard";

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
  private readonly remoteOpGuard = new RemoteOpGuard();
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
        for (const file of e.files) {
          const relativePath = toRelativePathFromRoot(file, this.workspaceRoot);
          if (!relativePath || this.remoteOpGuard.isActive(relativePath)) { continue; }
          this.onFileCreated(file);
        }
      })
    );

    // Watch for file deletion
    this.disposables.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const file of e.files) {
          const relativePath = toRelativePathFromRoot(file, this.workspaceRoot);
          if (!relativePath || this.remoteOpGuard.isActive(relativePath)) { continue; }
          this.onFileDeleted(file);
        }
      })
    );

    // Watch for file rename — suppress if either side of the rename is in flight
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          const oldPath = toRelativePathFromRoot(oldUri, this.workspaceRoot);
          const newPath = toRelativePathFromRoot(newUri, this.workspaceRoot);
          if ((oldPath && this.remoteOpGuard.isActive(oldPath)) ||
              (newPath && this.remoteOpGuard.isActive(newPath))) { continue; }
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
    let isDirectory = false;

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      isDirectory = stat.type === vscode.FileType.Directory;
    } catch {
      // URI was deleted before we could stat it - skip
      return;
    }

    if (!isDirectory) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        content = doc.getText();
      } catch {
        // Binary file or unreadable - send empty content
      }
    }

    const payload: FileCreatedPayload = { filePath: relativePath, content, isDirectory };
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
      this.vfsProvider.applyFileCreated(payload.filePath, payload.content, payload.isDirectory);
      return;
    }

    // Fallback: write to disk (legacy behavior)
    const uri = toAbsoluteUri(payload.filePath);
    await this.remoteOpGuard.run(payload.filePath, async () => {
      if (payload.isDirectory) {
        await vscode.workspace.fs.createDirectory(uri);
      } else {
        const dir = vscode.Uri.joinPath(uri, "..");
        try {
          await vscode.workspace.fs.createDirectory(dir);
        } catch {
          // Parent directory might already exist
        }
        const content = Buffer.from(payload.content, "utf-8");
        await vscode.workspace.fs.writeFile(uri, content);
      }
    });
  }

  async handleFileDeleted(payload: FileDeletedPayload): Promise<void> {
    if (this.vfsProvider) {
      this.vfsProvider.applyFileDeleted(payload.filePath);
      return;
    }

    // Fallback: delete from disk (legacy behavior)
    const uri = toAbsoluteUri(payload.filePath);
    await this.remoteOpGuard.run(payload.filePath, async () => {
      try {
        await vscode.workspace.fs.delete(uri, { recursive: false });
      } catch {
        // File might not exist locally - that's fine
      }
    });
  }

  async handleFileRenamed(payload: FileRenamedPayload): Promise<void> {
    if (this.vfsProvider) {
      const affectedTabs = this.collectTabsUnderPath(payload.oldPath);

      await this.saveDirtyTabs(affectedTabs);

      this.vfsProvider.applyFileRenamed(payload.oldPath, payload.newPath);

      await this.reopenMovedTabs(affectedTabs, payload.oldPath, payload.newPath);
      return;
    }

    // Fallback: rename on disk
    const oldUri = toAbsoluteUri(payload.oldPath);
    const newUri = toAbsoluteUri(payload.newPath);
    await this.remoteOpGuard.run([payload.oldPath, payload.newPath], async () => {
      try {
        await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
      } catch {
        // Source might not exist locally - skip
      }
    });
  }

  private async saveDirtyTabs(tabs: vscode.Tab[]): Promise<void> {
    for (const tab of tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) { continue; }
      const uri = tab.input.uri;
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      if (doc?.isDirty) {
        await doc.save();
      }
    }
  }

  private collectTabsUnderPath(relPath: string): vscode.Tab[] {
    const wsFolder = vscode.workspace.workspaceFolders?.find(
      (f) => f.uri.scheme === "pairprog"
    );
    if (!wsFolder) { return []; }

    const wsFolderPath = wsFolder.uri.path;
    const childPrefix = relPath + "/";
    const affected: vscode.Tab[] = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) { continue; }
        if (tab.input.uri.scheme !== "pairprog") { continue; }

        // Convert absolute VFS URI path to workspace-relative path
        const tabRelPath = tab.input.uri.path.slice(wsFolderPath.length + 1);
        // Match both direct children of a renamed folder AND an exact-matched renamed file
        if (tabRelPath === relPath || tabRelPath.startsWith(childPrefix)) {
          affected.push(tab);
        }
      }
    }

    return affected;
  }

  private async reopenMovedTabs(
    tabs: vscode.Tab[],
    oldRelPath: string,
    newRelPath: string
  ): Promise<void> {
    if (tabs.length === 0) { return; }

    const wsFolder = vscode.workspace.workspaceFolders?.find(
      (f) => f.uri.scheme === "pairprog"
    );
    if (!wsFolder) { return; }

    const wsFolderPath = wsFolder.uri.path;

    type Snapshot = {
      oldUriStr: string;
      newUri: vscode.Uri;
      viewColumn: vscode.ViewColumn;
      wasActive: boolean;
    };
    const snapshots: Snapshot[] = [];

    for (const tab of tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) { continue; }
      const tabRelPath = tab.input.uri.path.slice(wsFolderPath.length + 1);
      const newTabRelPath = newRelPath + tabRelPath.slice(oldRelPath.length);
      snapshots.push({
        oldUriStr: tab.input.uri.toString(),
        newUri: vscode.Uri.joinPath(wsFolder.uri, newTabRelPath),
        viewColumn: tab.group.viewColumn,
        wasActive: tab.isActive,
      });
    }

    // Open new tabs (tree is already updated so readFile works).
    for (const { newUri, viewColumn, wasActive } of snapshots) {
      await vscode.window.showTextDocument(newUri, {
        preview: false,
        preserveFocus: !wasActive,
        viewColumn,
      });
    }

    const oldUriStrings = new Set(snapshots.map(s => s.oldUriStr));
    const freshTabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText &&
            oldUriStrings.has(tab.input.uri.toString())) {
          freshTabs.push(tab);
        }
      }
    }

    if (freshTabs.length > 0) {
      await vscode.window.tabGroups.close(freshTabs);
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
