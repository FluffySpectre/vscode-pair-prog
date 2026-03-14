import { describe, it, expect } from "vitest";
import {
  encodeInviteCode,
  encodeRelayInviteCode,
  decodeInviteCode,
} from "../network/inviteCode";

describe("inviteCode", () => {
  describe("LAN invite round-trip", () => {
    it("encodes and decodes a LAN invite", () => {
      const code = encodeInviteCode("192.168.1.5:9876", false);
      const decoded = decodeInviteCode(code);
      expect(decoded).toEqual({
        type: "lan",
        address: "192.168.1.5:9876",
        requiresPassphrase: false,
      });
    });

    it("preserves passphrase flag", () => {
      const code = encodeInviteCode("10.0.0.1:8080", true);
      const decoded = decodeInviteCode(code);
      expect(decoded).toEqual({
        type: "lan",
        address: "10.0.0.1:8080",
        requiresPassphrase: true,
      });
    });
  });

  describe("relay invite round-trip", () => {
    it("encodes and decodes a relay invite", () => {
      const code = encodeRelayInviteCode("https://relay.example.com", "ABC123", false);
      const decoded = decodeInviteCode(code);
      expect(decoded).toEqual({
        type: "relay",
        relayUrl: "https://relay.example.com",
        code: "ABC123",
        requiresPassphrase: false,
      });
    });

    it("preserves passphrase flag for relay", () => {
      const code = encodeRelayInviteCode("https://relay.example.com", "XYZ", true);
      const decoded = decodeInviteCode(code);
      expect(decoded.requiresPassphrase).toBe(true);
    });
  });

  describe("error handling", () => {
    it("throws on garbage input", () => {
      expect(() => decodeInviteCode("not-valid!!!")).toThrow("Invalid invite code");
    });

    it("throws on valid base64 but empty JSON object", () => {
      const emptyObj = Buffer.from("{}").toString("base64url");
      expect(() => decodeInviteCode(emptyObj)).toThrow("missing connection info");
    });

    it("throws on valid base64 but non-JSON", () => {
      const notJson = Buffer.from("hello world").toString("base64url");
      expect(() => decodeInviteCode(notJson)).toThrow("Invalid invite code");
    });
  });
});
