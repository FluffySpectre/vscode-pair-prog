import * as vscode from "vscode";
import { HostSession } from "./hostSession";
import { ClientSession } from "./clientSession";
import { StatusBar } from "../ui/statusBar";
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";
import { FeatureRegistry } from "../features";
import { MessageRouter } from "../network/messageRouter";
import { BeaconListener, DiscoveredSession } from "../network/beacon";
import { RelayConnector, RelaySessionInfo } from "../network/relayConnector";

const VFS_SCHEME = "pairprog";

/**
 * Manages session state and lifecycle for both host and client sessions.
 */
export class SessionManager {
  private hostSession: HostSession | null = null;
  private clientSession: ClientSession | null = null;

  constructor(
    private readonly statusBar: StatusBar,
    private readonly context: vscode.ExtensionContext,
    private readonly vfsProvider: PairProgFileSystemProvider,
    private readonly featureRegistry: FeatureRegistry,
    private readonly messageRouter: MessageRouter,
  ) {}

  get isHosting(): boolean {
    return this.hostSession?.isActive ?? false;
  }

  get isClient(): boolean {
    return this.clientSession?.isActive ?? false;
  }

  get hasActiveSession(): boolean {
    return this.isHosting || this.isClient;
  }

  get inviteLink(): string {
    return this.hostSession?.inviteLink ?? "";
  }

  get hasGrantedEditAccess(): boolean {
    return this.hostSession?.hasGrantedEditAccess ?? false;
  }

  get sessionAddress(): string {
    return this.hostSession?.sessionAddress ?? "";
  }

  async startHosting(): Promise<void> {
    if (this.isHosting) {
      vscode.window.showWarningMessage("A hosting session is already active.");
      return;
    }
    if (this.isClient) {
      vscode.window.showWarningMessage(
        "You are currently connected as a client. Leave that session first."
      );
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showErrorMessage(
        "Open a workspace folder before starting a pair programming session."
      );
      return;
    }

    try {
      this.hostSession = new HostSession(
        this.statusBar, this.context, this.featureRegistry, this.messageRouter
      );
      await this.hostSession.start();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to start session: ${err.message}`);
      this.hostSession?.dispose();
      this.hostSession = null;
    }
  }

  stopHosting(): void {
    if (!this.isHosting) {
      vscode.window.showWarningMessage("No active hosting session to stop.");
      return;
    }
    this.hostSession!.stop();
    this.hostSession = null;
  }

  async joinSession(): Promise<void> {
    if (this.isClient) {
      vscode.window.showWarningMessage("Already connected to a session. Leave it first.");
      return;
    }
    if (this.isHosting) {
      vscode.window.showWarningMessage(
        "You are currently hosting a session. Stop it first."
      );
      return;
    }

    const config = vscode.workspace.getConfiguration("pairprog");
    const relayUrl = config.get<string>("relayServer");

    let address: string | undefined;
    let requiresPassphrase = false;
    let relayInfo: { relayUrl: string; code: string } | undefined;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Searching for pair programming sessions...",
        cancellable: true,
      },
      async (_, token) => {
        // Discover LAN sessions and relay sessions in parallel
        const listener = new BeaconListener();

        const lanPromise: Promise<DiscoveredSession[]> = Promise.race([
          new Promise<DiscoveredSession[]>((resolve) => {
            listener.on("done", resolve);
            listener.on("error", () => resolve([]));
            try {
              listener.listen();
            } catch {
              resolve([]);
            }
          }),
          new Promise<DiscoveredSession[]>((resolve) => {
            token.onCancellationRequested(() => {
              listener.stop();
              resolve([]);
            });
          }),
        ]);

        let relayPromise: Promise<RelaySessionInfo[]>;
        if (relayUrl) {
          const connector = new RelayConnector(relayUrl);
          relayPromise = connector.listSessions().catch(() => []);
        } else {
          relayPromise = Promise.resolve([]);
        }

        const [lanSessions, relaySessions] = await Promise.all([lanPromise, relayPromise]);

        if (token.isCancellationRequested) { return; }

        type SessionItem = vscode.QuickPickItem & {
          sessionAddress?: string;
          requiresPassphrase?: boolean;
          relayCode?: string;
          action?: "manual" | "code";
        };

        const items: SessionItem[] = [];

        // Relay sessions first
        for (const s of relaySessions) {
          items.push({
            label: s.requiresPassphrase ? `$(lock) $(cloud) ${s.name}` : `$(cloud) ${s.name}`,
            description: `${s.workspace} (relay)`,
            detail: `Session code: ${s.code}`,
            relayCode: s.code,
            requiresPassphrase: s.requiresPassphrase,
          });
        }

        // LAN sessions
        for (const s of lanSessions) {
          items.push({
            label: s.requiresPassphrase ? `$(lock) ${s.name}` : `$(broadcast) ${s.name}`,
            description: s.workspaceFolder,
            detail: s.address,
            sessionAddress: s.address,
            requiresPassphrase: s.requiresPassphrase,
          });
        }

        // Manual options
        if (relayUrl) {
          items.push({
            label: "$(key) Enter session code",
            description: "Join a relay session by code",
            action: "code",
          });
        }

        items.push({
          label: "$(edit) Enter address manually",
          description: "Type the host's IP:PORT",
          action: "manual",
        });

        const totalFound = lanSessions.length + relaySessions.length;

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: totalFound > 0
            ? `Found ${totalFound} session(s) - select one or enter manually`
            : "No sessions found - enter address or code manually",
          title: "Join Pair Programming Session",
        });

        if (!picked) { return; }

        if (picked.relayCode) {
          // Relay session selected
          relayInfo = { relayUrl: this.buildRelayMainUrl(relayUrl!, picked.relayCode), code: picked.relayCode };
          requiresPassphrase = picked.requiresPassphrase || false;
          address = "relay"; // Placeholder; connection goes through relay
        } else if (picked.action === "code") {
          const code = await vscode.window.showInputBox({
            prompt: "Enter session code",
            placeHolder: "e.g., K7XM3R",
            validateInput: (value) => {
              if (!value || value.trim().length === 0) { return "Session code is required."; }
              return null;
            },
          });
          if (!code) { return; }
          const trimmed = code.trim().toUpperCase();
          relayInfo = { relayUrl: this.buildRelayMainUrl(relayUrl!, trimmed), code: trimmed };
          address = "relay";
          // We don't know if it needs passphrase, so we'll ask anyway below
          requiresPassphrase = true;
        } else if (picked.sessionAddress) {
          address = picked.sessionAddress;
          requiresPassphrase = picked.requiresPassphrase || false;
        } else if (picked.action === "manual") {
          address = await vscode.window.showInputBox({
            prompt: "Enter the host's address",
            placeHolder: "192.168.1.5:9876",
            validateInput: (value) => {
              if (!value) { return "Address is required."; }
              const parts = value.split(":");
              if (parts.length !== 2 || isNaN(Number(parts[1]))) {
                return "Format: IP:PORT (e.g., 192.168.1.5:9876)";
              }
              return null;
            },
          });
        }
      }
    );

    if (!address) { return; }

    let passphrase: string | undefined;
    if (requiresPassphrase) {
      passphrase = await vscode.window.showInputBox({
        prompt: "Enter session passphrase (leave blank if none)",
        password: true,
        placeHolder: "Passphrase",
      });
      if (passphrase === undefined) { return; }
    }

    await this.connectToSession(address, passphrase, relayInfo);
  }

  buildRelayMainUrl(relayUrl: string, code: string): string {
    const base = relayUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    return `${base}/relay/${code}/main?role=client`;
  }

  async connectToSession(address: string, passphrase?: string, relay?: { relayUrl: string; code: string }): Promise<void> {
    try {
      this.clientSession = new ClientSession(
        this.statusBar, this.context, this.vfsProvider, this.featureRegistry, this.messageRouter
      );
      await this.clientSession.connect(address, passphrase, relay);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to connect: ${err.message}`);
      this.clientSession?.dispose();
      this.clientSession = null;
    }
  }

  leaveSession(): void {
    if (!this.isClient) {
      vscode.window.showWarningMessage("No active session to leave.");
      return;
    }
    this.clientSession!.disconnect();
    this.clientSession = null;
  }

  toggleFollowMode(): void {
    if (this.isHosting) {
      this.hostSession!.toggleFollowMode();
    } else if (this.isClient) {
      this.clientSession!.toggleFollowMode();
    } else {
      vscode.window.showWarningMessage("No active pair programming session.");
    }
  }

  async jumpToPartner(): Promise<void> {
    if (this.isHosting) {
      await this.hostSession!.jumpToPartner();
    } else if (this.isClient) {
      await this.clientSession!.jumpToPartner();
    } else {
      vscode.window.showWarningMessage("No active pair programming session.");
    }
  }

  grantEditAccess(): void {
    if (!this.isHosting) {
      vscode.window.showWarningMessage("No active hosting session.");
      return;
    }
    this.hostSession!.grantEditAccess();
  }

  async checkPendingReconnect(): Promise<void> {
    const pending = this.context.globalState.get<{
      address: string;
      relay?: { relayUrl: string; code: string };
    }>("pairprog.pendingReconnect");
    if (pending) {
      this.context.globalState.update("pairprog.pendingReconnect", undefined);
      await this.autoReconnect(pending.address, pending.relay);
    } else {
      this.cleanupStaleVfs();
    }
  }

  private async autoReconnect(address: string, relay?: { relayUrl: string; code: string }): Promise<void> {
    try {
      const passphrase = await this.context.secrets.get("pairprog.reconnectPassphrase");
      await this.context.secrets.delete("pairprog.reconnectPassphrase");
      this.clientSession = new ClientSession(
        this.statusBar, this.context, this.vfsProvider, this.featureRegistry, this.messageRouter
      );
      await this.clientSession.connect(address, passphrase, relay);
    } catch (err: any) {
      console.warn("[PairProg] Auto-reconnect failed:", err.message);
      this.clientSession?.dispose();
      this.clientSession = null;
      this.cleanupStaleVfs();
    }
  }

  private cleanupStaleVfs(): void {
    const folders = vscode.workspace.workspaceFolders || [];
    const vfsIndex = folders.findIndex((f) => f.uri.scheme === VFS_SCHEME);
    if (vfsIndex !== -1) {
      vscode.workspace.updateWorkspaceFolders(vfsIndex, 1);
    }
  }

  dispose(): void {
    this.hostSession?.dispose();
    this.hostSession = null;

    const pending = this.context.globalState.get("pairprog.pendingReconnect");
    if (pending) {
      this.clientSession = null;
    } else {
      this.clientSession?.dispose();
      this.clientSession = null;
    }
  }
}
