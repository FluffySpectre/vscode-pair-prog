import {
  Message,
  MessageType,
  WhiteboardEntity,
  WhiteboardEntityAddPayload,
  WhiteboardEntityUpdatePayload,
  WhiteboardEntityDeletePayload,
  WhiteboardFullSyncPayload,
  WhiteboardCursorUpdatePayload,
  createMessage,
} from "../../network/protocol";
import { WhiteboardPanel } from "./whiteboardPanel";
import { Feature, FeatureContext, FeatureCommand } from "../feature";

export class WhiteboardFeature implements Feature {
  readonly id = "whiteboard";
  readonly messageTypes = [
    MessageType.WhiteboardEntityAdd as string,
    MessageType.WhiteboardEntityUpdate as string,
    MessageType.WhiteboardEntityDelete as string,
    MessageType.WhiteboardFullSync as string,
    MessageType.WhiteboardClear as string,
    MessageType.WhiteboardCursorUpdate as string,
  ];

  private context?: FeatureContext;
  private panel?: WhiteboardPanel;
  private entities: Map<string, WhiteboardEntity> = new Map();

  activate(context: FeatureContext): void {
    this.context = context;
    // If the host reconnects and entities exist (panel may or may not be open),
    // send a full sync so the newly-connected client gets the current board state.
    if (context.role === "host" && this.entities.size > 0) {
      const entities = Array.from(this.entities.values());
      context.sendFn(createMessage(MessageType.WhiteboardFullSync, { entities }));
    }
  }

  handleMessage(msg: Message): void {
    switch (msg.type) {
      case MessageType.WhiteboardEntityAdd: {
        const payload = msg.payload as WhiteboardEntityAddPayload;
        // Keep the feature-level store authoritative
        this.entities.set(payload.entity.id, payload.entity);
        this.ensurePanel();
        this.panel?.handleRemoteEntityAdd(payload);
        break;
      }

      case MessageType.WhiteboardEntityUpdate: {
        const payload = msg.payload as WhiteboardEntityUpdatePayload;
        const existing = this.entities.get(payload.id);
        if (existing) { Object.assign(existing, payload.changes); }
        this.ensurePanel();
        this.panel?.handleRemoteEntityUpdate(payload);
        break;
      }

      case MessageType.WhiteboardEntityDelete: {
        const payload = msg.payload as WhiteboardEntityDeletePayload;
        this.entities.delete(payload.id);
        this.ensurePanel();
        this.panel?.handleRemoteEntityDelete(payload);
        break;
      }

      case MessageType.WhiteboardFullSync: {
        const payload = msg.payload as WhiteboardFullSyncPayload;
        this.entities.clear();
        for (const e of payload.entities) { this.entities.set(e.id, e); }
        this.ensurePanel();
        this.panel?.handleRemoteFullSync(payload);
        break;
      }

      case MessageType.WhiteboardClear:
        this.entities.clear();
        this.panel?.handleRemoteClear();
        break;

      case MessageType.WhiteboardCursorUpdate: {
        const payload = msg.payload as WhiteboardCursorUpdatePayload;
        this.panel?.handleRemoteCursorUpdate(payload);
        break;
      }
    }
  }

  getCommands(): FeatureCommand[] {
    return [
      {
        commandId: "pairprog.openWhiteboard",
        label: "Open Whiteboard",
        description: "(Ctrl+Shift+W)",
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
    this.entities.clear();
    this.panel = undefined;
    this.context = undefined;
  }

  // --- internal ---

  private ensurePanel(): void {
    if (!this.context) { return; }
    if (!this.panel || this.panel.disposed) {
      this.panel = new WhiteboardPanel(
        this.context.extensionContext,
        this.context.sendFn,
        this.entities,
        this.context.username
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
