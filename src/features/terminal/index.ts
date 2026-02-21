import * as vscode from "vscode";
import {
  Message,
  MessageType,
  TerminalOutputPayload,
} from "../../network/protocol";
import { TerminalSync } from "./terminalSync";
import { RemoteTerminalOutput } from "./remoteTerminalOutput";
import { Feature, FeatureContext, FeatureCommand } from "../feature";

export class TerminalFeature implements Feature {
  readonly id = "terminal";
  readonly messageTypes = [
    MessageType.TerminalOutput as string,
    MessageType.TerminalClear as string,
  ];

  private context?: FeatureContext;

  // Host-side
  private terminalSync: TerminalSync | null = null;

  // Client-side
  private remoteTerminalOutput: RemoteTerminalOutput | null = null;

  async activate(context: FeatureContext): Promise<void> {
    this.context = context;

    if (context.role === "host") {
      this.terminalSync = new TerminalSync(context.sendFn);
    } else {
      this.remoteTerminalOutput = new RemoteTerminalOutput(
        context.extensionContext.globalState
      );
      await this.remoteTerminalOutput.fixTerminalCwd();
    }
  }

  handleMessage(msg: Message): void {
    switch (msg.type) {
      case MessageType.TerminalOutput:
        this.remoteTerminalOutput?.handleOutput(msg.payload as TerminalOutputPayload);
        break;

      case MessageType.TerminalClear:
        this.remoteTerminalOutput?.handleClear();
        break;
    }
  }

  getCommands(): FeatureCommand[] {
    return [
      {
        commandId: "pairprog.shareTerminal",
        label: "Share Terminal",
        icon: "terminal",
        roles: ["host"],
        execute: () => this.shareTerminal(),
      },
      {
        commandId: "pairprog.stopSharingTerminal",
        label: "Stop Sharing Terminal",
        icon: "terminal-kill",
        roles: ["host"],
        execute: () => this.stopSharingTerminal(),
      },
    ];
  }

  deactivate(): void {
    this.terminalSync?.dispose();
    this.terminalSync = null;
    this.remoteTerminalOutput?.dispose();
    this.remoteTerminalOutput = null;
    this.context = undefined;
  }

  dispose(): void {
    this.deactivate();
  }

  // --- internal ---

  private async shareTerminal(): Promise<void> {
    if (!this.terminalSync) {
      vscode.window.showWarningMessage("No client connected yet.");
      return;
    }
    if (this.terminalSync.isSharing) {
      vscode.window.showInformationMessage("Already sharing a terminal.");
      return;
    }
    const started = await this.terminalSync.startSharing();
    if (started) {
      vscode.window.showInformationMessage(
        "Terminal output is now being shared with the client."
      );
    }
  }

  private stopSharingTerminal(): void {
    if (!this.terminalSync?.isSharing) {
      vscode.window.showWarningMessage("No terminal is currently being shared.");
      return;
    }
    this.terminalSync.stopSharing();
    vscode.window.showInformationMessage("Terminal sharing stopped.");
  }
}
