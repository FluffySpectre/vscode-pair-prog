import * as vscode from "vscode";
import {
  Message,
  MessageType,
  CursorUpdatePayload,
  FollowUpdatePayload,
  createMessage,
} from "../network/protocol";

/**
 * CursorSync broadcasts local cursor/selection changes and renders
 * remote partner cursors as decorations in the editor.
 */
export class CursorSync implements vscode.Disposable, vscode.FileDecorationProvider {
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private username: string;

  private cursorDecorationType: vscode.TextEditorDecorationType;
  private lineHighlightDecorationType: vscode.TextEditorDecorationType;
  private selectionDecorationType: vscode.TextEditorDecorationType;
  private usernameLabelDecorationType: vscode.TextEditorDecorationType;

  private remoteCursors: CursorUpdatePayload | null = null;
  private remoteFileUri: vscode.Uri | null = null;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 50;

  private highlightColor: string;

  // Follow mode
  private following = false;
  private remoteIsFollowing = false;
  private followActionGuard = false;
  private remoteUsername: string | null = null;

  private readonly _onDidChangeFollowMode = new vscode.EventEmitter<boolean>();
  readonly onDidChangeFollowMode = this._onDidChangeFollowMode.event;

  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

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

    // Register file decoration provider for tab badges
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this)
    );
  }

  // FileDecorationProvider

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.remoteFileUri || !this.remoteCursors) {
      return undefined;
    }

    if (uri.toString() !== this.remoteFileUri.toString()) {
      return undefined;
    }

    const name = this.remoteCursors.username;

    if (this.following || this.remoteIsFollowing) {
      const tooltip = this.following
        ? `Following ${name}`
        : `${name} is following you`;
      return {
        badge: "👁",
        tooltip,
      };
    }

    return {
      badge: "👤",
      tooltip: `${name} is editing this file`,
    };
  }

  // Local Selection Changes

  sendCurrentCursor(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      this.sendCursorUpdate(editor);
    }
  }

  private onLocalSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    // Auto-disable follow mode on user-initiated cursor movement
    if (this.following && !this.followActionGuard) {
      const isUserAction =
        e.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
        e.kind === vscode.TextEditorSelectionChangeKind.Mouse;
      if (isUserAction) {
        this.setFollowing(false);
      }
    }

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
    this.remoteUsername = payload.username;
    this.applyRemoteDecorations();
    this.updateFileTabDecoration(payload.filePath);

    if (this.following) {
      this.followRemoteCursor(payload);
    }
  }

  // Follow Mode

  toggleFollow(): boolean {
    this.setFollowing(!this.following);
    return this.following;
  }

  isFollowing(): boolean {
    return this.following;
  }

  getRemoteUsername(): string | null {
    return this.remoteUsername;
  }

  private setFollowing(value: boolean): void {
    if (this.following === value) { return; }
    this.following = value;
    this._onDidChangeFollowMode.fire(value);

    // Tell the remote side that we started/stopped following them
    const payload: FollowUpdatePayload = {
      following: value,
      username: this.username,
    };
    this.sendFn(createMessage(MessageType.FollowUpdate, payload));

    // Refresh the tab badge so it switches between 👤 and 👁
    if (this.remoteFileUri) {
      this._onDidChangeFileDecorations.fire([this.remoteFileUri]);
    }
  }

  handleRemoteFollowUpdate(payload: FollowUpdatePayload): void {
    this.remoteIsFollowing = payload.following;

    // Refresh tab badge to reflect that the remote user is now following us
    if (this.remoteFileUri) {
      this._onDidChangeFileDecorations.fire([this.remoteFileUri]);
    }
  }

  private async followRemoteCursor(payload: CursorUpdatePayload): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder || payload.cursors.length === 0) { return; }

    const targetUri = vscode.Uri.joinPath(wsFolder.uri, payload.filePath);
    const cursor = payload.cursors[0];
    const targetPos = new vscode.Position(cursor.position.line, cursor.position.character);
    const targetRange = new vscode.Range(targetPos, targetPos);

    this.followActionGuard = true;
    try {
      const editor = await vscode.window.showTextDocument(targetUri, {
        preview: false,
        preserveFocus: false,
      });
      editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);
    } catch {
      // File might not be available yet — ignore
    } finally {
      // Release guard on next tick so the selection change event from
      // showTextDocument / revealRange is suppressed
      setTimeout(() => {
        this.followActionGuard = false;
      }, 0);
    }
  }

  private updateFileTabDecoration(relativePath: string): void {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) { return; }

    const newUri = vscode.Uri.joinPath(wsFolder.uri, relativePath);
    const urisToRefresh: vscode.Uri[] = [];

    // Clear decoration from the old file so the badge is removed
    if (this.remoteFileUri && this.remoteFileUri.toString() !== newUri.toString()) {
      urisToRefresh.push(this.remoteFileUri);
    }

    this.remoteFileUri = newUri;
    urisToRefresh.push(newUri);

    this._onDidChangeFileDecorations.fire(urisToRefresh);
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
    // Disable follow mode
    this.setFollowing(false);

    // Clear tab decoration for the remote file
    const urisToRefresh: vscode.Uri[] = [];
    if (this.remoteFileUri) { urisToRefresh.push(this.remoteFileUri); }

    this.remoteCursors = null;
    this.remoteFileUri = null;
    this.remoteUsername = null;
    this.remoteIsFollowing = false;

    if (urisToRefresh.length > 0) {
      this._onDidChangeFileDecorations.fire(urisToRefresh);
    }

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
    this._onDidChangeFollowMode.dispose();
    this._onDidChangeFileDecorations.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
