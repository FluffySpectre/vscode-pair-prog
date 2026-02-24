import * as vscode from "vscode";

const SYNCABLE_SCHEMES = new Set(["file", "pairprog"]);

export function isSyncableDocument(uri: vscode.Uri): boolean {
  return SYNCABLE_SCHEMES.has(uri.scheme);
}

export function toRelativePath(uri: vscode.Uri): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    return null;
  }

  // Find the workspace folder that matches this URI's scheme
  const wsFolder = folders.find((f) => f.uri.scheme === uri.scheme);
  if (!wsFolder) {
    return null;
  }

  const rootPath = wsFolder.uri.path;
  const filePath = uri.path;

  const normalizedRoot = rootPath.toLowerCase();
  const normalizedFile = filePath.toLowerCase();

  if (!normalizedFile.startsWith(normalizedRoot + "/") && normalizedFile !== normalizedRoot) {
    return null;
  }

  const relative = filePath.slice(rootPath.length + 1);
  return relative || null;
}

export function toAbsoluteUri(relativePath: string): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders!;
  const wsFolder = folders.find((f) => f.uri.scheme === "pairprog") || folders[0];
  return vscode.Uri.joinPath(wsFolder.uri, relativePath);
}

export function toRelativePathFromRoot(uri: vscode.Uri, workspaceRoot: string): string | null {
  const filePath = uri.fsPath;
  if (!filePath.startsWith(workspaceRoot)) {
    return null;
  }
  return filePath.slice(workspaceRoot.length + 1).replace(/\\/g, "/");
}

export function getSystemUsername(fallback: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("os").userInfo().username || fallback;
}
