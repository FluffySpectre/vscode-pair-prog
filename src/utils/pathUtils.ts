import * as vscode from "vscode";

export function toRelativePath(uri: vscode.Uri): string | null {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    return null;
  }

  const rootPath = wsFolder.uri.fsPath;
  const filePath = uri.fsPath;

  if (!filePath.startsWith(rootPath)) {
    return null;
  }

  return filePath.slice(rootPath.length + 1).replace(/\\/g, "/");
}

export function toAbsoluteUri(relativePath: string): vscode.Uri {
  const wsFolder = vscode.workspace.workspaceFolders![0];
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
