import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionRegistry } from "../sessionRegistry";

describe("SessionRegistry", () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.stop();
  });

  describe("createSession", () => {
    it("returns a 6-character code from the allowed charset", () => {
      const { info } = registry.createSession("Alice", "my-project", false);
      expect(info.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    });

    it("returns a 64-character hex admin token", () => {
      const { adminToken } = registry.createSession("Alice", "my-project", false);
      expect(adminToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it("stores session metadata correctly", () => {
      const { info } = registry.createSession("Bob", "workspace", true);
      expect(info.name).toBe("Bob");
      expect(info.workspace).toBe("workspace");
      expect(info.requiresPassphrase).toBe(true);
      expect(info.createdAt).toBeGreaterThan(0);
    });

    it("generates unique codes", () => {
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const { info } = registry.createSession("test", "ws", false);
        codes.add(info.code);
      }
      expect(codes.size).toBe(50);
    });
  });

  describe("validateAdminToken", () => {
    it("returns true for correct token", () => {
      const { info, adminToken } = registry.createSession("Alice", "ws", false);
      expect(registry.validateAdminToken(info.code, adminToken)).toBe(true);
    });

    it("returns false for wrong token", () => {
      const { info } = registry.createSession("Alice", "ws", false);
      expect(registry.validateAdminToken(info.code, "wrong-token")).toBe(false);
    });

    it("returns false for non-existent session", () => {
      expect(registry.validateAdminToken("ZZZZZZ", "any-token")).toBe(false);
    });
  });

  describe("getSession / listSessions", () => {
    it("retrieves a session by code", () => {
      const { info } = registry.createSession("Alice", "ws", false);
      const room = registry.getSession(info.code);
      expect(room).toBeDefined();
      expect(room!.info.name).toBe("Alice");
    });

    it("returns undefined for non-existent code", () => {
      expect(registry.getSession("NOPE99")).toBeUndefined();
    });

    it("lists all active sessions", () => {
      registry.createSession("Alice", "ws1", false);
      registry.createSession("Bob", "ws2", true);
      const sessions = registry.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.name).sort()).toEqual(["Alice", "Bob"]);
    });
  });

  describe("removeSession", () => {
    it("removes a session from the registry", () => {
      const { info } = registry.createSession("Alice", "ws", false);
      registry.removeSession(info.code);
      expect(registry.getSession(info.code)).toBeUndefined();
      expect(registry.listSessions()).toHaveLength(0);
    });

    it("does nothing for non-existent code", () => {
      expect(() => registry.removeSession("NOPE99")).not.toThrow();
    });
  });
});
