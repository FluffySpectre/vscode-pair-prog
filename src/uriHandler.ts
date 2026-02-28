import * as vscode from "vscode";
import { SessionManager } from "./session/sessionManager";
import { decodeInviteCode } from "./network/inviteCode";

/**
 * Registers the URI handler for invite links
 */
export function registerUriHandler(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
): void {
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

        if (sessionManager.isClient) {
          vscode.window.showWarningMessage("Already connected to a session. Leave it first.");
          return;
        }
        if (sessionManager.isHosting) {
          vscode.window.showWarningMessage("You are currently hosting a session. Stop it first.");
          return;
        }

        let decoded;
        try {
          decoded = decodeInviteCode(code);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Invalid invite code: ${err.message}`);
          return;
        }

        let passphrase: string | undefined;
        if (decoded.requiresPassphrase) {
          passphrase = await vscode.window.showInputBox({
            prompt: "This session requires a passphrase",
            password: true,
            placeHolder: "Passphrase",
          });
          if (passphrase === undefined) { return; }
        }

        if (decoded.type === "relay") {
          const relayUrl = sessionManager.buildRelayMainUrl(decoded.relayUrl, decoded.code);
          await sessionManager.connectToSession("relay", passphrase, { relayUrl, code: decoded.code });
        } else {
          await sessionManager.connectToSession(decoded.address, passphrase);
        }
      },
    })
  );
}
