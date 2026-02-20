import * as vscode from "vscode";

interface TreeEntry {
  type: vscode.FileType;
  size: number;
  mtime: number;
  content?: Uint8Array;
}

/**
 * Virtual filesystem provider for the client side of a pair programming session.
 * Backed entirely by WebSocket messages - no local files are created.
 *
 * The host sends a DirectoryTree on connection. File contents are lazy-loaded
 * via `contentRequester` when a file is opened. Real-time edits flow through
 * ShareDB; this provider only handles the initial read and Explorer tree.
 */
export class PairProgFileSystemProvider implements vscode.FileSystemProvider {
  private tree = new Map<string, TreeEntry>();
  private contentRequester: ((path: string) => Promise<Uint8Array>) | null = null;

  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  setContentRequester(fn: (path: string) => Promise<Uint8Array>): void {
    this.contentRequester = fn;
  }

  // Tree management

  populateTree(entries: Array<{ path: string; type: "file" | "directory"; size: number; mtime: number }>): void {
    this.tree.clear();

    // Always add the root directory
    this.tree.set("/", {
      type: vscode.FileType.Directory,
      size: 0,
      mtime: Date.now(),
    });

    for (const entry of entries) {
      const normalizedPath = "/" + entry.path;
      this.tree.set(normalizedPath, {
        type: entry.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
        size: entry.size,
        mtime: entry.mtime,
      });
    }
  }

  applyFileCreated(relativePath: string, content: string): void {
    const normalizedPath = "/" + relativePath;

    // Ensure parent directories exist
    this.ensureParentDirs(normalizedPath);

    this.tree.set(normalizedPath, {
      type: vscode.FileType.File,
      size: content.length,
      mtime: Date.now(),
      content: new TextEncoder().encode(content),
    });

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Created, uri: this.pathToUri(normalizedPath) },
    ]);
  }

  applyFileDeleted(relativePath: string): void {
    const normalizedPath = "/" + relativePath;
    this.tree.delete(normalizedPath);

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Deleted, uri: this.pathToUri(normalizedPath) },
    ]);
  }

  applyFileRenamed(oldRelativePath: string, newRelativePath: string): void {
    const oldPath = "/" + oldRelativePath;
    const newPath = "/" + newRelativePath;
    const childPrefix = oldPath + "/";

    const toMove: [string, TreeEntry][] = [];
    for (const [entryPath, entry] of this.tree) {
      if (entryPath === oldPath || entryPath.startsWith(childPrefix)) {
        toMove.push([entryPath, entry]);
      }
    }

    for (const [entryPath, entry] of toMove) {
      this.tree.delete(entryPath);
      const newEntryPath = newPath + entryPath.slice(oldPath.length);
      this.tree.set(newEntryPath, entry);
    }

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath) },
      { type: vscode.FileChangeType.Created, uri: this.pathToUri(newPath) },
    ]);
  }

  updateContent(relativePath: string, content: Uint8Array): void {
    const normalizedPath = "/" + relativePath;
    const entry = this.tree.get(normalizedPath);
    if (entry) {
      entry.content = content;
      entry.size = content.length;
      entry.mtime = Date.now();
    }
  }

  fireChanged(relativePath: string): void {
    const normalizedPath = "/" + relativePath;
    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Changed, uri: this.pathToUri(normalizedPath) },
    ]);
  }

  clear(): void {
    this.tree.clear();
    this.contentRequester = null;
  }

  // FileSystemProvider implementation

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.lookupEntry(uri);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: entry.type,
      ctime: entry.mtime,
      mtime: entry.mtime,
      size: entry.size,
    };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const dirPath = this.uriToPath(uri);
    const prefix = dirPath === "/" ? "/" : dirPath + "/";
    const result: [string, vscode.FileType][] = [];

    for (const [entryPath, entry] of this.tree) {
      if (entryPath === dirPath) {
        continue; // skip the directory itself
      }
      if (!entryPath.startsWith(prefix)) {
        continue;
      }
      // Only direct children (no further slashes after prefix)
      const remainder = entryPath.slice(prefix.length);
      if (remainder.includes("/")) {
        continue;
      }
      result.push([remainder, entry.type]);
    }

    return result;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const entryPath = this.uriToPath(uri);
    const entry = this.tree.get(entryPath);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    // Return cached content if available
    if (entry.content) {
      return entry.content;
    }

    // Lazy-load from host
    if (this.contentRequester) {
      const relativePath = entryPath.slice(1); // remove leading /
      const content = await this.contentRequester(relativePath);
      entry.content = content;
      entry.size = content.length;
      return content;
    }

    // No content and no requester - return empty
    return new Uint8Array(0);
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
    const entryPath = this.uriToPath(uri);

    // Update in-memory cache only - host is source of truth
    const existing = this.tree.get(entryPath);
    if (existing) {
      existing.content = content;
      existing.size = content.length;
      existing.mtime = Date.now();
    } else if (options.create) {
      throw vscode.FileSystemError.NoPermissions("File creation must be performed on the host.");
    }
  }

  delete(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions("File deletion must be performed on the host.");
  }

  rename(_oldUri: vscode.Uri, _newUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions("File renaming must be performed on the host.");
  }

  createDirectory(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions("Directory creation must be performed on the host.");
  }

  watch(): vscode.Disposable {
    // Changes come from WebSocket, not filesystem watching
    return new vscode.Disposable(() => {});
  }

  // Helpers

  /**
   * Get the workspace name (first path segment). Used to construct the workspace folder URI.
   */
  get workspaceName(): string | null {
    for (const path of this.tree.keys()) {
      if (path === "/") { continue; }
      // The first segment after root
      const parts = path.split("/").filter(Boolean);
      if (parts.length > 0) {
        return parts[0];
      }
    }
    return null;
  }

  private lookupEntry(uri: vscode.Uri): TreeEntry | undefined {
    return this.tree.get(this.uriToPath(uri));
  }

  private uriToPath(uri: vscode.Uri): string {
    // uri.path is e.g. "/workspace-name/src/file.ts"
    // We need the path relative to the workspace name, so strip the first segment
    const fullPath = uri.path;
    const firstSlash = fullPath.indexOf("/", 1);
    if (firstSlash === -1) {
      return "/"; // root
    }
    return fullPath.slice(firstSlash) || "/";
  }

  private pathToUri(normalizedPath: string): vscode.Uri {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder || wsFolder.uri.scheme !== "pairprog") {
      // Fallback - shouldn't happen in normal flow
      return vscode.Uri.parse("pairprog:/" + normalizedPath);
    }
    return vscode.Uri.joinPath(wsFolder.uri, normalizedPath);
  }

  private ensureParentDirs(filePath: string): void {
    const parts = filePath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      if (!this.tree.has(current)) {
        this.tree.set(current, {
          type: vscode.FileType.Directory,
          size: 0,
          mtime: Date.now(),
        });
      }
    }
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
    this.clear();
  }
}
