import * as vscode from "vscode";
import {
  Message,
  MessageType,
  CursorUpdatePayload,
  createMessage,
} from "../network/protocol";

/**
 * CursorSync broadcasts local cursor/selection changes and renders
 * remote collaborator cursors as decorations in the editor.
 */
export class CursorSync implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private username: string;

  private cursorDecorationType: vscode.TextEditorDecorationType;
  private lineHighlightDecorationType: vscode.TextEditorDecorationType;
  private selectionDecorationType: vscode.TextEditorDecorationType;
  private usernameLabelDecorationType: vscode.TextEditorDecorationType;

  private remoteCursors: CursorUpdatePayload | null = null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 50;

  private highlightColor: string;

  constructor(
    sendFn: (msg: Message) => void,
    username: string,
    highlightColor: string
  ) {
    this.sendFn = sendFn;
    this.username = username;
    this.highlightColor = highlightColor;

    // Cursor marker
    this.cursorDecorationType = vscode.window.createTextEditorDecorationType({
      borderStyle: "solid",
      borderColor: highlightColor,
      borderWidth: "0 0 0 2px",
    });

    // Full-line highlight
    this.lineHighlightDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: highlightColor + "1A",
      isWholeLine: true,
      overviewRulerColor: highlightColor,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    // Selection highlight
    this.selectionDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: highlightColor + "33",
      borderRadius: "2px",
    });

    // Username label pinned to the right edge of the editor viewport
    this.usernameLabelDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: {
        color: new vscode.ThemeColor("editor.background"),
        backgroundColor: highlightColor,
        fontStyle: "normal",
        fontWeight: "bold",
        margin: "0 0 0 1em",
        textDecoration: "none; position: sticky; float: right; padding: 0 6px; border-radius: 3px; font-size: 0.85em;",
      },
    });
  }

  // Activation

  activate(): void {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.onLocalSelectionChange(e);
      })
    );

    // Re-apply decorations when the active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.applyRemoteDecorations();
      })
    );
  }

  // Local Selection Changes

  sendCurrentCursor(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.sendCursorUpdate(editor);
    }
  }

  private onLocalSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    // Debounce to avoid flooding the network
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.sendCursorUpdate(e.textEditor);
    }, this.DEBOUNCE_MS);
  }

  private sendCursorUpdate(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "file") {
      return;
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return; }

    const rootPath = wsFolder.uri.fsPath;
    const filePath = editor.document.uri.fsPath;
    if (!filePath.startsWith(rootPath)) { return; }

    const relativePath = filePath
      .slice(rootPath.length + 1)
      .replace(/\\/g, "/");

    const cursors = editor.selections.map((sel) => ({
      position: {
        line: sel.active.line,
        character: sel.active.character,
      },
      selection: sel.isEmpty
        ? undefined
        : {
            start: {
              line: sel.start.line,
              character: sel.start.character,
            },
            end: {
              line: sel.end.line,
              character: sel.end.character,
            },
          },
    }));

    const payload: CursorUpdatePayload = {
      filePath: relativePath,
      username: this.username,
      cursors,
    };

    this.sendFn(createMessage(MessageType.CursorUpdate, payload));
  }

  // Handle Remote Cursor Updates

  handleRemoteCursorUpdate(payload: CursorUpdatePayload): void {
    this.remoteCursors = payload;
    this.applyRemoteDecorations();
  }

  // Render Decorations

  private applyRemoteDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.remoteCursors) {
      return;
    }

    // Check if this editor shows the same file as the remote cursor
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return; }

    const currentFilePath = editor.document.uri.fsPath
      .slice(wsFolder.uri.fsPath.length + 1)
      .replace(/\\/g, "/");

    if (currentFilePath !== this.remoteCursors.filePath) {
      // Remote cursor is in a different file — clear decorations
      editor.setDecorations(this.cursorDecorationType, []);
      editor.setDecorations(this.lineHighlightDecorationType, []);
      editor.setDecorations(this.selectionDecorationType, []);
      editor.setDecorations(this.usernameLabelDecorationType, []);
      return;
    }

    const cursorDecorations: vscode.DecorationOptions[] = [];
    const lineHighlightDecorations: vscode.DecorationOptions[] = [];
    const selectionDecorations: vscode.DecorationOptions[] = [];
    const usernameLabelDecorations: vscode.DecorationOptions[] = [];

    for (const cursor of this.remoteCursors.cursors) {
      // Cursor position decoration
      const pos = new vscode.Position(
        cursor.position.line,
        cursor.position.character
      );

      cursorDecorations.push({
        range: new vscode.Range(pos, pos),
      });

      // Highlight the entire line the remote cursor is on
      const lineRange = editor.document.lineAt(cursor.position.line).range;
      lineHighlightDecorations.push({
        range: lineRange,
      });

      // Username label pinned to the right edge of the line
      usernameLabelDecorations.push({
        range: lineRange,
        renderOptions: {
          after: {
            contentText: this.remoteCursors.username,
          },
        },
      });

      // Selection decoration
      if (cursor.selection) {
        const start = new vscode.Position(
          cursor.selection.start.line,
          cursor.selection.start.character
        );
        const end = new vscode.Position(
          cursor.selection.end.line,
          cursor.selection.end.character
        );
        selectionDecorations.push({
          range: new vscode.Range(start, end),
        });
      }
    }

    editor.setDecorations(this.cursorDecorationType, cursorDecorations);
    editor.setDecorations(this.lineHighlightDecorationType, lineHighlightDecorations);
    editor.setDecorations(this.selectionDecorationType, selectionDecorations);
    editor.setDecorations(this.usernameLabelDecorationType, usernameLabelDecorations);
  }

  // Clear

  clearDecorations(): void {
    this.remoteCursors = null;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.cursorDecorationType, []);
      editor.setDecorations(this.lineHighlightDecorationType, []);
      editor.setDecorations(this.selectionDecorationType, []);
      editor.setDecorations(this.usernameLabelDecorationType, []);
    }
  }

  // Dispose

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.clearDecorations();
    this.cursorDecorationType.dispose();
    this.lineHighlightDecorationType.dispose();
    this.selectionDecorationType.dispose();
    this.usernameLabelDecorationType.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
