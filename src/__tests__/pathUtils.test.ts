import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { isSafeRelativePath } from "../utils/pathUtils";

describe("isSafeRelativePath", () => {
  it("accepts normal relative paths", () => {
    expect(isSafeRelativePath("src/index.ts")).toBe(true);
    expect(isSafeRelativePath("foo/bar/baz.js")).toBe(true);
    expect(isSafeRelativePath("README.md")).toBe(true);
    expect(isSafeRelativePath("a/b/c/d/e.txt")).toBe(true);
  });

  it("accepts paths with ./prefix", () => {
    expect(isSafeRelativePath("./foo")).toBe(true);
    expect(isSafeRelativePath("./src/index.ts")).toBe(true);
  });

  it("accepts paths that use .. but stay within root", () => {
    expect(isSafeRelativePath("foo/../bar")).toBe(true);
    expect(isSafeRelativePath("a/b/../c")).toBe(true);
  });

  it("rejects paths that traverse above root", () => {
    expect(isSafeRelativePath("../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("../../secret")).toBe(false);
    expect(isSafeRelativePath("foo/../../bar")).toBe(false);
    expect(isSafeRelativePath("a/b/../../../etc/passwd")).toBe(false);
  });

  it("rejects bare .. traversal", () => {
    expect(isSafeRelativePath("..")).toBe(false);
    expect(isSafeRelativePath("../")).toBe(false);
  });

  it("rejects absolute paths (Unix)", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("/tmp/foo")).toBe(false);
  });

  it("on macOS/Linux, Windows-style paths are not recognized as absolute", () => {
    expect(isSafeRelativePath("C:\\Windows\\System32")).toBe(true);
  });

  it("handles edge cases", () => {
    expect(isSafeRelativePath("")).toBe(true); // normalizes to "."
    expect(isSafeRelativePath(".")).toBe(true);
  });
});
