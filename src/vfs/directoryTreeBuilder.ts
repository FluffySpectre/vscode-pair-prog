import * as vscode from "vscode";
import { DirectoryTreeEntry } from "../network/protocol";
import { isIgnoredByPatterns } from "../utils/globUtils";

/**
 * Recursively walks a workspace folder and returns a flat list of entries
 * for the DirectoryTree protocol message. Respects ignoredPatterns.
 */
export async function buildDirectoryTree(
  rootUri: vscode.Uri,
  ignoredPatterns: string[]
): Promise<DirectoryTreeEntry[]> {
  const entries: DirectoryTreeEntry[] = [];
  await walkDirectory(rootUri, rootUri, ignoredPatterns, entries);
  return entries;
}

async function walkDirectory(
  rootUri: vscode.Uri,
  dirUri: vscode.Uri,
  ignoredPatterns: string[],
  entries: DirectoryTreeEntry[]
): Promise<void> {
  let children: [string, vscode.FileType][];
  try {
    children = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return;
  }

  for (const [name, fileType] of children) {
    const childUri = vscode.Uri.joinPath(dirUri, name);
    const relativePath = childUri.path.slice(rootUri.path.length + 1);

    if (isIgnoredByPatterns(relativePath, ignoredPatterns)) {
      continue;
    }

    if (fileType === vscode.FileType.Directory) {
      entries.push({ path: relativePath, type: "directory", size: 0, mtime: Date.now() });
      await walkDirectory(rootUri, childUri, ignoredPatterns, entries);
    } else if (fileType === vscode.FileType.File) {
      let size = 0;
      try {
        const stat = await vscode.workspace.fs.stat(childUri);
        size = stat.size;
      } catch {
        // use default size
      }
      entries.push({ path: relativePath, type: "file", size, mtime: Date.now() });
    }
  }
}

