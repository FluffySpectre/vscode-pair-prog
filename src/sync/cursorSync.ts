import * as vscode from "vscode";
import {
  Message,
  MessageType,
  CursorUpdatePayload,
  FollowUpdatePayload,
  createMessage,
} from "../network/protocol";
import { toRelativePath, toAbsoluteUri, isSyncableDocument } from "../utils/pathUtils";

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
  private remoteFileUri: vscode.Uri | null = null;   // file the remote user is editing
  private localFileUri: vscode.Uri | null = null;    // our own active file (for "being followed" badge)

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 150;
  private followActionGuardTimer: ReturnType<typeof setTimeout> | null = null;

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
        textDecoration: "none; padding: 0 6px; border-radius: 3px; font-size: 0.85em;",
      },
    });
  }

  // Activation

  activate(): void {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this.onLocalSelectionChange(e);
        }
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
    const uriStr = uri.toString();
    const name = this.remoteCursors?.username ?? this.remoteUsername ?? "Remote";

    if (this.remoteIsFollowing && this.localFileUri && uriStr === this.localFileUri.toString()) {
      return {
        badge: "👀",
        tooltip: `${name} is following you`,
      };
    }

    // Remote user badge: show on the file the remote user is currently editing
    if (this.remoteFileUri && uriStr === this.remoteFileUri.toString() && this.remoteCursors) {
      if (this.following) {
        return {
          badge: "👀",
          tooltip: `Following ${name}`,
        };
      }
      return {
        badge: "👤",
        tooltip: `${name} is editing this file`,
      };
    }

    return undefined;
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
    if (!isSyncableDocument(editor.document.uri)) {
      return;
    }

    const relativePath = toRelativePath(editor.document.uri);
    if (!relativePath) { return; }

    // Track our own active file so we can show the "being followed" badge on it
    this.updateLocalFileUri(editor.document.uri);

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

    // Refresh tab badges: remote file (follower side) + local file (followed side)
    const toRefresh: vscode.Uri[] = [];
    if (this.remoteFileUri) { toRefresh.push(this.remoteFileUri); }
    if (this.localFileUri) { toRefresh.push(this.localFileUri); }
    if (toRefresh.length > 0) {
      this._onDidChangeFileDecorations.fire(toRefresh);
    }
  }

  handleRemoteFollowUpdate(payload: FollowUpdatePayload): void {
    this.remoteIsFollowing = payload.following;

    // Refresh our own active file's badge to show/hide the "being followed" 👁
    if (this.localFileUri) {
      this._onDidChangeFileDecorations.fire([this.localFileUri]);
    }
  }

  private updateLocalFileUri(uri: vscode.Uri): void {
    const prev = this.localFileUri;
    this.localFileUri = uri;

    if (!this.remoteIsFollowing) { return; }

    // Fire refresh on old and new file so badge moves with us
    const toRefresh: vscode.Uri[] = [];
    if (prev && prev.toString() !== uri.toString()) {
      toRefresh.push(prev);
    }
    toRefresh.push(uri);
    this._onDidChangeFileDecorations.fire(toRefresh);
  }

  private async followRemoteCursor(payload: CursorUpdatePayload): Promise<void> {
    if (payload.cursors.length === 0) { return; }

    const targetUri = toAbsoluteUri(payload.filePath);
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
      // File might not be available yet - ignore
    } finally {
      // Release guard on next tick so the selection change event from
      // showTextDocument / revealRange is suppressed
      if (this.followActionGuardTimer) {
        clearTimeout(this.followActionGuardTimer);
      }
      this.followActionGuardTimer = setTimeout(() => {
        this.followActionGuard = false;
        this.followActionGuardTimer = null;
      }, 0);
    }
  }

  private updateFileTabDecoration(relativePath: string): void {
    const newUri = toAbsoluteUri(relativePath);
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
    const currentFilePath = toRelativePath(editor.document.uri);
    if (currentFilePath !== this.remoteCursors.filePath) {
      // Remote cursor is in a different file - clear decorations
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
      // Skip invalid cursor positions
      if (cursor.position.line >= editor.document.lineCount) {
        continue;
      }

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

    // Clear tab decorations for remote file and our own file
    const urisToRefresh: vscode.Uri[] = [];
    if (this.remoteFileUri) { urisToRefresh.push(this.remoteFileUri); }
    if (this.localFileUri) { urisToRefresh.push(this.localFileUri); }

    this.remoteCursors = null;
    this.remoteFileUri = null;
    this.localFileUri = null;
    this.remoteUsername = null;
    this.remoteIsFollowing = false;

    if (urisToRefresh.length > 0) {
      this._onDidChangeFileDecorations.fire(urisToRefresh);
    }

    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.cursorDecorationType, []);
      ed.setDecorations(this.lineHighlightDecorationType, []);
      ed.setDecorations(this.selectionDecorationType, []);
      ed.setDecorations(this.usernameLabelDecorationType, []);
    }
  }

  // Dispose

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.followActionGuardTimer) {
      clearTimeout(this.followActionGuardTimer);
      this.followActionGuardTimer = null;
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
