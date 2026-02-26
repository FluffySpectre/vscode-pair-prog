import * as vscode from "vscode";
import { SessionManager } from "./session/sessionManager";
import { FeatureRegistry, SessionRole } from "./features";
import { AboutPanel } from "./ui/aboutPanel";

/**
 * Registers all VS Code commands and the status bar quick-pick menu.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
  featureRegistry: FeatureRegistry,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.startSession", () =>
      sessionManager.startHosting()
    ),

    vscode.commands.registerCommand("pairprog.stopSession", () =>
      sessionManager.stopHosting()
    ),

    vscode.commands.registerCommand("pairprog.joinSession", () =>
      sessionManager.joinSession()
    ),

    vscode.commands.registerCommand("pairprog.leaveSession", () =>
      sessionManager.leaveSession()
    ),

    vscode.commands.registerCommand("pairprog.toggleFollowMode", () =>
      sessionManager.toggleFollowMode()
    ),

    vscode.commands.registerCommand("pairprog.jumpToPartner", () =>
      sessionManager.jumpToPartner()
    ),

    vscode.commands.registerCommand("pairprog.grantEditAccess", () =>
      sessionManager.grantEditAccess()
    ),

    vscode.commands.registerCommand("pairprog.openAbout", () =>
      AboutPanel.show(context)
    ),
  );

  // Register feature-provided commands
  for (const cmd of featureRegistry.getCommands()) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd.commandId, async () => {
        if (!sessionManager.hasActiveSession) {
          vscode.window.showWarningMessage("No active pair programming session.");
          return;
        }
        await cmd.execute();
      })
    );
  }

  // Status bar click → quick-pick menu
  context.subscriptions.push(
    vscode.commands.registerCommand("pairprog.statusBarClicked", () =>
      showStatusBarMenu(sessionManager, featureRegistry)
    )
  );
}

async function showStatusBarMenu(
  sessionManager: SessionManager,
  featureRegistry: FeatureRegistry,
): Promise<void> {
  const items: vscode.QuickPickItem[] = [];

  if (sessionManager.isHosting) {
    if (!sessionManager.hasGrantedEditAccess) {
      items.push({ label: "$(lock) Grant Edit Access", description: "Allow partner to edit files" });
    } /*else {
      items.push({ label: "$(check) Edit Access Granted", description: "Partner can edit files" });
    }*/

    items.push(
      { label: "$(eye) Toggle Follow Mode", description: "" },
      { label: "$(location) Jump to Partner", description: "(Ctrl+Shift+J)" },
    );

    for (const cmd of featureRegistry.getCommands("host" as SessionRole)) {
      items.push({ label: `$(${cmd.icon}) ${cmd.label}`, description: cmd.description || "" });
    }

    items.push(
      { label: "$(link) Copy Invite Link", description: "" },
      { label: "$(copy) Copy Session Address", description: sessionManager.sessionAddress },
      { label: "$(info) About", description: "" },
      { label: "$(debug-stop) Stop Hosting", description: "" },
    );
  } else if (sessionManager.isClient) {
    items.push(
      { label: "$(eye) Toggle Follow Mode", description: "" },
      { label: "$(location) Jump to Partner", description: "(Ctrl+Shift+J)" },
    );

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
      { label: "$(info) About", description: "" },
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Pair Programming Session",
  });

  if (!picked) { return; }

  if (picked.label.includes("Toggle Follow Mode")) {
    vscode.commands.executeCommand("pairprog.toggleFollowMode");
  } else if (picked.label.includes("Jump to Partner")) {
    vscode.commands.executeCommand("pairprog.jumpToPartner");
  } else if (picked.label.includes("Copy Invite Link")) {
    await vscode.env.clipboard.writeText(sessionManager.inviteLink);
    vscode.window.showInformationMessage("Invite link copied!");
  } else if (picked.label.includes("Copy Session Address")) {
    await vscode.env.clipboard.writeText(sessionManager.sessionAddress);
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
    const featureCmd = featureRegistry.getCommands().find(
      (cmd) => picked.label.includes(cmd.label)
    );
    if (featureCmd) {
      vscode.commands.executeCommand(featureCmd.commandId);
    }
  }
}
