import { describe, it, expect } from "vitest";
import { isIgnoredByPatterns } from "../utils/globUtils";

const DEFAULT_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "*.lock",
  "**/out/**",
  "**/dist/**",
  "**/Library/**",
  "**/vendor/**",
];

describe("isIgnoredByPatterns", () => {
  it("matches node_modules subdirectories", () => {
    expect(isIgnoredByPatterns("node_modules/express/index.js", DEFAULT_PATTERNS)).toBe(true);
    expect(isIgnoredByPatterns("src/node_modules/foo/bar.js", DEFAULT_PATTERNS)).toBe(true);
  });

  it("matches node_modules directory itself", () => {
    expect(isIgnoredByPatterns("node_modules", DEFAULT_PATTERNS)).toBe(true);
  });

  it("matches .git subdirectories", () => {
    expect(isIgnoredByPatterns(".git/config", DEFAULT_PATTERNS)).toBe(true);
    expect(isIgnoredByPatterns(".git/HEAD", DEFAULT_PATTERNS)).toBe(true);
  });

  it("matches lock files", () => {
    expect(isIgnoredByPatterns("yarn.lock", DEFAULT_PATTERNS)).toBe(true);
    expect(isIgnoredByPatterns("package-lock.json", DEFAULT_PATTERNS)).toBe(false);
  });

  it("matches out/dist directories", () => {
    expect(isIgnoredByPatterns("out/extension.js", DEFAULT_PATTERNS)).toBe(true);
    expect(isIgnoredByPatterns("dist/bundle.js", DEFAULT_PATTERNS)).toBe(true);
  });

  it("matches Library directories", () => {
    expect(isIgnoredByPatterns("Assets/Library/metadata.db", DEFAULT_PATTERNS)).toBe(true);
    expect(isIgnoredByPatterns("Library", DEFAULT_PATTERNS)).toBe(true);
  });

  it("does NOT match normal source files", () => {
    expect(isIgnoredByPatterns("src/index.ts", DEFAULT_PATTERNS)).toBe(false);
    expect(isIgnoredByPatterns("README.md", DEFAULT_PATTERNS)).toBe(false);
    expect(isIgnoredByPatterns("package.json", DEFAULT_PATTERNS)).toBe(false);
    expect(isIgnoredByPatterns("src/utils/pathUtils.ts", DEFAULT_PATTERNS)).toBe(false);
  });

  it("does NOT match files that merely contain ignored dir names", () => {
    expect(isIgnoredByPatterns("src/vendor_utils.ts", DEFAULT_PATTERNS)).toBe(false);
  });

  it("handles custom patterns", () => {
    expect(isIgnoredByPatterns(".env", [".*"])).toBe(true);
    expect(isIgnoredByPatterns("secrets/key.pem", ["secrets/**"])).toBe(true);
  });

  it("returns false for empty pattern list", () => {
    expect(isIgnoredByPatterns("anything.ts", [])).toBe(false);
  });
});
