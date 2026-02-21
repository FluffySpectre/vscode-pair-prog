import * as vscode from "vscode";
import { Message } from "../network/protocol";

export type SessionRole = "host" | "client";

export interface FeatureContext {
  sendFn: (msg: Message) => void;
  role: SessionRole;
  username: string;
  partnerUsername: string;
  extensionContext: vscode.ExtensionContext;
}

export interface FeatureCommand {
  commandId: string; // Unique command ID (needs to be registered in package.json)
  label: string;
  icon: string;
  roles: SessionRole[]; // Roles that can execute this command
  execute: () => void | Promise<void>;
}

export interface Feature extends vscode.Disposable {
  readonly id: string;
  readonly messageTypes: string[];

  activate(context: FeatureContext): void | Promise<void>;
  handleMessage(msg: Message): void | Promise<void>;
  getCommands(): FeatureCommand[];
  deactivate(): void;
  dispose(): void;
}
