import * as vscode from "vscode";
import { StatusBar } from "./ui/statusBar";
import { PairProgFileSystemProvider } from "./vfs/pairProgFileSystemProvider";
import {
  FeatureRegistry,
  WhiteboardFeature,
  ChatFeature,
  TerminalFeature,
} from "./features";
import { MessageRouter } from "./network/messageRouter";
import { SessionManager } from "./session/sessionManager";
import { registerCommands } from "./commands";
import { registerUriHandler } from "./uriHandler";

const VFS_SCHEME = "pairprog";

let sessionManager: SessionManager;
let featureRegistry: FeatureRegistry;
let statusBar: StatusBar;

export function activate(context: vscode.ExtensionContext) {
  console.log("[PairProg] Extension activated");

  const vfsProvider = new PairProgFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(VFS_SCHEME, vfsProvider, { isCaseSensitive: true })
  );

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  const messageRouter = new MessageRouter();
  featureRegistry = new FeatureRegistry(messageRouter);
  featureRegistry.register(new WhiteboardFeature());
  featureRegistry.register(new ChatFeature());
  featureRegistry.register(new TerminalFeature());

  sessionManager = new SessionManager(statusBar, context, vfsProvider, featureRegistry, messageRouter);

  registerUriHandler(context, sessionManager);
  registerCommands(context, sessionManager, featureRegistry);

  sessionManager.checkPendingReconnect();
}

export function deactivate() {
  sessionManager?.dispose();
  featureRegistry?.disposeAll();
  statusBar?.dispose();
}
