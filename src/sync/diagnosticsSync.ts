import * as vscode from "vscode";
import {
  Message,
  MessageType,
  MessageHandler,
  DiagnosticsUpdatePayload,
  SerializedDiagnostic,
  createMessage,
} from "../network/protocol";
import { toRelativePath, toAbsoluteUri } from "../utils/pathUtils";

/**
 * DiagnosticsSync forwards diagnostics (errors, warnings) from the host 
 * to the client so they appear on vfs files
 */
export class DiagnosticsSync implements vscode.Disposable, MessageHandler {
  readonly messageTypes: string[];
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private isHost: boolean;

  // Host-side state
  private pendingUris = new Map<string, vscode.Uri>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;

  // Client-side state
  private diagnosticCollection: vscode.DiagnosticCollection | null = null;

  constructor(sendFn: (msg: Message) => void, isHost: boolean) {
    this.sendFn = sendFn;
    this.isHost = isHost;
    this.messageTypes = isHost ? [] : [MessageType.DiagnosticsUpdate as string];
  }

  // Activation

  activate(): void {
    if (this.isHost) {
      this.disposables.push(
        vscode.languages.onDidChangeDiagnostics((e) => {
          this.onDiagnosticsChanged(e.uris);
        })
      );
    } else {
      this.diagnosticCollection = vscode.languages.createDiagnosticCollection("pairprog-remote");
    }
  }

  // MessageHandler (client-side only)

  handleMessage(msg: Message): void {
    if (msg.type === MessageType.DiagnosticsUpdate) {
      this.applyDiagnostics(msg.payload as DiagnosticsUpdatePayload);
    }
  }

  // Host: send full snapshot of all current diagnostics

  sendFullSnapshot(): void {
    const allDiagnostics = vscode.languages.getDiagnostics();
    const files: DiagnosticsUpdatePayload["files"] = [];

    for (const [uri, diagnostics] of allDiagnostics) {
      if (uri.scheme !== "file") { continue; }
      const relativePath = toRelativePath(uri);
      if (!relativePath) { continue; }
      if (diagnostics.length === 0) { continue; }

      files.push({
        filePath: relativePath,
        diagnostics: diagnostics.map((d) => this.serializeDiagnostic(d)),
      });
    }

    if (files.length > 0) {
      this.sendFn(createMessage(MessageType.DiagnosticsUpdate, { files } as DiagnosticsUpdatePayload));
    }
  }

  // Host: handle diagnostic change events

  private onDiagnosticsChanged(uris: readonly vscode.Uri[]): void {
    for (const uri of uris) {
      if (uri.scheme !== "file") { continue; }
      const relativePath = toRelativePath(uri);
      if (!relativePath) { continue; }
      this.pendingUris.set(relativePath, uri);
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.sendPendingDiagnostics();
    }, this.DEBOUNCE_MS);
  }

  private sendPendingDiagnostics(): void {
    if (this.pendingUris.size === 0) { return; }

    const files: DiagnosticsUpdatePayload["files"] = [];

    for (const [relativePath, uri] of this.pendingUris) {
      const diagnostics = vscode.languages.getDiagnostics(uri);
      files.push({
        filePath: relativePath,
        diagnostics: diagnostics.map((d) => this.serializeDiagnostic(d)),
      });
    }

    this.pendingUris.clear();
    this.sendFn(createMessage(MessageType.DiagnosticsUpdate, { files } as DiagnosticsUpdatePayload));
  }

  // Host: serialize a vscode.Diagnostic

  private serializeDiagnostic(d: vscode.Diagnostic): SerializedDiagnostic {
    const result: SerializedDiagnostic = {
      range: {
        startLine: d.range.start.line,
        startCharacter: d.range.start.character,
        endLine: d.range.end.line,
        endCharacter: d.range.end.character,
      },
      message: d.message,
      severity: d.severity,
    };

    if (d.source) {
      result.source = d.source;
    }

    if (d.code !== undefined) {
      // d.code can be string | number | { value: string|number, target: Uri }
      if (typeof d.code === "object" && d.code !== null) {
        result.code = (d.code as { value: string | number }).value;
      } else {
        result.code = d.code as string | number;
      }
    }

    if (d.tags && d.tags.length > 0) {
      result.tags = [...d.tags];
    }

    return result;
  }

  // Client: apply received diagnostics

  private applyDiagnostics(payload: DiagnosticsUpdatePayload): void {
    if (!this.diagnosticCollection) { return; }

    for (const file of payload.files) {
      const uri = toAbsoluteUri(file.filePath);

      const diagnostics = file.diagnostics.map((d) => {
        const range = new vscode.Range(
          d.range.startLine, d.range.startCharacter,
          d.range.endLine, d.range.endCharacter,
        );
        const diagnostic = new vscode.Diagnostic(range, d.message, d.severity);

        if (d.source) {
          diagnostic.source = d.source;
        }
        if (d.code !== undefined) {
          diagnostic.code = d.code;
        }
        if (d.tags && d.tags.length > 0) {
          diagnostic.tags = d.tags;
        }

        return diagnostic;
      });

      this.diagnosticCollection.set(uri, diagnostics);
    }
  }

  // Dispose

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingUris.clear();
    this.diagnosticCollection?.clear();
    this.diagnosticCollection?.dispose();
    this.diagnosticCollection = null;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
