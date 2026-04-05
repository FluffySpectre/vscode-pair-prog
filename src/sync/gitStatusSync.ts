import * as vscode from "vscode";
import {
  Message,
  MessageType,
  MessageHandler,
  GitFileStatus,
  GitOriginalContentRequestPayload,
  GitOriginalContentResponsePayload,
  GitStatusFileEntry,
  GitStatusUpdatePayload,
  createMessage,
} from "../network/protocol";
import { isIgnoredByPatterns } from "../utils/globUtils";
import { toRelativePathFromRoot } from "../utils/pathUtils";
import { SessionDecorationProvider } from "../ui/sessionDecorationProvider";
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";
import {
  GitAPI,
  GitChange,
  GitExtension,
  GitRepository,
  GitRepositoryState,
  GitStatus as GitApiStatus,
} from "../types/vscodeGit";
import { RemoteGitQuickDiffController } from "../ui/remoteGitQuickDiffController";

const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  conflict: 6,
  deleted: 5,
  renamed: 4,
  added: 3,
  modified: 2,
  untracked: 1,
};

export class GitStatusSync implements vscode.Disposable, MessageHandler {
  readonly messageTypes: string[];

  private disposables: vscode.Disposable[] = [];
  private repositoryDisposable: vscode.Disposable | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private gitApi: GitAPI | null = null;
  private repository: GitRepository | null = null;
  private initPromise: Promise<void> | null = null;
  private quickDiffController: RemoteGitQuickDiffController | null = null;

  private readonly sendFn: (msg: Message) => void;
  private readonly isHost: boolean;
  private readonly workspaceRoot?: vscode.Uri;
  private readonly ignoredPatterns: string[];
  private readonly decorationProvider?: SessionDecorationProvider;

  constructor(
    sendFn: (msg: Message) => void,
    isHost: boolean,
    workspaceRoot?: vscode.Uri,
    ignoredPatterns: string[] = [],
    decorationProvider?: SessionDecorationProvider,
  ) {
    this.sendFn = sendFn;
    this.isHost = isHost;
    this.workspaceRoot = workspaceRoot;
    this.ignoredPatterns = ignoredPatterns;
    this.decorationProvider = decorationProvider;
    this.messageTypes = isHost
      ? [MessageType.GitStatusRequest as string, MessageType.GitOriginalContentRequest as string]
      : [MessageType.GitStatusUpdate as string, MessageType.GitOriginalContentResponse as string];
  }

  async activate(): Promise<void> {
    if (this.isHost) {
      this.initPromise = this.initializeHost();
      await this.initPromise;
    } else {
      this.initializeClient();
    }
  }

  async handleMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case MessageType.GitStatusRequest:
        if (this.initPromise) {
          await this.initPromise;
        }
        this.sendSnapshot();
        break;

      case MessageType.GitStatusUpdate:
        this.applySnapshot(msg.payload as GitStatusUpdatePayload);
        break;

      case MessageType.GitOriginalContentRequest:
        await this.handleOriginalContentRequest(msg.payload as GitOriginalContentRequestPayload);
        break;

      case MessageType.GitOriginalContentResponse:
        this.quickDiffController?.handleOriginalContentResponse(
          msg.payload as GitOriginalContentResponsePayload
        );
        break;
    }
  }

  requestFullSync(): void {
    this.sendFn(createMessage(MessageType.GitStatusRequest, {}));
  }

  dispose(): void {
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }

    this.repositoryDisposable?.dispose();
    this.repositoryDisposable = null;
    this.repository = null;
    this.gitApi = null;
    this.quickDiffController?.dispose();
    this.quickDiffController = null;
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.decorationProvider?.clearGitStatuses();
  }

  private async initializeHost(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!extension) {
      console.warn("[PairProg GitStatus] vscode.git extension not found.");
      return;
    }

    const gitExtension = extension.isActive
      ? extension.exports as GitExtension
      : await extension.activate() as GitExtension;

    this.disposables.push(
      gitExtension.onDidChangeEnablement(() => {
        void this.bindGitApi(gitExtension);
      })
    );

    await this.bindGitApi(gitExtension);
  }

  private async bindGitApi(gitExtension: GitExtension): Promise<void> {
    if (!gitExtension.enabled) {
      this.clearRepositoryBinding();
      this.scheduleSnapshot();
      return;
    }

    let api: GitAPI;
    try {
      api = gitExtension.getAPI(1);
    } catch (err) {
      console.warn("[PairProg GitStatus] Failed to access Git API:", err);
      this.clearRepositoryBinding();
      this.scheduleSnapshot();
      return;
    }

    if (this.gitApi !== api) {
      this.gitApi = api;
      this.disposables.push(
        api.onDidOpenRepository(() => {
          this.refreshRepositoryBinding();
        }),
        api.onDidCloseRepository(() => {
          this.refreshRepositoryBinding();
        }),
      );
    }

    this.refreshRepositoryBinding();
  }

  private refreshRepositoryBinding(): void {
    if (!this.gitApi || !this.workspaceRoot) {
      this.clearRepositoryBinding();
      this.scheduleSnapshot();
      return;
    }

    const nextRepository = this.gitApi.getRepository(this.workspaceRoot);
    if (nextRepository === this.repository) {
      return;
    }

    this.repositoryDisposable?.dispose();
    this.repositoryDisposable = null;
    this.repository = nextRepository;

    if (this.repository) {
      this.repositoryDisposable = this.repository.state.onDidChange(() => {
        this.scheduleSnapshot();
      });
    }

    this.scheduleSnapshot();
  }

  private clearRepositoryBinding(): void {
    this.repositoryDisposable?.dispose();
    this.repositoryDisposable = null;
    this.repository = null;
  }

  private scheduleSnapshot(): void {
    if (!this.isHost) {
      return;
    }

    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
    }

    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.sendSnapshot();
    }, 150);
  }

  private sendSnapshot(): void {
    if (!this.isHost || !this.workspaceRoot) {
      return;
    }

    const files = this.repository
      ? buildGitStatusSnapshot(this.repository.state, this.workspaceRoot.fsPath, this.ignoredPatterns)
      : [];

    this.sendFn(
      createMessage(MessageType.GitStatusUpdate, {
        files,
      } as GitStatusUpdatePayload)
    );
  }

  private applySnapshot(payload: GitStatusUpdatePayload): void {
    const nextStatuses = new Map<string, GitFileStatus>();
    for (const file of payload.files) {
      nextStatuses.set(file.filePath, file.status);
    }
    this.decorationProvider?.setGitStatuses(nextStatuses);
    this.quickDiffController?.updateEntries(payload.files);
  }

  private initializeClient(): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.find(
      (folder) => folder.uri.scheme === PairProgFileSystemProvider.SCHEME
    )?.uri;
    if (!workspaceRoot) {
      return;
    }

    this.quickDiffController = new RemoteGitQuickDiffController(workspaceRoot);
    this.quickDiffController.setRequestSender((payload) => {
      this.sendFn(createMessage(MessageType.GitOriginalContentRequest, payload));
    });
    this.disposables.push(
      this.quickDiffController,
      vscode.workspace.registerTextDocumentContentProvider(
        RemoteGitQuickDiffController.CONTENT_SCHEME,
        this.quickDiffController,
      ),
    );
  }

  private async handleOriginalContentRequest(
    payload: GitOriginalContentRequestPayload,
  ): Promise<void> {
    if (!this.isHost || !this.repository) {
      return;
    }

    let content = "";
    try {
      content = await this.repository.show("HEAD", payload.originalPath);
    } catch {
      // The file may not exist at HEAD. Use empty content so the editor still renders a diff.
    }

    this.sendFn(
      createMessage(MessageType.GitOriginalContentResponse, {
        filePath: payload.filePath,
        originalPath: payload.originalPath,
        content,
      } as GitOriginalContentResponsePayload)
    );
  }
}

export function buildGitStatusSnapshot(
  state: GitRepositoryState,
  workspaceRoot: string,
  ignoredPatterns: string[],
): GitStatusFileEntry[] {
  const statuses = new Map<string, GitStatusFileEntry>();
  const changes = [
    ...state.mergeChanges,
    ...state.indexChanges,
    ...state.workingTreeChanges,
    ...state.untrackedChanges,
  ];

  for (const change of changes) {
    const status = mapGitApiStatus(change.status);
    if (!status) {
      continue;
    }

    const relativePath = getRelativeGitPath(change, workspaceRoot);
    if (!relativePath || isIgnoredByPatterns(relativePath, ignoredPatterns)) {
      continue;
    }

    const originalPath = getOriginalGitPath(change, workspaceRoot, status);
    const current = statuses.get(relativePath);
    const nextEntry: GitStatusFileEntry = originalPath
      ? { filePath: relativePath, status, originalPath }
      : { filePath: relativePath, status };
    statuses.set(relativePath, mergeGitStatusEntries(current, nextEntry));
  }

  return Array.from(statuses.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry);
}

export function mergeGitFileStatuses(
  current: GitFileStatus | undefined,
  next: GitFileStatus,
): GitFileStatus {
  if (!current) {
    return next;
  }

  return STATUS_PRIORITY[next] > STATUS_PRIORITY[current] ? next : current;
}

export function mergeGitStatusEntries(
  current: GitStatusFileEntry | undefined,
  next: GitStatusFileEntry,
): GitStatusFileEntry {
  if (!current) {
    return next;
  }

  if (STATUS_PRIORITY[next.status] > STATUS_PRIORITY[current.status]) {
    return next;
  }

  if (current.status === "added" || current.status === "untracked") {
    return current;
  }

  if (!current.originalPath && next.originalPath) {
    return {
      ...current,
      originalPath: next.originalPath,
    };
  }

  return current;
}

export function mapGitApiStatus(status: GitApiStatus): GitFileStatus | null {
  switch (status) {
    case GitApiStatus.INDEX_ADDED:
    case GitApiStatus.INDEX_COPIED:
    case GitApiStatus.INTENT_TO_ADD:
      return "added";

    case GitApiStatus.INDEX_DELETED:
    case GitApiStatus.DELETED:
      return "deleted";

    case GitApiStatus.INDEX_RENAMED:
    case GitApiStatus.INTENT_TO_RENAME:
      return "renamed";

    case GitApiStatus.UNTRACKED:
      return "untracked";

    case GitApiStatus.ADDED_BY_US:
    case GitApiStatus.ADDED_BY_THEM:
    case GitApiStatus.DELETED_BY_US:
    case GitApiStatus.DELETED_BY_THEM:
    case GitApiStatus.BOTH_ADDED:
    case GitApiStatus.BOTH_DELETED:
    case GitApiStatus.BOTH_MODIFIED:
      return "conflict";

    case GitApiStatus.INDEX_MODIFIED:
    case GitApiStatus.MODIFIED:
    case GitApiStatus.TYPE_CHANGED:
      return "modified";

    case GitApiStatus.IGNORED:
      return null;
  }
}

function getRelativeGitPath(change: GitChange, workspaceRoot: string): string | null {
  const candidates = [change.renameUri, change.uri, change.originalUri];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const relativePath = toRelativePathFromRoot(candidate, workspaceRoot);
    if (relativePath) {
      return relativePath;
    }
  }

  return null;
}

function getOriginalGitPath(
  change: GitChange,
  workspaceRoot: string,
  status: GitFileStatus,
): string | undefined {
  if (status === "added" || status === "untracked") {
    return undefined;
  }

  if (status === "renamed") {
    return toRelativePathFromRoot(change.originalUri, workspaceRoot) ?? undefined;
  }

  return toRelativePathFromRoot(change.uri, workspaceRoot) ?? undefined;
}
