import * as vscode from "vscode";
import {
  Message,
  MessageType,
  TerminalOutputPayload,
  TerminalClearPayload,
  createMessage,
} from "../network/protocol";

/**
 * TerminalSync lets the host stream command output from a terminal to the client
 */
export class TerminalSync implements vscode.Disposable {
  private sendFn: (msg: Message) => void;
  private sharedTerminal: vscode.Terminal | null = null;
  private executionListener: vscode.Disposable | null = null;
  private closeListener: vscode.Disposable | null = null;
  private _isSharing = false;
  private onDidChangeSharing?: (sharing: boolean) => void;

  constructor(sendFn: (msg: Message) => void) {
    this.sendFn = sendFn;
  }

  get isSharing(): boolean {
    return this._isSharing;
  }

  onSharingChanged(cb: (sharing: boolean) => void): void {
    this.onDidChangeSharing = cb;
  }

  // Host: pick a terminal and start streaming command output

  async startSharing(): Promise<boolean> {
    const terminals = [...vscode.window.terminals];

    if (terminals.length === 0) {
      vscode.window.showWarningMessage(
        "No open terminals to share. Open a terminal first."
      );
      return false;
    }

    let terminal: vscode.Terminal;

    if (terminals.length === 1) {
      terminal = terminals[0];
    } else {
      type TermItem = vscode.QuickPickItem & { terminal: vscode.Terminal };
      const items: TermItem[] = terminals.map((t) => ({
        label: `$(terminal) ${t.name}`,
        terminal: t,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a terminal to share with the client",
        title: "Share Terminal Output",
      });

      if (!picked) { return false; }
      terminal = picked.terminal;
    }

    if (!terminal.shellIntegration) {
      const choice = await vscode.window.showWarningMessage(
        "Shell integration is not active in the selected terminal. " +
        "Command output may not be streamed until it activates. Continue?",
        "Continue",
        "Cancel"
      );
      if (choice !== "Continue") { return false; }
    }

    this.sharedTerminal = terminal;
    this._isSharing = true;
    this.onDidChangeSharing?.(true);

    // Stream raw output for every command that runs in the shared terminal
    this.executionListener = vscode.window.onDidStartTerminalShellExecution(
      async (event) => {
        if (event.terminal !== this.sharedTerminal) { return; }

        const terminalName = event.terminal.name;
        const stream = event.execution.read();

        for await (const data of stream) {
          if (!this._isSharing) { break; }
          const payload: TerminalOutputPayload = { data, terminalName };
          this.sendFn(createMessage(MessageType.TerminalOutput, payload));
        }
      }
    );

    // Auto-stop if the terminal is closed by the user
    this.closeListener = vscode.window.onDidCloseTerminal((t) => {
      if (t === this.sharedTerminal) {
        this.stopSharing();
        vscode.window.showInformationMessage(
          "Shared terminal was closed — terminal sharing stopped."
        );
      }
    });

    return true;
  }

  // Host: stop streaming

  stopSharing(): void {
    if (!this._isSharing) { return; }

    this.executionListener?.dispose();
    this.executionListener = null;

    this.closeListener?.dispose();
    this.closeListener = null;

    this.sharedTerminal = null;
    this._isSharing = false;
    this.onDidChangeSharing?.(false);

    this.sendFn(createMessage(MessageType.TerminalClear, {} as TerminalClearPayload));
  }

  dispose(): void {
    this.stopSharing();
  }
}
