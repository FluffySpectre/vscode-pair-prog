import {
  Message,
  MessageType,
  WhiteboardStrokePayload,
} from "../../network/protocol";
import { WhiteboardPanel } from "./whiteboardPanel";
import { Feature, FeatureContext, FeatureCommand } from "../feature";

export class WhiteboardFeature implements Feature {
  readonly id = "whiteboard";
  readonly messageTypes = [
    MessageType.WhiteboardStroke as string,
    MessageType.WhiteboardClear as string,
  ];

  private context?: FeatureContext;
  private panel?: WhiteboardPanel;

  activate(context: FeatureContext): void {
    this.context = context;
  }

  handleMessage(msg: Message): void {
    switch (msg.type) {
      case MessageType.WhiteboardStroke:
        this.ensurePanel();
        this.panel?.handleRemoteStroke(msg.payload as WhiteboardStrokePayload);
        break;

      case MessageType.WhiteboardClear:
        this.panel?.handleRemoteClear();
        break;
    }
  }

  getCommands(): FeatureCommand[] {
    return [
      {
        commandId: "pairprog.openWhiteboard",
        label: "Open Whiteboard",
        icon: "edit",
        roles: ["host", "client"],
        execute: () => this.openWhiteboard(),
      },
    ];
  }

  deactivate(): void {
    // Panel can survive reconnects; don't dispose it here.
    this.context = undefined;
  }

  dispose(): void {
    this.panel = undefined;
    this.context = undefined;
  }

  // --- internal ---

  private ensurePanel(): void {
    if (!this.context) { return; }
    if (!this.panel || this.panel.disposed) {
      this.panel = new WhiteboardPanel(
        this.context.extensionContext,
        this.context.sendFn
      );
    }
  }

  private openWhiteboard(): void {
    this.ensurePanel();
    if (this.panel && !this.panel.disposed) {
      this.panel.reveal();
    }
  }
}
