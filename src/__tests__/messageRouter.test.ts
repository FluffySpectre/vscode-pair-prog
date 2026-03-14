import { describe, it, expect, vi } from "vitest";
import { MessageRouter } from "../network/messageRouter";
import type { Message, MessageHandler } from "../network/protocol";

function makeHandler(types: string[], fn?: (msg: Message) => void): MessageHandler {
  return {
    messageTypes: types,
    handleMessage: fn ?? vi.fn(),
  };
}

function makeMessage(type: string): Message {
  return { type, seq: 0, timestamp: Date.now(), payload: {} };
}

describe("MessageRouter", () => {
  it("routes messages to the registered handler", () => {
    const router = new MessageRouter();
    const handler = makeHandler(["ping"]);
    router.register(handler);

    const msg = makeMessage("ping");
    const result = router.route(msg);

    expect(result).toBe(true);
    expect(handler.handleMessage).toHaveBeenCalledWith(msg);
  });

  it("returns false for unregistered message types", () => {
    const router = new MessageRouter();
    expect(router.route(makeMessage("unknown"))).toBe(false);
  });

  it("throws on duplicate registration", () => {
    const router = new MessageRouter();
    router.register(makeHandler(["ping"]));
    expect(() => router.register(makeHandler(["ping"]))).toThrow("already claimed");
  });

  it("supports handlers claiming multiple message types", () => {
    const router = new MessageRouter();
    const handler = makeHandler(["ping", "pong"]);
    router.register(handler);

    router.route(makeMessage("ping"));
    router.route(makeMessage("pong"));

    expect(handler.handleMessage).toHaveBeenCalledTimes(2);
  });

  it("unregisters a handler", () => {
    const router = new MessageRouter();
    const handler = makeHandler(["ping"]);
    router.register(handler);
    router.unregister(handler);

    expect(router.route(makeMessage("ping"))).toBe(false);
  });

  it("catches errors from async handlers", async () => {
    const router = new MessageRouter();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = makeHandler(["fail"], async () => {
      throw new Error("async handler error");
    });
    router.register(handler);

    expect(router.route(makeMessage("fail"))).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
