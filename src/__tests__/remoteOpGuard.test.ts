import { describe, it, expect } from "vitest";
import { RemoteOpGuard } from "../sync/remoteOpGuard";

describe("RemoteOpGuard", () => {
  it("returns false for unknown keys", () => {
    const guard = new RemoteOpGuard();
    expect(guard.isActive("foo")).toBe(false);
  });

  it("marks key active during run(), removes after", async () => {
    const guard = new RemoteOpGuard();
    let activeInside = false;

    await guard.run("mykey", async () => {
      activeInside = guard.isActive("mykey");
    });

    expect(activeInside).toBe(true);
    expect(guard.isActive("mykey")).toBe(false);
  });

  it("supports multiple keys simultaneously", async () => {
    const guard = new RemoteOpGuard();

    await guard.run(["a", "b"], async () => {
      expect(guard.isActive("a")).toBe(true);
      expect(guard.isActive("b")).toBe(true);
      expect(guard.isActive("c")).toBe(false);
    });

    expect(guard.isActive("a")).toBe(false);
    expect(guard.isActive("b")).toBe(false);
  });

  it("removes key even if function throws", async () => {
    const guard = new RemoteOpGuard();

    await expect(
      guard.run("errorkey", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(guard.isActive("errorkey")).toBe(false);
  });

  it("accepts a single string key", async () => {
    const guard = new RemoteOpGuard();
    await guard.run("single", async () => {
      expect(guard.isActive("single")).toBe(true);
    });
  });

  it("returns the value from the wrapped function", async () => {
    const guard = new RemoteOpGuard();
    const result = await guard.run("key", async () => 42);
    expect(result).toBe(42);
  });
});
