import { Message, MessageHandler } from "./protocol";

/**
 * Routes incoming protocol messages to the handler that claimed their type.
 */
export class MessageRouter {
  private routes: Map<string, MessageHandler> = new Map();

  register(handler: MessageHandler): void {
    for (const msgType of handler.messageTypes) {
      if (this.routes.has(msgType)) {
        throw new Error(`Message type "${msgType}" is already claimed.`);
      }
      this.routes.set(msgType, handler);
    }
  }

  unregister(handler: MessageHandler): void {
    for (const msgType of handler.messageTypes) {
      if (this.routes.get(msgType) === handler) {
        this.routes.delete(msgType);
      }
    }
  }

  route(msg: Message): boolean {
    const handler = this.routes.get(msg.type as string);
    if (!handler) {
      return false;
    }
    handler.handleMessage(msg);
    return true;
  }
}
