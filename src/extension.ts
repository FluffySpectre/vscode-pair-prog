import * as vscode from "vscode";
import { HostSession } from "./session/hostSession";
import { ClientSession } from "./session/clientSession";
import { StatusBar } from "./ui/statusBar";
import { AboutPanel } from "./ui/aboutPanel";
import { BeaconListener, DiscoveredSession } from "./network/beacon";
import { PairProgFileSystemProvider } from "./vfs/pairProgFileSystemProvider";

const VFS_SCHEME = "pairprog";

let hostSession: HostSession | null = null;
let clientSession: ClientSession | null = null;
let statusBar: StatusBar;
let vfsProvider: PairProgFileSystemProvider;

// Activate

export function activate(context: vscode.ExtensionContext) {
  console.log("[PairProg] Extension activated");

  // Register VFS provider singleton
  vfsProvider = new PairProgFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(VFS_SCHEME, vfsProvider, { isCaseSensitive: true })
  );

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  // Check for pending reconnect (extension was reloaded after adding first workspace folder)
  const pending = context.globalState.get<{ address: string }>("pairprog.pendingReconnect");
  if (pending) {
    context.globalState.update("pairprog.pendingReconnect", undefined);
    autoReconnect(pending.address, context);
  } else {
    // Only clean up stale VFS when there's no pending reconnect
    cleanupStaleVfs();
  }

  // Start Hosting

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.startSession", async () => {
      if (hostSession?.isActive) {
        vscode.window.showWarningMessage(
          "A hosting session is already active."
        );
        return;
      }

      if (clientSession?.isActive) {
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
        hostSession = new HostSession(statusBar, context);
        await hostSession.start();
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to start session: ${err.message}`
        );
        hostSession?.dispose();
        hostSession = null;
      }
    })
  );

  // Stop Hosting

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.stopSession", () => {
      if (!hostSession?.isActive) {
        vscode.window.showWarningMessage("No active hosting session to stop.");
        return;
      }

      hostSession.stop();
      hostSession = null;
    })
  );

  // Join Session

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.joinSession", async () => {
      if (clientSession?.isActive) {
        vscode.window.showWarningMessage(
          "Already connected to a session. Leave it first."
        );
        return;
      }

      if (hostSession?.isActive) {
        vscode.window.showWarningMessage(
          "You are currently hosting a session. Stop it first."
        );
        return;
      }

      let address: string | undefined;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Searching for pair programming sessions on your local network...",
          cancellable: true,
        },
        async (_, token) => {
          const listener = new BeaconListener();

          const found: DiscoveredSession[] = await Promise.race([
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

          if (token.isCancellationRequested) { return; }

          type SessionItem = vscode.QuickPickItem & { sessionAddress?: string };

          const items: SessionItem[] = found.map((s) => ({
            label: `$(broadcast) ${s.name}`,
            description: s.workspaceFolder,
            detail: s.address,
            sessionAddress: s.address,
          }));

          items.push({
            label: "$(edit) Enter address manually",
            description: "Type the host's IP:PORT",
            sessionAddress: undefined,
          });

          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: found.length > 0
              ? `Found ${found.length} session(s) - select one or enter manually`
              : "No sessions found - enter address manually",
            title: "Join Pair Programming Session",
          });

          if (!picked) { return; }

          if (picked.sessionAddress) {
            address = picked.sessionAddress;
          } else {
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

      try {
        clientSession = new ClientSession(statusBar, context, vfsProvider);
        await clientSession.connect(address);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to connect: ${err.message}`
        );
        clientSession?.dispose();
        clientSession = null;
      }
    })
  );

  // Leave Session

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.leaveSession", () => {
      if (!clientSession?.isActive) {
        vscode.window.showWarningMessage("No active session to leave.");
        return;
      }

      clientSession.disconnect();
      clientSession = null;
    })
  );

  // Toggle Follow Mode

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.toggleFollowMode", () => {
      if (hostSession?.isActive) {
        hostSession.toggleFollowMode();
      } else if (clientSession?.isActive) {
        clientSession.toggleFollowMode();
      } else {
        vscode.window.showWarningMessage("No active pair programming session.");
      }
    })
  );

  // Open Whiteboard

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.openWhiteboard", () => {
      if (hostSession?.isActive) {
        hostSession.openWhiteboard();
      } else if (clientSession?.isActive) {
        clientSession.openWhiteboard();
      }
    })
  );

  // Send Message

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.sendMessage", async () => {
      if (hostSession?.isActive) {
        await hostSession.sendMessage();
      } else if (clientSession?.isActive) {
        await clientSession.sendMessage();
      } else {
        vscode.window.showWarningMessage("No active pair programming session.");
      }
    })
  );

  // Share Terminal (host only)

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.shareTerminal", async () => {
      if (!hostSession?.isActive) {
        vscode.window.showWarningMessage("Terminal sharing is only available to the host.");
        return;
      }
      await hostSession.shareTerminal();
    })
  );

  // Stop Sharing Terminal (host only)

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.stopSharingTerminal", () => {
      if (!hostSession?.isActive) {
        vscode.window.showWarningMessage("No active hosting session.");
        return;
      }
      hostSession.stopSharingTerminal();
    })
  );

  // About

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.openAbout", () => {
      AboutPanel.show(context);
    })
  );

  // Status Bar Click

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.statusBarClicked", async () => {
      const items: vscode.QuickPickItem[] = [];

      if (hostSession?.isActive) {
        items.push(
          { label: "$(eye) Toggle Follow Mode", description: "" },
          { label: "$(edit) Open Whiteboard", description: "" },
          { label: "$(comment) Send Message", description: "" },
          { label: "$(terminal) Share Terminal", description: "" },
          { label: "$(terminal-kill) Stop Sharing Terminal", description: "" },
          { label: "$(copy) Copy Session Address", description: statusBar.getAddress() },
          { label: "$(info) About", description: "" },
          { label: "$(debug-stop) Stop Hosting", description: "" },
        );
      } else if (clientSession?.isActive) {
        items.push(
          { label: "$(eye) Toggle Follow Mode", description: "" },
          { label: "$(edit) Open Whiteboard", description: "" },
          { label: "$(comment) Send Message", description: "" },
          { label: "$(info) About", description: "" },
          { label: "$(debug-disconnect) Disconnect", description: "" },
        );
      } else {
        items.push(
          { label: "$(broadcast) Start Hosting", description: "" },
          { label: "$(plug) Join Session", description: "" },
          { label: "$(info) About", description: "" }
        );
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Pair Programming Session",
      });

      if (!picked) { return; }

      if (picked.label.includes("Toggle Follow Mode")) {
        vscode.commands.executeCommand("pairprog.toggleFollowMode");
      } else if (picked.label.includes("Open Whiteboard")) {
        vscode.commands.executeCommand("pairprog.openWhiteboard");
      } else if (picked.label.includes("Send Message")) {
        vscode.commands.executeCommand("pairprog.sendMessage");
      } else if (picked.label.includes("Stop Sharing Terminal")) {
        vscode.commands.executeCommand("pairprog.stopSharingTerminal");
      } else if (picked.label.includes("Share Terminal")) {
        vscode.commands.executeCommand("pairprog.shareTerminal");
      } else if (picked.label.includes("Copy Session Address")) {
        await vscode.env.clipboard.writeText(statusBar.getAddress());
        vscode.window.showInformationMessage("Session address copied!");
      } else if (picked.label.includes("Stop Hosting")) {
        vscode.commands.executeCommand("pairprog.stopSession");
      } else if (picked.label.includes("Disconnect")) {
        vscode.commands.executeCommand("pairprog.leaveSession");
      } else if (picked.label.includes("Start Hosting")) {
        vscode.commands.executeCommand("pairprog.startSession");
      } else if (picked.label.includes("Join Session")) {
        vscode.commands.executeCommand("pairprog.joinSession");
      } else if (picked.label.includes("About")) {
        vscode.commands.executeCommand("pairprog.openAbout");
      }
    })
  );
}

// Auto-reconnect after extension reload

async function autoReconnect(address: string, context: vscode.ExtensionContext): Promise<void> {
  try {
    clientSession = new ClientSession(statusBar, context, vfsProvider);
    await clientSession.connect(address);
  } catch (err: any) {
    console.warn("[PairProg] Auto-reconnect failed:", err.message);
    clientSession?.dispose();
    clientSession = null;
    cleanupStaleVfs();
  }
}

// Stale VFS cleanup

function cleanupStaleVfs(): void {
  const folders = vscode.workspace.workspaceFolders || [];
  const vfsIndex = folders.findIndex((f) => f.uri.scheme === VFS_SCHEME);
  if (vfsIndex !== -1) {
    vscode.workspace.updateWorkspaceFolders(vfsIndex, 1);
  }
}

// Deactivate

export function deactivate() {
  // Do NOT call cleanupStaleVfs() here - if we're being reloaded after
  // adding the first workspace folder, we need the VFS folder to persist
  // so auto-reconnect can use it.

  hostSession?.dispose();
  hostSession = null;

  clientSession?.dispose();
  clientSession = null;

  statusBar?.dispose();
}
