import * as vscode from "vscode";
import { HostSession } from "./session/hostSession";
import { ClientSession } from "./session/clientSession";
import { StatusBar } from "./ui/statusBar";
import { AboutPanel } from "./ui/aboutPanel";
import { BeaconListener, DiscoveredSession } from "./network/beacon";
import { PairProgFileSystemProvider } from "./vfs/pairProgFileSystemProvider";
import {
  FeatureRegistry,
  WhiteboardFeature,
  ChatFeature,
  TerminalFeature,
  SessionRole,
} from "./features";
import { MessageRouter } from "./network/messageRouter";
import { decodeInviteCode } from "./network/inviteCode";

const VFS_SCHEME = "pairprog";

let hostSession: HostSession | null = null;
let clientSession: ClientSession | null = null;
let statusBar: StatusBar;
let vfsProvider: PairProgFileSystemProvider;
let extensionContext: vscode.ExtensionContext;
let messageRouter: MessageRouter;
let featureRegistry: FeatureRegistry;

// Activate

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  console.log("[PairProg] Extension activated");

  // Register VFS provider singleton
  vfsProvider = new PairProgFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(VFS_SCHEME, vfsProvider, { isCaseSensitive: true })
  );

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  // Create message router and feature registry, then register all additional features
  messageRouter = new MessageRouter();
  featureRegistry = new FeatureRegistry(messageRouter);
  featureRegistry.register(new WhiteboardFeature());
  featureRegistry.register(new ChatFeature());
  featureRegistry.register(new TerminalFeature());

  // URI handler for invite links
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        if (uri.path !== "/join") { return; }

        const params = new URLSearchParams(uri.query);
        const code = params.get("code");
        if (!code) {
          vscode.window.showErrorMessage("Invalid invite link: missing code.");
          return;
        }

        if (clientSession?.isActive) {
          vscode.window.showWarningMessage("Already connected to a session. Leave it first.");
          return;
        }
        if (hostSession?.isActive) {
          vscode.window.showWarningMessage("You are currently hosting a session. Stop it first.");
          return;
        }

        let decoded: { address: string; requiresPassphrase: boolean };
        try {
          decoded = decodeInviteCode(code);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Invalid invite code: ${err.message}`);
          return;
        }

        const address = decoded.address;

        let passphrase: string | undefined;
        if (decoded.requiresPassphrase) {
          passphrase = await vscode.window.showInputBox({
            prompt: "This session requires a passphrase",
            password: true,
            placeHolder: "Passphrase",
          });
          if (passphrase === undefined) { return; }
        }

        try {
          clientSession = new ClientSession(statusBar, context, vfsProvider, featureRegistry, messageRouter);
          await clientSession.connect(address, passphrase || undefined);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to connect: ${err.message}`);
          clientSession?.dispose();
          clientSession = null;
        }
      },
    })
  );

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
        hostSession = new HostSession(statusBar, context, featureRegistry, messageRouter);
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
      let requiresPassphrase = false;

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

          type SessionItem = vscode.QuickPickItem & { sessionAddress?: string; requiresPassphrase?: boolean };

          const items: SessionItem[] = found.map((s) => ({
            label: s.requiresPassphrase ? `$(lock) ${s.name}` : `$(broadcast) ${s.name}`,
            description: s.workspaceFolder,
            detail: s.address,
            sessionAddress: s.address,
            requiresPassphrase: s.requiresPassphrase,
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
            requiresPassphrase = picked.requiresPassphrase || false;

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

      // Ask for passphrase if required
      let passphrase: string | undefined;
      if (requiresPassphrase) {
        passphrase = await vscode.window.showInputBox({
          prompt: "Enter session passphrase (leave blank if none)",
          password: true,
          placeHolder: "Passphrase",
        });
        if (passphrase === undefined) { return; }
      }

      try {
        clientSession = new ClientSession(statusBar, context, vfsProvider, featureRegistry, messageRouter);
        await clientSession.connect(address, passphrase || undefined);
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

  // Jump to Partner

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.jumpToPartner", async () => {
      if (hostSession?.isActive) {
        await hostSession.jumpToPartner();
      } else if (clientSession?.isActive) {
        await clientSession.jumpToPartner();
      } else {
        vscode.window.showWarningMessage("No active pair programming session.");
      }
    })
  );

  // Grant Edit Access

  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.grantEditAccess", () => {
      if (!hostSession?.isActive) {
        vscode.window.showWarningMessage("No active hosting session.");
        return;
      }
      hostSession.grantEditAccess();
    })
  );

  for (const cmd of featureRegistry.getCommands()) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd.commandId, async () => {
        if (!hostSession?.isActive && !clientSession?.isActive) {
          vscode.window.showWarningMessage("No active pair programming session.");
          return;
        }
        await cmd.execute();
      })
    );
  }

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
          { label: "$(location) Jump to Partner", description: "(Ctrl+Shift+J)" },
        );

        if (!hostSession.hasGrantedEditAccess) {
          items.push({ label: "$(lock) Grant Edit Access", description: "Allow partner to edit files" });
        } else {
          items.push({ label: "$(check) Edit Access Granted", description: "Partner can edit files" });
        }

        // Add feature items for host role
        for (const cmd of featureRegistry.getCommands("host" as SessionRole)) {
          items.push({ label: `$(${cmd.icon}) ${cmd.label}`, description: cmd.description || "" });
        }

        items.push(
          { label: "$(link) Copy Invite Link", description: "" },
          { label: "$(copy) Copy Session Address", description: statusBar.getAddress() },
          { label: "$(info) About", description: "" },
          { label: "$(debug-stop) Stop Hosting", description: "" },
        );
      } else if (clientSession?.isActive) {
        items.push(
          { label: "$(eye) Toggle Follow Mode", description: "" },
          { label: "$(location) Jump to Partner", description: "(Ctrl+Shift+J)" },
        );

        // Add feature items for client role
        for (const cmd of featureRegistry.getCommands("client" as SessionRole)) {
          items.push({ label: `$(${cmd.icon}) ${cmd.label}`, description: cmd.description || "" });
        }

        items.push(
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

      // Check core commands first
      if (picked.label.includes("Toggle Follow Mode")) {
        vscode.commands.executeCommand("pairprog.toggleFollowMode");
      } else if (picked.label.includes("Jump to Partner")) {
        vscode.commands.executeCommand("pairprog.jumpToPartner");
      } else if (picked.label.includes("Copy Invite Link")) {
        if (hostSession) {
          await vscode.env.clipboard.writeText(hostSession.inviteLink);
          vscode.window.showInformationMessage("Invite link copied!");
        }
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
      } else if (picked.label.includes("Grant Edit Access")) {
        vscode.commands.executeCommand("pairprog.grantEditAccess");
      } else if (picked.label.includes("About")) {
        vscode.commands.executeCommand("pairprog.openAbout");
      } else {
        // Check feature commands dynamically
        const featureCmd = featureRegistry.getCommands().find(
          (cmd) => picked.label.includes(cmd.label)
        );
        if (featureCmd) {
          vscode.commands.executeCommand(featureCmd.commandId);
        }
      }
    })
  );
}

// Auto-reconnect after extension reload

async function autoReconnect(address: string, context: vscode.ExtensionContext): Promise<void> {
  try {
    const passphrase = await context.secrets.get("pairprog.reconnectPassphrase");
    await context.secrets.delete("pairprog.reconnectPassphrase");
    clientSession = new ClientSession(statusBar, context, vfsProvider, featureRegistry, messageRouter);
    await clientSession.connect(address, passphrase);
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
  hostSession?.dispose();
  hostSession = null;

  const pending = extensionContext?.globalState.get("pairprog.pendingReconnect");
  if (pending) {
    clientSession = null;
  } else {
    clientSession?.dispose();
    clientSession = null;
  }

  featureRegistry?.disposeAll();
  statusBar?.dispose();
}
