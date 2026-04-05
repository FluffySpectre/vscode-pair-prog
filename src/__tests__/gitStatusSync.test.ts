import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({}));

import {
  buildGitStatusSnapshot,
  mapGitApiStatus,
  mergeGitFileStatuses,
  mergeGitStatusEntries,
} from "../sync/gitStatusSync";
import { GitStatus as GitApiStatus } from "../types/vscodeGit";

describe("gitStatusSync", () => {
  it("maps Git API statuses to remote statuses", () => {
    expect(mapGitApiStatus(GitApiStatus.MODIFIED)).toBe("modified");
    expect(mapGitApiStatus(GitApiStatus.INDEX_ADDED)).toBe("added");
    expect(mapGitApiStatus(GitApiStatus.DELETED)).toBe("deleted");
    expect(mapGitApiStatus(GitApiStatus.INDEX_RENAMED)).toBe("renamed");
    expect(mapGitApiStatus(GitApiStatus.UNTRACKED)).toBe("untracked");
    expect(mapGitApiStatus(GitApiStatus.BOTH_MODIFIED)).toBe("conflict");
    expect(mapGitApiStatus(GitApiStatus.IGNORED)).toBeNull();
  });

  it("keeps the higher-priority status for a file", () => {
    expect(mergeGitFileStatuses("modified", "added")).toBe("added");
    expect(mergeGitFileStatuses("renamed", "conflict")).toBe("conflict");
    expect(mergeGitFileStatuses("deleted", "modified")).toBe("deleted");
  });

  it("preserves originalPath metadata while merging entries", () => {
    expect(
      mergeGitStatusEntries(
        { filePath: "src/file.ts", status: "modified" },
        { filePath: "src/file.ts", status: "modified", originalPath: "src/file.ts" },
      )
    ).toEqual({
      filePath: "src/file.ts",
      status: "modified",
      originalPath: "src/file.ts",
    });
  });

  it("builds a filtered, collapsed snapshot", () => {
    const state = {
      mergeChanges: [
        makeChange("/repo/src/conflict.ts", GitApiStatus.BOTH_MODIFIED),
      ],
      indexChanges: [
        makeChange("/repo/src/new.ts", GitApiStatus.INDEX_ADDED),
        makeRename("/repo/src/old-name.ts", "/repo/src/renamed.ts", GitApiStatus.INDEX_RENAMED),
      ],
      workingTreeChanges: [
        makeChange("/repo/src/file.ts", GitApiStatus.MODIFIED),
        makeChange("/repo/src/new.ts", GitApiStatus.MODIFIED),
        makeChange("/repo/out/generated.js", GitApiStatus.MODIFIED),
      ],
      untrackedChanges: [
        makeChange("/repo/src/untracked.ts", GitApiStatus.UNTRACKED),
      ],
      onDidChange: vi.fn(),
    };

    expect(buildGitStatusSnapshot(state, "/repo", ["**/out/**"])).toEqual([
      { filePath: "src/conflict.ts", status: "conflict", originalPath: "src/conflict.ts" },
      { filePath: "src/file.ts", status: "modified", originalPath: "src/file.ts" },
      { filePath: "src/new.ts", status: "added" },
      { filePath: "src/renamed.ts", status: "renamed", originalPath: "src/old-name.ts" },
      { filePath: "src/untracked.ts", status: "untracked" },
    ]);
  });
});

function makeChange(fsPath: string, status: GitApiStatus) {
  const uri = { fsPath } as any;
  return {
    uri,
    originalUri: uri,
    renameUri: undefined,
    status,
  };
}

function makeRename(originalPath: string, renamedPath: string, status: GitApiStatus) {
  return {
    uri: { fsPath: renamedPath } as any,
    originalUri: { fsPath: originalPath } as any,
    renameUri: { fsPath: renamedPath } as any,
    status,
  };
}
