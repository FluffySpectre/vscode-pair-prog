import * as vscode from "vscode";
import { GitFileStatus } from "../network/protocol";
import { toRelativePath } from "../utils/pathUtils";
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";

export interface CursorDecorationState {
  following: boolean;
  remoteIsFollowing: boolean;
  remoteUsername: string | null;
  remoteFileUri: vscode.Uri | null;
  localFileUri: vscode.Uri | null;
}

const EMPTY_CURSOR_STATE: CursorDecorationState = {
  following: false,
  remoteIsFollowing: false,
  remoteUsername: null,
  remoteFileUri: null,
  localFileUri: null,
};

export class SessionDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private gitStatuses = new Map<string, GitFileStatus>();
  private cursorState: CursorDecorationState = EMPTY_CURSOR_STATE;

  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.provideGitDecoration(uri) ?? this.provideCursorDecoration(uri);
  }

  setGitStatuses(statuses: ReadonlyMap<string, GitFileStatus>): void {
    this.gitStatuses = new Map(statuses);
    this._onDidChangeFileDecorations.fire(undefined);
  }

  clearGitStatuses(): void {
    if (this.gitStatuses.size === 0) {
      return;
    }
    this.gitStatuses.clear();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  setCursorState(nextState: CursorDecorationState): void {
    const previousUris = this.collectCursorUris(this.cursorState);
    const nextUris = this.collectCursorUris(nextState);
    this.cursorState = nextState;

    const toRefresh = new Map<string, vscode.Uri>();
    for (const uri of previousUris) {
      toRefresh.set(uri.toString(), uri);
    }
    for (const uri of nextUris) {
      toRefresh.set(uri.toString(), uri);
    }

    if (toRefresh.size > 0) {
      this._onDidChangeFileDecorations.fire(Array.from(toRefresh.values()));
    }
  }

  clearCursorState(): void {
    this.setCursorState(EMPTY_CURSOR_STATE);
  }

  dispose(): void {
    this.gitStatuses.clear();
    this.cursorState = EMPTY_CURSOR_STATE;
    this._onDidChangeFileDecorations.dispose();
  }

  private provideGitDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== PairProgFileSystemProvider.SCHEME) {
      return undefined;
    }

    const relativePath = toRelativePath(uri);
    if (!relativePath) {
      return undefined;
    }

    const status = this.gitStatuses.get(relativePath);
    if (!status) {
      return undefined;
    }

    switch (status) {
      case "modified":
        return {
          badge: "M",
          tooltip: "Modified",
          color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
          propagate: true,
        };

      case "added":
        return {
          badge: "A",
          tooltip: "Added",
          color: new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
          propagate: true,
        };

      case "deleted":
        return {
          badge: "D",
          tooltip: "Deleted",
          color: new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
          propagate: true,
        };

      case "renamed":
        return {
          badge: "R",
          tooltip: "Renamed",
          color: new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
          propagate: true,
        };

      case "untracked":
        return {
          badge: "U",
          tooltip: "Untracked",
          color: new vscode.ThemeColor("gitDecoration.untrackedResourceForeground"),
          propagate: true,
        };

      case "conflict":
        return {
          badge: "C",
          tooltip: "Conflict",
          color: new vscode.ThemeColor("gitDecoration.conflictingResourceForeground"),
          propagate: true,
        };
    }
  }

  private provideCursorDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const uriStr = uri.toString();
    const name = this.cursorState.remoteUsername ?? "Remote";

    if (this.cursorState.remoteIsFollowing &&
        this.cursorState.localFileUri &&
        uriStr === this.cursorState.localFileUri.toString()) {
      return {
        badge: "👀",
        tooltip: `${name} is following you`,
      };
    }

    if (this.cursorState.remoteFileUri &&
        uriStr === this.cursorState.remoteFileUri.toString()) {
      if (this.cursorState.following) {
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

  private collectCursorUris(state: CursorDecorationState): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    if (state.remoteFileUri) {
      uris.push(state.remoteFileUri);
    }
    if (state.localFileUri) {
      uris.push(state.localFileUri);
    }
    return uris;
  }
}
