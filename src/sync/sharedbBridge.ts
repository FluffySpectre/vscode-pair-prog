import * as vscode from "vscode";
import { Connection, Doc } from "sharedb/lib/client";
import { type as otText } from "ot-text";
import { toRelativePath, toAbsoluteUri, isSyncableDocument } from "../utils/pathUtils";

type OtTextSkip = number;
type OtTextInsert = string;
type OtTextDelete = { d: number };
type OtTextComponent = OtTextSkip | OtTextInsert | OtTextDelete;
type OtTextOp = OtTextComponent[];

/**
 * ShareDBBridge connects VS Code editor events with ShareDB documents.
 */
export class ShareDBBridge implements vscode.Disposable {
  private connection: Connection;
  private docs: Map<string, Doc<string>> = new Map();
  private remoteEditGuard = 0;
  private disposables: vscode.Disposable[] = [];
  private pendingOps: Map<string, OtTextOp> = new Map();
  private batchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly BATCH_WINDOW_MS = 50;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  activate(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.onLocalDocumentChange(e);
      })
    );

    // Auto-create/subscribe ShareDB docs when files are opened mid-session
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (!isSyncableDocument(doc.uri)) {
          return;
        }
        const filePath = toRelativePath(doc.uri);
        if (!filePath) {
          return;
        }
        this.ensureDoc(filePath, doc.getText()).catch((err) => {
          console.warn(`[PairProg] Failed to ensure doc for ${filePath}:`, err);
        });
      })
    );
  }

  // Ensure a ShareDB document exists for the given file path
  async ensureDoc(filePath: string, initialContent?: string): Promise<void> {
    if (this.docs.has(filePath)) {
      return;
    }

    const doc = this.connection.get("files", filePath);
    this.docs.set(filePath, doc);

    await new Promise<void>((resolve, reject) => {
      doc.subscribe((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // If the doc doesn't exist yet and we have initial content, create it
    if (doc.type === null && initialContent !== undefined) {
      await new Promise<void>((resolve, reject) => {
        doc.create(initialContent, "http://sharejs.org/types/textv1", (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // Listen for remote operations
    doc.on("op", (op: OtTextOp, source: any) => {
      this.onRemoteOp(filePath, op, source);
    });

    // If local VS Code doc text differs from ShareDB doc, sync it
    if (doc.data !== undefined) {
      await this.syncLocalDocument(filePath, doc.data);
    }
  }

  // Remove and unsubscribe a ShareDB document (e.g., when a file is deleted/renamed)
  removeDoc(filePath: string): void {
    const doc = this.docs.get(filePath);
    if (doc) {
      doc.unsubscribe();
      doc.destroy();
      this.docs.delete(filePath);
    }
  }

  // Local edits -> ShareDB ops

  private onLocalDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (this.remoteEditGuard > 0) {
      return;
    }

    if (!isSyncableDocument(e.document.uri)) {
      return;
    }

    if (e.contentChanges.length === 0) {
      return;
    }

    const filePath = toRelativePath(e.document.uri);
    if (!filePath) {
      return;
    }

    const doc = this.docs.get(filePath);
    if (!doc || !doc.type) {
      return;
    }

    for (const change of e.contentChanges) {
      const op = this.changeToOp(doc.data, change);
      if (op.length > 0) {
        this.scheduleOp(filePath, doc, op);
      }
    }
  }

  // Convert a single VS Code content change to an ot-text op
  private changeToOp(
    preText: string,
    change: vscode.TextDocumentContentChangeEvent
  ): OtTextOp {
    const op: OtTextOp = [];

    // Skip to the change position
    if (change.rangeOffset > 0) {
      op.push(change.rangeOffset);
    }

    // Delete replaced characters
    if (change.rangeLength > 0) {
      op.push({ d: change.rangeLength });
    }

    // Insert new text
    if (change.text.length > 0) {
      op.push(change.text);
    }

    return op;
  }

  // Batch local ops before submitting to reduce round-trips

  private scheduleOp(filePath: string, doc: Doc<string>, op: OtTextOp): void {
    // Compose the new op onto any already-pending op for this file
    const existing = this.pendingOps.get(filePath);
    this.pendingOps.set(filePath, existing ? otText.compose(existing, op) : op);

    // Reset the flush timer
    const existingTimer = this.batchTimers.get(filePath);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }
    this.batchTimers.set(
      filePath,
      setTimeout(() => this.flushOp(filePath, doc), this.BATCH_WINDOW_MS)
    );
  }

  private flushOp(filePath: string, doc: Doc<string>): void {
    this.batchTimers.delete(filePath);
    const op = this.pendingOps.get(filePath);
    if (!op) { return; }
    this.pendingOps.delete(filePath);
    doc.submitOp(op, { source: true });
  }

  // Remote ShareDB ops -> VS Code WorkspaceEdits

  private async onRemoteOp(
    filePath: string,
    op: OtTextOp,
    source: any
  ): Promise<void> {
    // Skip our own ops
    if (source === true) {
      return;
    }

    const uri = toAbsoluteUri(filePath);
    let doc: vscode.TextDocument;

    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    let cursor = 0; // UTF-16 offset cursor

    for (const component of op) {
      if (typeof component === "number") {
        // Skip
        cursor += component;
      } else if (typeof component === "string") {
        // Insert at cursor position
        const pos = doc.positionAt(cursor);
        workspaceEdit.insert(uri, pos, component);
        // Don't advance cursor
      } else if (typeof component === "object" && component.d !== undefined) {
        // Delete characters at cursor
        const startPos = doc.positionAt(cursor);
        const endPos = doc.positionAt(cursor + component.d);
        workspaceEdit.delete(uri, new vscode.Range(startPos, endPos));
        cursor += component.d;
      }
    }

    this.remoteEditGuard++;
    try {
      await vscode.workspace.applyEdit(workspaceEdit);
    } finally {
      this.remoteEditGuard--;
    }
  }

  // Sync local VS Code document to match ShareDB document content. Used when client first subscribes to a document.
  private async syncLocalDocument(
    filePath: string,
    sharedbContent: string
  ): Promise<void> {
    const uri = toAbsoluteUri(filePath);
    let doc: vscode.TextDocument;

    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }

    const localContent = doc.getText();
    if (localContent === sharedbContent) {
      return;
    }

    // Replace entire document content to match ShareDB
    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(localContent.length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, sharedbContent);

    this.remoteEditGuard++;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.remoteEditGuard--;
    }
  }

  dispose(): void {
    // Cancel all pending batch timers and discard unflushed ops
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    this.pendingOps.clear();

    for (const doc of this.docs.values()) {
      doc.unsubscribe();
      doc.destroy();
    }
    this.docs.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
