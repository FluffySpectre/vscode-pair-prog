import * as vscode from "vscode";

export enum ConnectionState {
  Idle = "idle",
  Hosting = "hosting",
  Connected = "connected",
  Reconnecting = "reconnecting",
  Disconnected = "disconnected",
}

/**
 * Manages the status bar item that shows the current state.
 */
export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private state: ConnectionState = ConnectionState.Idle;
  private address: string = "";
  private partnerName: string = "";
  private hasEditAccess = false;
  private autoHideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "pairprog.statusBarClicked";
    this.hide();
  }

  // State Updates

  setHosting(address: string): void {
    this.state = ConnectionState.Hosting;
    this.address = address;
    this.item.text = `$(broadcast) Hosting: ${address}`;
    this.item.tooltip = `Pair Programming session active.\nWaiting for client to connect.\nClick to copy address or stop.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  setHostConnected(address: string, clientName: string): void {
    this.state = ConnectionState.Hosting;
    this.address = address;
    this.partnerName = clientName;
    this.item.text = `$(broadcast) Hosting: ${clientName} connected`;
    this.item.tooltip = `Pair Programming with ${clientName}.\nSession address: ${address}\nClick for options.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  setConnected(address: string, hostName: string): void {
    this.state = ConnectionState.Connected;
    this.address = address;
    this.partnerName = hostName;
    this.hasEditAccess = false;
    this.item.text = `$(lock) Connected to ${hostName} (readonly)`;
    this.item.tooltip = `Connected to ${address}.\nPair Programming with ${hostName} (readonly).\nClick for options.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  setEditAccess(hasAccess: boolean): void {
    this.hasEditAccess = hasAccess;
    if (this.state === ConnectionState.Connected) {
      if (hasAccess) {
        this.item.text = `$(plug) Connected to ${this.partnerName}`;
        this.item.tooltip = `Connected to ${this.address}.\nPair Programming with ${this.partnerName}.\nClick for options.`;
      } else {
        this.item.text = `$(lock) Connected to ${this.partnerName} (readonly)`;
        this.item.tooltip = `Connected to ${this.address}.\nPair Programming with ${this.partnerName} (readonly).\nClick for options.`;
      }
    }
  }

  setFollowing(following: boolean): void {
    if (following) {
      this.item.text = `$(eye) Following ${this.partnerName}`;
      this.item.tooltip = `Following ${this.partnerName}'s cursor.\nClick for options.`;
    } else if (this.state === ConnectionState.Hosting) {
      this.item.text = `$(broadcast) Hosting: ${this.partnerName} connected`;
      this.item.tooltip = `Pair Programming with ${this.partnerName}.\nSession address: ${this.address}\nClick for options.`;
    } else if (this.state === ConnectionState.Connected) {
      const suffix = this.hasEditAccess ? "" : " (readonly)";
      const icon = this.hasEditAccess ? "$(plug)" : "$(lock)";
      this.item.text = `${icon} Connected to ${this.partnerName}${suffix}`;
      this.item.tooltip = `Connected to ${this.address}.\nPair Programming with ${this.partnerName}${suffix}.\nClick for options.`;
    }
  }

  setReconnecting(attempt: number): void {
    this.state = ConnectionState.Reconnecting;
    this.item.text = `$(sync~spin) Reconnecting... (${attempt})`;
    this.item.tooltip = "Connection lost. Attempting to reconnect...";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    this.item.show();
  }

  setDisconnected(): void {
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
    }
    this.state = ConnectionState.Disconnected;
    this.item.text = `$(debug-disconnect) Disconnected`;
    this.item.tooltip = "Pair Programming session ended.";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    this.item.show();

    // Auto-hide after 5 seconds
    this.autoHideTimer = setTimeout(() => {
      this.autoHideTimer = null;
      if (this.state === ConnectionState.Disconnected) {
        this.hide();
      }
    }, 5000);
  }

  hide(): void {
    this.state = ConnectionState.Idle;
    this.item.hide();
  }

  getState(): ConnectionState {
    return this.state;
  }

  getAddress(): string {
    return this.address;
  }

  // Dispose

  dispose(): void {
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
    this.item.dispose();
  }
}
