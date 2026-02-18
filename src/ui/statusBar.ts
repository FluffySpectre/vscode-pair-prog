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
  private peerName: string = "";

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
    this.peerName = clientName;
    this.item.text = `$(broadcast) Hosting: ${clientName} connected`;
    this.item.tooltip = `Pair Programming with ${clientName}.\nSession address: ${address}\nClick for options.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  setConnected(address: string, hostName: string): void {
    this.state = ConnectionState.Connected;
    this.address = address;
    this.peerName = hostName;
    this.item.text = `$(plug) Connected to ${hostName}`;
    this.item.tooltip = `Connected to ${address}.\nPair Programming with ${hostName}.\nClick for options.`;
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  setFollowing(following: boolean): void {
    if (following) {
      this.item.text = `$(eye) Following ${this.peerName}`;
      this.item.tooltip = `Following ${this.peerName}'s cursor.\nClick for options.`;
    } else if (this.state === ConnectionState.Hosting) {
      this.item.text = `$(broadcast) Hosting: ${this.peerName} connected`;
      this.item.tooltip = `Pair Programming with ${this.peerName}.\nSession address: ${this.address}\nClick for options.`;
    } else if (this.state === ConnectionState.Connected) {
      this.item.text = `$(plug) Connected to ${this.peerName}`;
      this.item.tooltip = `Connected to ${this.address}.\nPair Programming with ${this.peerName}.\nClick for options.`;
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
    this.state = ConnectionState.Disconnected;
    this.item.text = `$(debug-disconnect) Disconnected`;
    this.item.tooltip = "Pair Programming session ended.";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    this.item.show();

    // Auto-hide after 5 seconds
    setTimeout(() => {
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
    this.item.dispose();
  }
}
