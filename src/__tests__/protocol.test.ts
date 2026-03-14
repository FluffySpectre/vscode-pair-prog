import { describe, it, expect, beforeEach } from "vitest";
import {
  createMessage,
  serialize,
  deserialize,
  resetSeq,
  MessageType,
} from "../network/protocol";

describe("protocol", () => {
  beforeEach(() => {
    resetSeq();
  });

  describe("createMessage", () => {
    it("produces a message with correct structure", () => {
      const msg = createMessage(MessageType.Ping, {});
      expect(msg).toEqual({
        type: "ping",
        seq: 0,
        timestamp: expect.any(Number),
        payload: {},
      });
    });

    it("increments seq on each call", () => {
      const msg1 = createMessage(MessageType.Ping, {});
      const msg2 = createMessage(MessageType.Pong, {});
      const msg3 = createMessage(MessageType.Ping, {});
      expect(msg1.seq).toBe(0);
      expect(msg2.seq).toBe(1);
      expect(msg3.seq).toBe(2);
    });

    it("includes typed payload", () => {
      const msg = createMessage(MessageType.ChatMessage, {
        text: "hello",
        username: "alice",
      });
      expect(msg.payload).toEqual({ text: "hello", username: "alice" });
    });
  });

  describe("serialize / deserialize round-trip", () => {
    it("preserves all fields", () => {
      const original = createMessage(MessageType.CursorUpdate, {
        filePath: "src/index.ts",
        username: "bob",
        cursors: [{ position: { line: 10, character: 5 } }],
      });
      const json = serialize(original);
      const restored = deserialize(json);
      expect(restored).toEqual(original);
    });

    it("produces valid JSON string", () => {
      const msg = createMessage(MessageType.Ping, {});
      const json = serialize(msg);
      expect(() => JSON.parse(json)).not.toThrow();
    });
  });

  describe("deserialize error handling", () => {
    it("throws on invalid JSON", () => {
      expect(() => deserialize("not json")).toThrow();
    });
  });

  describe("resetSeq", () => {
    it("resets sequence counter to 0", () => {
      createMessage(MessageType.Ping, {});
      createMessage(MessageType.Ping, {});
      resetSeq();
      const msg = createMessage(MessageType.Ping, {});
      expect(msg.seq).toBe(0);
    });
  });
});
