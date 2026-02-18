import * as vscode from "vscode";
import {
  Message,
  MessageType,
  EditPayload,
  FullSyncPayload,
  OpenFilePayload,
  TextChange,
  createMessage,
} from "../network/protocol";

/**
 * DocumentSync handles real-time text synchronization between host and client.
 *
 * Core mechanics:
 * - Tracks a version number per file (increments on every applied edit)
 * - Intercepts local edits and sends them to the remote side
 * - Applies incoming remote edits via WorkspaceEdit API
 * - Uses a guard flag to prevent echo loops (remote edit → listener → re-send)
 * - Basic positional OT when versions diverge
 */
export class DocumentSync implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private isHost: boolean;
  private workspaceRoot: string;
  private fileVersions: Map<string, number> = new Map();
  private remoteEditGuard = 0; // Guard counter to suppress re-sending remote edits
  private editHistory: Map<string, Array<{ version: number; changes: TextChange[] }>> = new Map();
  private readonly MAX_HISTORY_PER_FILE = 100;

  constructor(
    sendFn: (msg: Message) => void,
    isHost: boolean,
    workspaceRoot: string
  ) {
    this.sendFn = sendFn;
    this.isHost = isHost;
    this.workspaceRoot = workspaceRoot;
  }

  // Activation

  activate(): void {
    // Listen for local text changes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.onLocalDocumentChange(e);
      })
    );

    // Listen for file open (to request sync)
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (!this.isHost) {
          const filePath = this.toRelativePath(doc.uri);
          if (filePath) {
            this.sendFn(
              createMessage(MessageType.OpenFile, { filePath } as OpenFilePayload)
            );
          }
        }
      })
    );
  }

  // Handle Local Edits

  private onLocalDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    // Skip if this change came from applying a remote edit
    if (this.remoteEditGuard > 0) {
      return;
    }

    // Skip non-file schemes (output panels, git, etc.)
    if (e.document.uri.scheme !== "file") {
      return;
    }

    // Skip if no actual content changes
    if (e.contentChanges.length === 0) {
      return;
    }

    const filePath = this.toRelativePath(e.document.uri);
    if (!filePath) {
      return;
    }

    const version = this.getVersion(filePath);

    const changes: TextChange[] = e.contentChanges.map((change) => ({
      rangeOffset: change.rangeOffset,
      rangeLength: change.rangeLength,
      text: change.text,
    }));

    // Record in history (host only)
    if (this.isHost) {
      this.recordEdit(filePath, version, changes);
    }

    this.incrementVersion(filePath);

    // Send edit to remote
    const payload: EditPayload = { filePath, version, changes };
    this.sendFn(createMessage(MessageType.Edit, payload));
  }

  // Handle Remote Edits

  async handleRemoteEdit(payload: EditPayload): Promise<void> {
    const { filePath, version, changes } = payload;

    const currentVersion = this.getVersion(filePath);
    let transformedChanges = changes;

    // If the host receives an edit based on an old version, transform it!
    if (this.isHost && version < currentVersion) {
      transformedChanges = this.transformChanges(filePath, version, changes);
    }

    // Find the document
    const uri = this.toAbsoluteUri(filePath);
    let doc: vscode.TextDocument;

    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      // File might not exist locally (client side) - skip
      return;
    }

    // Build a WorkspaceEdit from the changes
    const workspaceEdit = new vscode.WorkspaceEdit();

    for (const change of transformedChanges) {
      const startPos = doc.positionAt(change.rangeOffset);
      const endPos = doc.positionAt(change.rangeOffset + change.rangeLength);
      const range = new vscode.Range(startPos, endPos);

      workspaceEdit.replace(uri, range, change.text);
    }

    // Apply with guard to prevent echo - increment before, decrement on next tick
    this.remoteEditGuard++;
    try {
      await vscode.workspace.applyEdit(workspaceEdit);

      // If host: record this edit in history for OT
      if (this.isHost) {
        this.recordEdit(filePath, currentVersion, transformedChanges);
      }

      // Both sides increment version to stay in sync
      this.incrementVersion(filePath);
    } finally {
      setTimeout(() => {
        this.remoteEditGuard--;
      }, 0);
    }
  }

  // Full Sync

  sendFullSync(filePath: string, content: string): void {
    const version = this.getVersion(filePath);
    const payload: FullSyncPayload = { filePath, content, version };
    this.sendFn(createMessage(MessageType.FullSync, payload));
  }

  async handleFullSync(payload: FullSyncPayload): Promise<void> {
    const { filePath, content, version } = payload;

    this.fileVersions.set(filePath, version);

    const uri = this.toAbsoluteUri(filePath);

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      // File doesn't exist on client - skip for now
      // (file ops sync handles creation)
      return;
    }

    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, content);

    this.remoteEditGuard++;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      setTimeout(() => {
        this.remoteEditGuard--;
      }, 0);
    }
  }

  // Handle OpenFile request (host side)

  async handleOpenFileRequest(payload: OpenFilePayload): Promise<void> {
    const uri = this.toAbsoluteUri(payload.filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      this.sendFullSync(payload.filePath, doc.getText());
    } catch {
      // File doesn't exist on host - ignore
    }
  }

  // Transform changes against edit history

  private transformChanges(
    filePath: string,
    baseVersion: number,
    changes: TextChange[]
  ): TextChange[] {
    const history = this.editHistory.get(filePath) || [];

    // Get all edits that happened between baseVersion and now
    const intervening = history.filter((h) => h.version >= baseVersion);

    let transformed = [...changes];

    for (const past of intervening) {
      for (const pastChange of past.changes) {
        transformed = transformed.map((c) => this.transformSingle(c, pastChange));
      }
    }

    return transformed;
  }

  private transformSingle(incoming: TextChange, prior: TextChange): TextChange {
    const priorEnd = prior.rangeOffset + prior.rangeLength;
    const shift = prior.text.length - prior.rangeLength;

    if (incoming.rangeOffset >= priorEnd) {
      // Incoming is entirely after the prior change - shift offset
      return {
        ...incoming,
        rangeOffset: incoming.rangeOffset + shift,
      };
    }

    if (incoming.rangeOffset + incoming.rangeLength <= prior.rangeOffset) {
      // Incoming is entirely before - no change needed
      return incoming;
    }

    // Overlapping edits - host wins, adjust incoming to apply after prior
    return {
      ...incoming,
      rangeOffset: priorEnd + shift,
      rangeLength: 0, // insert only (don't delete what host already changed)
    };
  }

  // Edit History

  private recordEdit(filePath: string, version: number, changes: TextChange[]): void {
    if (!this.editHistory.has(filePath)) {
      this.editHistory.set(filePath, []);
    }
    const history = this.editHistory.get(filePath)!;
    history.push({ version, changes });

    // Prune old history
    if (history.length > this.MAX_HISTORY_PER_FILE) {
      history.splice(0, history.length - this.MAX_HISTORY_PER_FILE);
    }
  }

  // Version Tracking

  private getVersion(filePath: string): number {
    return this.fileVersions.get(filePath) || 0;
  }

  private incrementVersion(filePath: string): void {
    this.fileVersions.set(filePath, this.getVersion(filePath) + 1);
  }

  // Path Utilities

  private toRelativePath(uri: vscode.Uri): string | null {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return null; }

    const rootPath = wsFolder.uri.fsPath;
    const filePath = uri.fsPath;

    if (!filePath.startsWith(rootPath)) {
      return null;
    }

    // Return workspace-relative path with forward slashes
    return filePath.slice(rootPath.length + 1).replace(/\\/g, "/");
  }

  toAbsoluteUri(relativePath: string): vscode.Uri {
    const wsFolder = vscode.workspace.workspaceFolders![0];
    return vscode.Uri.joinPath(wsFolder.uri, relativePath);
  }

  // Dispose

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.fileVersions.clear();
    this.editHistory.clear();
  }
}
