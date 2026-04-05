import * as vscode from "vscode";
import {
  GitOriginalContentRequestPayload,
  GitOriginalContentResponsePayload,
  GitStatusFileEntry,
} from "../network/protocol";
import { toRelativePath } from "../utils/pathUtils";
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";

type PendingContentRequest = {
  promise: Promise<string>;
  resolve: (content: string) => void;
};

export class RemoteGitQuickDiffController
  implements vscode.QuickDiffProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly CONTENT_SCHEME = "pairprog-git";

  private readonly sourceControl: vscode.SourceControl;
  private readonly entries = new Map<string, GitStatusFileEntry>();
  private readonly contentCache = new Map<string, string>();
  private readonly pendingRequests = new Map<string, PendingContentRequest>();
  private requestSender: ((payload: GitOriginalContentRequestPayload) => void) | null = null;

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(workspaceRoot: vscode.Uri) {
    this.sourceControl = vscode.scm.createSourceControl(
      "pairprogGit",
      "PairProg Git",
      workspaceRoot,
    );
    this.sourceControl.quickDiffProvider = this;
    this.sourceControl.count = 0;
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.inputBox.enabled = false;
  }

  setRequestSender(sender: (payload: GitOriginalContentRequestPayload) => void): void {
    this.requestSender = sender;
  }

  provideOriginalResource(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    if (uri.scheme !== PairProgFileSystemProvider.SCHEME) {
      return undefined;
    }

    const relativePath = toRelativePath(uri);
    if (!relativePath) {
      return undefined;
    }

    const entry = this.entries.get(relativePath);
    if (!entry || entry.status === "deleted") {
      return undefined;
    }

    if (entry.status === "added" || entry.status === "untracked") {
      return this.toOriginalUri(relativePath, "", true);
    }

    return this.toOriginalUri(relativePath, entry.originalPath ?? relativePath, false);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { filePath, originalPath, empty } = this.parseOriginalUri(uri);
    if (empty) {
      return "";
    }

    const cacheKey = this.toCacheKey(filePath, originalPath);
    const cached = this.contentCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      return pending.promise;
    }

    if (!this.requestSender) {
      return "";
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let resolvePending: ((content: string) => void) | null = null;
    const promise = new Promise<string>((resolve) => {
      resolvePending = (content: string) => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        this.pendingRequests.delete(cacheKey);
        this.contentCache.set(cacheKey, content);
        resolve(content);
      };
    });
    this.pendingRequests.set(cacheKey, {
      promise,
      resolve: (content) => resolvePending?.(content),
    });
    this.requestSender({ filePath, originalPath });
    timeout = setTimeout(() => {
      const active = this.pendingRequests.get(cacheKey);
      if (active) {
        active.resolve("");
      }
    }, 10000);

    return promise;
  }

  updateEntries(entries: GitStatusFileEntry[]): void {
    const nextEntries = new Map(entries.map((entry) => [entry.filePath, entry] as const));
    const urisToRefresh = new Map<string, vscode.Uri>();

    for (const [filePath, previous] of this.entries) {
      urisToRefresh.set(
        this.toOriginalUri(filePath, previous.originalPath ?? filePath, previous.status === "added" || previous.status === "untracked").toString(),
        this.toOriginalUri(filePath, previous.originalPath ?? filePath, previous.status === "added" || previous.status === "untracked"),
      );
    }

    for (const [filePath, next] of nextEntries) {
      urisToRefresh.set(
        this.toOriginalUri(filePath, next.originalPath ?? filePath, next.status === "added" || next.status === "untracked").toString(),
        this.toOriginalUri(filePath, next.originalPath ?? filePath, next.status === "added" || next.status === "untracked"),
      );
    }

    this.entries.clear();
    for (const [filePath, entry] of nextEntries) {
      this.entries.set(filePath, entry);
    }
    this.sourceControl.count = this.entries.size;
    this.contentCache.clear();

    for (const uri of urisToRefresh.values()) {
      this._onDidChange.fire(uri);
    }
  }

  handleOriginalContentResponse(payload: GitOriginalContentResponsePayload): void {
    const cacheKey = this.toCacheKey(payload.filePath, payload.originalPath);
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      pending.resolve(payload.content);
      return;
    }

    this.contentCache.set(cacheKey, payload.content);
    this._onDidChange.fire(this.toOriginalUri(payload.filePath, payload.originalPath, false));
  }

  clear(): void {
    const urisToRefresh: vscode.Uri[] = [];
    for (const entry of this.entries.values()) {
      urisToRefresh.push(
        this.toOriginalUri(
          entry.filePath,
          entry.originalPath ?? entry.filePath,
          entry.status === "added" || entry.status === "untracked",
        )
      );
    }

    this.entries.clear();
    this.contentCache.clear();
    this.sourceControl.count = 0;

    for (const pending of this.pendingRequests.values()) {
      pending.resolve("");
    }
    this.pendingRequests.clear();

    for (const uri of urisToRefresh) {
      this._onDidChange.fire(uri);
    }
  }

  dispose(): void {
    this.clear();
    this.sourceControl.dispose();
    this._onDidChange.dispose();
  }
  private parseOriginalUri(uri: vscode.Uri): { filePath: string; originalPath: string; empty: boolean } {
    const query = new URLSearchParams(uri.query);
    return {
      filePath: uri.path.replace(/^\/+/, ""),
      originalPath: query.get("originalPath") ?? "",
      empty: query.get("empty") === "1",
    };
  }

  private toOriginalUri(filePath: string, originalPath: string, empty: boolean): vscode.Uri {
    const query = new URLSearchParams();
    query.set("originalPath", originalPath);
    if (empty) {
      query.set("empty", "1");
    }

    return vscode.Uri.from({
      scheme: RemoteGitQuickDiffController.CONTENT_SCHEME,
      path: "/" + filePath,
      query: query.toString(),
    });
  }

  private toCacheKey(filePath: string, originalPath: string): string {
    return `${filePath}\u0000${originalPath}`;
  }
}
