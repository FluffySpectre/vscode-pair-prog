import * as vscode from "vscode";
import * as os from "os";
import * as crypto from "crypto";
import { spawn, ChildProcess } from "child_process";
import {
  Message,
  MessageType,
  TerminalSharedPayload,
  TerminalOutputPayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalClosedPayload,
  TerminalUnsharedPayload,
  TerminalReadonlyChangedPayload,
  createMessage,
} from "../network/protocol";

// Host-side pseudoterminal that wraps a child process

class HostPseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  private childProcess: ChildProcess;
  private onOutputCallback: (data: string) => void;
  private onExitCallback: () => void;
  private exited = false;

  constructor(
    shell: string,
    cwd: string,
    onOutput: (data: string) => void,
    onExit: () => void
  ) {
    this.onOutputCallback = onOutput;
    this.onExitCallback = onExit;

    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
    };

    // Force interactive mode so the shell shows a prompt and reads stdin
    const shellName = (shell.split("/").pop() || "").toLowerCase();
    let shellArgs: string[];
    if (process.platform === "win32") {
      shellArgs = [];
    } else if (shellName === "bash") {
      shellArgs = ["-i"];
    } else {
      shellArgs = ["-i"];
    }

    this.childProcess = spawn(shell, shellArgs, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.childProcess.stdout?.on("data", (data: Buffer) => {
      // Replace bare \n with \r\n — piped stdio doesn't add \r like a real TTY does
      const text = data.toString().replace(/\r?\n/g, "\r\n");
      this.writeEmitter.fire(text);
      this.onOutputCallback(text);
    });

    this.childProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().replace(/\r?\n/g, "\r\n");
      this.writeEmitter.fire(text);
      this.onOutputCallback(text);
    });

    this.childProcess.on("close", (code) => {
      if (this.exited) { return; }
      this.exited = true;
      this.closeEmitter.fire(code ?? undefined);
      this.onExitCallback();
    });

    this.childProcess.on("error", (err) => {
      const msg = `\r\nShell error: ${err.message}\r\n`;
      this.writeEmitter.fire(msg);
      if (!this.exited) {
        this.exited = true;
        this.closeEmitter.fire();
        this.onExitCallback();
      }
    });
  }

  open(): void {}

  close(): void {
    if (!this.exited) {
      this.childProcess.kill();
    }
  }

  handleInput(data: string): void {
    if (this.exited) { return; }
    this.writeToStdin(data);
  }

  setDimensions(): void {
    // Piped processes don't support resize - no-op for V1
  }

  writeToProcess(data: string): void {
    if (this.exited) { return; }
    this.writeToStdin(data);
  }

  // Write input to the shell's stdin. The shell in interactive mode (-i)
  // handles echoing through stdout, which we already capture and broadcast.
  private writeToStdin(data: string): void {
    const toWrite = data === "\r" ? "\n" : data;
    this.childProcess.stdin?.write(toWrite);
  }

  resize(): void {
    // Piped processes don't support resize - no-op for V1
  }

  dispose(): void {
    if (!this.exited) {
      this.childProcess.kill();
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

// Client-side pseudoterminal that mirrors host output

class ClientPseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  private onInputCallback: (data: string) => void;
  private onResizeCallback: (cols: number, rows: number) => void;
  private _readonly = true; // readonly by default
  private _readonlyMessageShown = false;

  constructor(
    onInput: (data: string) => void,
    onResize: (cols: number, rows: number) => void,
    initialReadonly = true
  ) {
    this.onInputCallback = onInput;
    this.onResizeCallback = onResize;
    this._readonly = initialReadonly;
  }

  open(): void {}

  close(): void {}

  handleInput(data: string): void {
    if (this._readonly) {
      if (!this._readonlyMessageShown) {
        this._readonlyMessageShown = true;
        this.writeEmitter.fire(
          "\r\n\x1b[33m[Read-Only: host has not granted write access]\x1b[0m\r\n"
        );
      }
      return;
    }
    this.onInputCallback(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.onResizeCallback(dimensions.columns, dimensions.rows);
  }

  setReadonly(value: boolean): void {
    this._readonly = value;
    this._readonlyMessageShown = false;
    if (value) {
      this.writeEmitter.fire(
        "\r\n\x1b[33m[Write access revoked by host]\x1b[0m\r\n"
      );
    } else {
      this.writeEmitter.fire(
        "\r\n\x1b[32m[Write access granted by host]\x1b[0m\r\n"
      );
    }
  }

  writeOutput(data: string): void {
    this.writeEmitter.fire(data);
  }

  terminate(): void {
    this.closeEmitter.fire();
  }

  dispose(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

// Internal handle types

interface HostTerminalHandle {
  terminalId: string;
  name: string;
  vsTerminal: vscode.Terminal;
  pseudoterminal: HostPseudoterminal;
  shared: boolean;
  readonly: boolean;
}

interface ClientTerminalHandle {
  terminalId: string;
  name: string;
  vsTerminal: vscode.Terminal;
  pseudoterminal: ClientPseudoterminal;
}

// TerminalSync - manages shared terminals for both host and client

export class TerminalSync implements vscode.Disposable {
  private sendFn: (msg: Message) => void;
  private isHost: boolean;
  private hostTerminals: Map<string, HostTerminalHandle> = new Map();
  private clientTerminals: Map<string, ClientTerminalHandle> = new Map();
  private disposables: vscode.Disposable[] = [];

  // Output buffering
  private outputBuffers: Map<string, string> = new Map();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL_MS = 16;

  constructor(sendFn: (msg: Message) => void, isHost: boolean) {
    this.sendFn = sendFn;
    this.isHost = isHost;
  }

  activate(): void {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        if (this.isHost) {
          for (const [id, handle] of this.hostTerminals) {
            if (handle.vsTerminal === terminal) {
              if (handle.shared) {
                this.flushOutputBuffer(id);
                this.sendFn(
                  createMessage(MessageType.TerminalClosed, {
                    terminalId: id,
                  } as TerminalClosedPayload)
                );
              }
              handle.pseudoterminal.dispose();
              this.hostTerminals.delete(id);
              break;
            }
          }
        } else {
          for (const [id, handle] of this.clientTerminals) {
            if (handle.vsTerminal === terminal) {
              handle.pseudoterminal.dispose();
              this.clientTerminals.delete(id);
              break;
            }
          }
        }
      })
    );
  }

  // Host: share a new terminal

  shareTerminal(name?: string): void {
    if (!this.isHost) { return; }

    const terminalId = crypto.randomUUID();
    const shell = this.getDefaultShell();
    const displayName = name || shell.split("/").pop() || "terminal";
    const cwd =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    const cols = 80;
    const rows = 24;

    let pseudoterminal: HostPseudoterminal;
    try {
      pseudoterminal = new HostPseudoterminal(
        shell,
        cwd,
        (data: string) => {
          this.bufferOutput(terminalId, data);
        },
        () => {
          this.flushOutputBuffer(terminalId);
          this.sendFn(
            createMessage(MessageType.TerminalClosed, {
              terminalId,
            } as TerminalClosedPayload)
          );
          const handle = this.hostTerminals.get(terminalId);
          if (handle) {
            handle.pseudoterminal.dispose();
          }
          this.hostTerminals.delete(terminalId);
        }
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to create shared terminal: ${err.message}`
      );
      return;
    }

    const vsTerminal = vscode.window.createTerminal({
      name: `[Shared] ${displayName}`,
      pty: pseudoterminal,
    });
    vsTerminal.show();

    this.hostTerminals.set(terminalId, {
      terminalId,
      name: displayName,
      vsTerminal,
      pseudoterminal,
      shared: true,
      readonly: true,
    });

    this.sendFn(
      createMessage(MessageType.TerminalShared, {
        terminalId,
        name: displayName,
        cols,
        rows,
        readonly: true,
      } as TerminalSharedPayload)
    );

    vscode.window.showInformationMessage(
      `Shared terminal "${displayName}" with your pair (read-only for client).`
    );
  }

  // Host: stop sharing a terminal (keeps it running locally)

  unshareTerminal(terminalId: string): void {
    if (!this.isHost) { return; }

    const handle = this.hostTerminals.get(terminalId);
    if (!handle || !handle.shared) { return; }

    handle.shared = false;
    this.flushOutputBuffer(terminalId);

    this.sendFn(
      createMessage(MessageType.TerminalUnshared, {
        terminalId,
      } as TerminalUnsharedPayload)
    );

    vscode.window.showInformationMessage(
      `Stopped sharing terminal "${handle.name}".`
    );
  }

  // Host: get list of shared terminals (for QuickPick)

  getSharedTerminals(): Array<{ terminalId: string; name: string; readonly: boolean }> {
    const result: Array<{ terminalId: string; name: string; readonly: boolean }> = [];
    for (const handle of this.hostTerminals.values()) {
      if (handle.shared) {
        result.push({ terminalId: handle.terminalId, name: handle.name, readonly: handle.readonly });
      }
    }
    return result;
  }

  // Client: host shared a new terminal

  handleTerminalShared(payload: TerminalSharedPayload): void {
    if (this.isHost) { return; }

    const { terminalId, name } = payload;
    const isReadonly = payload.readonly ?? true;

    const pseudoterminal = new ClientPseudoterminal(
      (data: string) => {
        this.sendFn(
          createMessage(MessageType.TerminalInput, {
            terminalId,
            data,
          } as TerminalInputPayload)
        );
      },
      (cols: number, rows: number) => {
        this.sendFn(
          createMessage(MessageType.TerminalResize, {
            terminalId,
            cols,
            rows,
          } as TerminalResizePayload)
        );
      },
      isReadonly
    );

    const vsTerminal = vscode.window.createTerminal({
      name: `[Shared] ${name}`,
      pty: pseudoterminal,
    });
    vsTerminal.show();

    this.clientTerminals.set(terminalId, {
      terminalId,
      name,
      vsTerminal,
      pseudoterminal,
    });

    vscode.window.showInformationMessage(
      `Host shared terminal: ${name}`
    );
  }

  // Host: client sent input

  handleTerminalInput(payload: TerminalInputPayload): void {
    if (!this.isHost) { return; }

    const handle = this.hostTerminals.get(payload.terminalId);
    if (!handle || !handle.shared) { return; }
    if (handle.readonly) { return; } // drop input when readonly

    handle.pseudoterminal.writeToProcess(payload.data);
  }

  // Host: toggle readonly state for a shared terminal

  setTerminalReadonly(terminalId: string, readonly: boolean): void {
    if (!this.isHost) { return; }

    const handle = this.hostTerminals.get(terminalId);
    if (!handle || !handle.shared) { return; }

    handle.readonly = readonly;

    this.sendFn(
      createMessage(MessageType.TerminalReadonlyChanged, {
        terminalId,
        readonly,
      } as TerminalReadonlyChangedPayload)
    );

    vscode.window.showInformationMessage(
      readonly
        ? `Write access revoked from client for terminal "${handle.name}".`
        : `Write access granted to client for terminal "${handle.name}".`
    );
  }

  // Client: host changed readonly state

  handleTerminalReadonlyChanged(payload: TerminalReadonlyChangedPayload): void {
    if (this.isHost) { return; }

    const handle = this.clientTerminals.get(payload.terminalId);
    if (!handle) { return; }

    handle.pseudoterminal.setReadonly(payload.readonly);
  }

  // Client: host sent output

  handleTerminalOutput(payload: TerminalOutputPayload): void {
    if (this.isHost) { return; }

    const handle = this.clientTerminals.get(payload.terminalId);
    if (!handle) { return; }

    handle.pseudoterminal.writeOutput(payload.data);
  }

  // Host: client resized their terminal

  handleTerminalResize(payload: TerminalResizePayload): void {
    if (!this.isHost) { return; }

    const handle = this.hostTerminals.get(payload.terminalId);
    if (!handle || !handle.shared) { return; }

    handle.pseudoterminal.resize();
  }

  // Client: host closed a shared terminal

  handleTerminalClosed(payload: TerminalClosedPayload): void {
    if (this.isHost) { return; }

    const handle = this.clientTerminals.get(payload.terminalId);
    if (!handle) { return; }

    handle.pseudoterminal.terminate();
    handle.pseudoterminal.dispose();
    this.clientTerminals.delete(payload.terminalId);
  }

  // Client: host stopped sharing a terminal

  handleTerminalUnshared(payload: TerminalUnsharedPayload): void {
    if (this.isHost) { return; }

    const handle = this.clientTerminals.get(payload.terminalId);
    if (!handle) { return; }

    vscode.window.showInformationMessage(
      `Host stopped sharing terminal: ${handle.name}`
    );

    handle.pseudoterminal.terminate();
    handle.pseudoterminal.dispose();
    this.clientTerminals.delete(payload.terminalId);
  }

  // Output buffering

  private bufferOutput(terminalId: string, data: string): void {
    const handle = this.hostTerminals.get(terminalId);
    if (!handle?.shared) { return; }

    const existing = this.outputBuffers.get(terminalId) || "";
    this.outputBuffers.set(terminalId, existing + data);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushAllOutputBuffers();
        this.flushTimer = null;
      }, this.FLUSH_INTERVAL_MS);
    }
  }

  private flushOutputBuffer(terminalId: string): void {
    const data = this.outputBuffers.get(terminalId);
    if (data && data.length > 0) {
      this.sendFn(
        createMessage(MessageType.TerminalOutput, {
          terminalId,
          data,
        } as TerminalOutputPayload)
      );
      this.outputBuffers.delete(terminalId);
    }
  }

  private flushAllOutputBuffers(): void {
    for (const terminalId of this.outputBuffers.keys()) {
      this.flushOutputBuffer(terminalId);
    }
  }

  // Utilities

  private getDefaultShell(): string {
    if (process.platform === "win32") {
      return process.env.COMSPEC || "cmd.exe";
    }
    return process.env.SHELL || "/bin/sh";
  }

  // Dispose

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    for (const handle of this.hostTerminals.values()) {
      try { handle.vsTerminal.dispose(); } catch {}
      try { handle.pseudoterminal.dispose(); } catch {}
    }
    this.hostTerminals.clear();

    for (const handle of this.clientTerminals.values()) {
      try { handle.pseudoterminal.terminate(); } catch {}
      try { handle.pseudoterminal.dispose(); } catch {}
      try { handle.vsTerminal.dispose(); } catch {}
    }
    this.clientTerminals.clear();

    this.outputBuffers.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
