import * as vscode from "vscode";
import * as os from "os";
import { TerminalOutputPayload } from "../../network/protocol";

// Manages the client-side terminal during a pair programming session
export class RemoteTerminalOutput implements vscode.Disposable {
  private static readonly TERMINAL_CWD_KEY = "pairprog.prevTerminalCwd";
  private static readonly TERMINAL_CWD_UNSET = "pairprog:unset";

  private outputChannel: vscode.OutputChannel | null = null;
  private activeTerminalName: string = "";
  private globalState: vscode.Memento;

  constructor(globalState: vscode.Memento) {
    this.globalState = globalState;
  }

  // Fix terminal CWD so new terminals don't open in the VFS path
  async fixTerminalCwd(): Promise<void> {
    const config = vscode.workspace.getConfiguration("terminal.integrated");
    const prev = config.inspect<string>("cwd")?.globalValue;

    await this.globalState.update(
      RemoteTerminalOutput.TERMINAL_CWD_KEY,
      prev !== undefined ? prev : RemoteTerminalOutput.TERMINAL_CWD_UNSET
    );

    if (prev !== os.homedir()) {
      try {
        await config.update("cwd", os.homedir(), vscode.ConfigurationTarget.Global);
      } catch {
        // ignore
      }
    }
  }

  handleOutput(payload: TerminalOutputPayload): void {
    if (!this.outputChannel || this.activeTerminalName !== payload.terminalName) {
      this.outputChannel?.dispose();
      this.activeTerminalName = payload.terminalName;
      this.outputChannel = vscode.window.createOutputChannel(
        `PairProg Terminal: ${payload.terminalName}`,
        "ansi"
      );
      this.outputChannel.show(/* preserveFocus */ true);
    }
    this.outputChannel.append(payload.data);
  }

  handleClear(): void {
    if (this.outputChannel) {
      this.outputChannel.appendLine(
        "\n\u2500\u2500\u2500 Terminal sharing ended \u2500\u2500\u2500"
      );
    }
  }

  dispose(): void {
    this.outputChannel?.dispose();
    this.outputChannel = null;
    this.activeTerminalName = "";
    this.restoreTerminalCwd();
  }

  private async restoreTerminalCwd(): Promise<void> {
    const stored = this.globalState.get<string>(RemoteTerminalOutput.TERMINAL_CWD_KEY);
    if (stored === undefined) { return; }

    try {
      const config = vscode.workspace.getConfiguration("terminal.integrated");
      const restoreValue = stored === RemoteTerminalOutput.TERMINAL_CWD_UNSET ? undefined : stored;
      await config.update("cwd", restoreValue, vscode.ConfigurationTarget.Global);
    } catch {
      // ignore
    }
    await this.globalState.update(RemoteTerminalOutput.TERMINAL_CWD_KEY, undefined);
  }
}
