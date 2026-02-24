import * as vscode from "vscode";
import * as os from "os";
import { TerminalOutputPayload } from "../../network/protocol";

// Manages the client-side terminal during a pair programming session
export class RemoteTerminalOutput implements vscode.Disposable {
  private static readonly TERMINAL_CWD_KEY = "pairprog.prevTerminalCwd";
  private static readonly TERMINAL_CWD_UNSET = "pairprog:unset";

  private terminal: vscode.Terminal | null = null;
  private closeListener: vscode.Disposable | null = null;
  private writeEmitter = new vscode.EventEmitter<string>();
  private ptyReady = false;
  private pendingData: string[] = [];
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
    if (!this.terminal || this.activeTerminalName !== payload.terminalName) {
      this.terminal?.dispose();
      this.closeListener?.dispose();
      this.writeEmitter.dispose();
      this.writeEmitter = new vscode.EventEmitter<string>();
      this.ptyReady = false;
      this.pendingData = [];
      this.activeTerminalName = payload.terminalName;

      const pty: vscode.Pseudoterminal = {
        onDidWrite: this.writeEmitter.event,
        open: () => {
          this.ptyReady = true;
          for (const queued of this.pendingData) {
            this.writeEmitter.fire(queued);
          }
          this.pendingData = [];
        },
        close: () => {},
      };

      this.terminal = vscode.window.createTerminal({
        name: `PairProg Terminal: ${payload.terminalName}`,
        pty,
      });
      this.terminal.show(true);

      const created = this.terminal;
      this.closeListener = vscode.window.onDidCloseTerminal((t) => {
        if (t === created) {
          this.terminal = null;
          this.ptyReady = false;
          this.pendingData = [];
          this.activeTerminalName = "";
          this.closeListener?.dispose();
          this.closeListener = null;
        }
      });
    }
    const data = payload.data.replace(/\r?\n/g, "\r\n");
    if (this.ptyReady) {
      this.writeEmitter.fire(data);
    } else {
      this.pendingData.push(data);
    }
  }

  handleClear(): void {
    if (this.terminal) {
      this.writeEmitter.fire(
        "\r\n\--- Terminal sharing ended ---\r\n"
      );
    }
    this.activeTerminalName = "";
  }

  dispose(): void {
    this.terminal?.dispose();
    this.terminal = null;
    this.closeListener?.dispose();
    this.closeListener = null;
    this.writeEmitter.dispose();
    this.ptyReady = false;
    this.pendingData = [];
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
