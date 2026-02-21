import { minimatch } from "minimatch";

// Tests if a workspace-relative file path should be ignored based on the configured glob patterns
export function isIgnoredByPatterns(relativePath: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (minimatch(relativePath, p, { dot: true })) {
      return true;
    }

    if (p.endsWith("/**")) {
      const dirPattern = p.slice(0, -3);
      if (relativePath === dirPattern || minimatch(relativePath, dirPattern, { dot: true })) {
        return true;
      }
    }
 
    return false;
  });
}
