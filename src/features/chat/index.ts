import {
  Message,
  MessageType,
  ChatMessagePayload,
  createMessage,
} from "../../network/protocol";
import { showChatMessage, promptAndSendMessage } from "./chatUtils";
import { Feature, FeatureContext, FeatureCommand } from "../feature";

export class ChatFeature implements Feature {
  readonly id = "chat";
  readonly messageTypes = [MessageType.ChatMessage as string];

  private context?: FeatureContext;

  activate(context: FeatureContext): void {
    this.context = context;
  }

  async handleMessage(msg: Message): Promise<void> {
    if (msg.type !== MessageType.ChatMessage || !this.context) { return; }

    const fallbackSender = this.context.partnerUsername ||
      (this.context.role === "host" ? "Client" : "Host");

    await showChatMessage(
      msg.payload as ChatMessagePayload,
      fallbackSender,
      () => this.sendMessage()
    );
  }

  getCommands(): FeatureCommand[] {
    return [
      {
        commandId: "pairprog.sendMessage",
        label: "Send Message",
        description: "(Ctrl+Shift+M)",
        icon: "comment",
        roles: ["host", "client"],
        execute: () => this.sendMessage(),
      },
    ];
  }

  deactivate(): void {
    this.context = undefined;
  }

  dispose(): void {
    this.context = undefined;
  }

  // --- internal ---

  private async sendMessage(): Promise<void> {
    if (!this.context) { return; }

    const notConnectedMsg = this.context.role === "host"
      ? "No client connected yet."
      : "Not connected to a session.";

    const recipientLabel = this.context.partnerUsername ||
      (this.context.role === "host" ? "client" : "host");

    await promptAndSendMessage(
      !!this.context.sendFn,
      notConnectedMsg,
      recipientLabel,
      (text) => {
        this.context!.sendFn(
          createMessage(MessageType.ChatMessage, {
            text,
            username: this.context!.username,
          } as ChatMessagePayload)
        );
      }
    );
  }
}
