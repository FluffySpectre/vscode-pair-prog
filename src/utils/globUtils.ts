/**
 * Tests whether a file path matches a simple glob pattern.
 *
 * Supported patterns:
 *  - `dir/**`  — matches anything under that directory
 *  - `*.ext`   — matches files with a given extension
 *  - exact string match as fallback
 */
export function simpleGlobMatch(pattern: string, filePath: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath.startsWith(prefix + "/") || filePath === prefix;
  }
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1); // e.g., ".lock"
    return filePath.endsWith(ext);
  }
  return filePath === pattern;
}

export function isIgnoredByPatterns(relativePath: string, patterns: string[]): boolean {
  return patterns.some((p) => simpleGlobMatch(p, relativePath));
}
