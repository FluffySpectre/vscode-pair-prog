import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export class AboutPanel {
  private static currentPanel: AboutPanel | undefined;
  private panel: vscode.WebviewPanel;
  private _disposed = false;

  static show(context: vscode.ExtensionContext) {
    if (AboutPanel.currentPanel && !AboutPanel.currentPanel._disposed) {
      AboutPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    AboutPanel.currentPanel = new AboutPanel(context);
  }

  private constructor(context: vscode.ExtensionContext) {
    const ext = vscode.extensions.getExtension("bjoernbosse.vscode-pair-prog");
    const pkg = ext?.packageJSON ?? {};

    this.panel = vscode.window.createWebviewPanel(
      "pairprogAbout",
      "About PairProg",
      vscode.ViewColumn.One,
      { enableScripts: false }
    );

    const htmlPath = path.join(context.extensionPath, "src", "ui", "webviews", "about.html");
    const template = fs.readFileSync(htmlPath, "utf-8");
    this.panel.webview.html = template
      .replace("{{name}}", pkg.displayName ?? "")
      .replace("{{version}}", pkg.version ?? "")
      .replace("{{description}}", pkg.description ?? "")
      .replace("{{publisher}}", "Björn Bosse");

    this.panel.onDidDispose(() => {
      this._disposed = true;
      if (AboutPanel.currentPanel === this) {
        AboutPanel.currentPanel = undefined;
      }
    });
  }
}
