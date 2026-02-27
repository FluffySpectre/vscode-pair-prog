import * as vscode from "vscode";
import {
  Message,
  MessageType,
  MessageHandler,
  IntellisenseKind,
  IntellisenseRequestPayload,
  IntellisenseResponsePayload,
  IntellisenseResult,
  SerializedCompletionItem,
  SerializedCompletionList,
  SerializedHover,
  SerializedLocation,
  SerializedSignatureHelp,
  SerializedMarkdownContent,
  SerializedRange,
  createMessage,
} from "../network/protocol";
import { toRelativePath, toAbsoluteUri } from "../utils/pathUtils";

const TIMEOUT_MS = 5000;
const SYNC_DELAY_MS = 100;

interface PendingRequest {
  resolve: (payload: IntellisenseResponsePayload) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Proxies VS Code language features (completion, hover, go-to-definition,
 * signature help) from the client to the host, where real language servers run.
 */
export class IntellisenseSync implements vscode.Disposable, MessageHandler {
  readonly messageTypes: string[];
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private isHost: boolean;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private isProbing = false;

  constructor(sendFn: (msg: Message) => void, isHost: boolean) {
    this.sendFn = sendFn;
    this.isHost = isHost;
    this.messageTypes = isHost
      ? [MessageType.IntellisenseRequest as string]
      : [MessageType.IntellisenseResponse as string];
  }

  activate(): void {
    if (!this.isHost) {
      this.registerProviders();
    }
  }

  handleMessage(msg: Message): void {
    if (msg.type === MessageType.IntellisenseRequest) {
      this.handleRequest(msg.payload as IntellisenseRequestPayload);
    } else if (msg.type === MessageType.IntellisenseResponse) {
      this.handleResponse(msg.payload as IntellisenseResponsePayload);
    }
  }

  dispose(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  // Client: provider registration

  private registerProviders(): void {
    const selector: vscode.DocumentSelector = { scheme: "pairprog" };

    this.disposables.push(
      vscode.languages.registerCompletionItemProvider(
        selector,
        {
          provideCompletionItems: (doc, pos, token, ctx) => {
            if (this.isProbing) { return null; }
            return this.proxyCompletion(doc.uri, pos, token, ctx.triggerCharacter);
          },
        },
        ".", ":", "<", '"', "'", "/", "@", "#",
      ),
    );

    this.disposables.push(
      vscode.languages.registerHoverProvider(selector, {
        provideHover: (doc, pos, token) =>
          this.proxyHover(doc.uri, pos, token),
      }),
    );

    this.disposables.push(
      vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: (doc, pos, token) =>
          this.proxyDefinition(doc.uri, pos, token),
      }),
    );

    this.disposables.push(
      vscode.languages.registerSignatureHelpProvider(
        selector,
        {
          provideSignatureHelp: (doc, pos, token, ctx) =>
            this.proxySignatureHelp(doc.uri, pos, token, ctx.triggerCharacter ?? undefined),
        },
        "(", ",",
      ),
    );
  }

  // Client: proxy methods

  private async proxyCompletion(
    uri: vscode.Uri,
    position: vscode.Position,
    token: vscode.CancellationToken,
    triggerCharacter?: string,
  ): Promise<vscode.CompletionList | null> {
    const localPromise = this.probeLocalCompletions(uri, position, triggerCharacter);
    const hostPromise = this.sendRequest("completion", uri, position, token, triggerCharacter)
      .then((r) => r ? this.deserializeCompletionList(r.result as IntellisenseResult & { kind: "completion" }) : null);

    const [localList, hostList] = await Promise.all([localPromise, hostPromise]);
    if (!hostList) { return null; }

    const localKeys = new Set<string>();
    if (localList) {
      for (const item of localList.items) {
        localKeys.add(completionKey(item));
      }
    }

    // Keep only host items that local providers don't already provide
    const uniqueItems = hostList.items.filter((item) => !localKeys.has(completionKey(item)));
    if (uniqueItems.length === 0) { return null; }
    return new vscode.CompletionList(uniqueItems, hostList.isIncomplete);
  }

  private async probeLocalCompletions(
    uri: vscode.Uri,
    position: vscode.Position,
    triggerCharacter?: string,
  ): Promise<vscode.CompletionList | null> {
    this.isProbing = true;
    try {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        uri,
        position,
        triggerCharacter,
      );
      return list ?? null;
    } catch {
      return null;
    } finally {
      this.isProbing = false;
    }
  }

  private proxyHover(
    uri: vscode.Uri,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | null> {
    return this.sendRequest("hover", uri, position, token)
      .then((r) => r ? this.deserializeHover(r.result as IntellisenseResult & { kind: "hover" }) : null);
  }

  private proxyDefinition(
    uri: vscode.Uri,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | null> {
    return this.sendRequest("definition", uri, position, token)
      .then((r) => r ? this.deserializeLocations(r.result as IntellisenseResult & { kind: "definition" }) : null);
  }

  private proxySignatureHelp(
    uri: vscode.Uri,
    position: vscode.Position,
    token: vscode.CancellationToken,
    triggerCharacter?: string,
  ): Promise<vscode.SignatureHelp | null> {
    return this.sendRequest("signatureHelp", uri, position, token, triggerCharacter)
      .then((r) => r ? this.deserializeSignatureHelp(r.result as IntellisenseResult & { kind: "signatureHelp" }) : null);
  }

  // Client: request / response

  private sendRequest(
    kind: IntellisenseKind,
    uri: vscode.Uri,
    position: vscode.Position,
    token: vscode.CancellationToken,
    triggerCharacter?: string,
  ): Promise<IntellisenseResponsePayload | null> {
    const filePath = toRelativePath(uri);
    if (!filePath || token.isCancellationRequested) {
      return Promise.resolve(null);
    }

    const requestId = String(++this.requestCounter);
    const payload: IntellisenseRequestPayload = {
      requestId,
      kind,
      filePath,
      position: { line: position.line, character: position.character },
      triggerCharacter,
    };

    return new Promise<IntellisenseResponsePayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(null);
      }, TIMEOUT_MS);

      const onCancel = token.onCancellationRequested(() => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(requestId);
        }
        onCancel.dispose();
        resolve(null);
      });

      this.pendingRequests.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          onCancel.dispose();
          this.pendingRequests.delete(requestId);
          resolve(response);
        },
        timer,
      });

      this.sendFn(createMessage(MessageType.IntellisenseRequest, payload));
    });
  }

  private handleResponse(payload: IntellisenseResponsePayload): void {
    const pending = this.pendingRequests.get(payload.requestId);
    if (!pending) { return; }
    pending.resolve(payload);
  }

  // Host: request handler

  private async handleRequest(payload: IntellisenseRequestPayload): Promise<void> {
    // Wait for ShareDB to sync the triggering keystroke (see SYNC_DELAY_MS)
    await new Promise((r) => setTimeout(r, SYNC_DELAY_MS));

    const uri = this.toHostUri(payload.filePath);
    const position = new vscode.Position(payload.position.line, payload.position.character);

    try {
      let result: IntellisenseResult;

      switch (payload.kind) {
        case "completion":
          result = { kind: "completion", data: await this.executeCompletion(uri, position, payload.triggerCharacter) };
          break;
        case "hover":
          result = { kind: "hover", data: await this.executeHover(uri, position) };
          break;
        case "definition":
          result = { kind: "definition", data: await this.executeDefinition(uri, position) };
          break;
        case "signatureHelp":
          result = { kind: "signatureHelp", data: await this.executeSignatureHelp(uri, position, payload.triggerCharacter) };
          break;
        default:
          return;
      }

      this.sendFn(createMessage(MessageType.IntellisenseResponse, {
        requestId: payload.requestId,
        result,
      } as IntellisenseResponsePayload));
    } catch (err) {
      console.warn(`[PairProg Host] IntelliSense error (${payload.kind}):`, err);
      this.sendFn(createMessage(MessageType.IntellisenseResponse, {
        requestId: payload.requestId,
        result: { kind: payload.kind, data: null } as IntellisenseResult,
      } as IntellisenseResponsePayload));
    }
  }

  private toHostUri(relativePath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders!;
    const wsFolder = folders.find((f) => f.uri.scheme === "file") || folders[0];
    return vscode.Uri.joinPath(wsFolder.uri, relativePath);
  }

  // Host: execute VS Code language commands

  private async executeCompletion(
    uri: vscode.Uri,
    position: vscode.Position,
    triggerCharacter?: string,
  ): Promise<SerializedCompletionList | null> {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      position,
      triggerCharacter,
    );
    if (!list) { return null; }
    return {
      isIncomplete: list.isIncomplete ?? false,
      items: list.items.map((item) => this.serializeCompletionItem(item)),
    };
  }

  private async executeHover(
    uri: vscode.Uri,
    position: vscode.Position,
  ): Promise<SerializedHover | null> {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position,
    );
    if (!hovers || hovers.length === 0) { return null; }
    const contents: SerializedMarkdownContent[] = [];
    let range: SerializedRange | undefined;
    for (const hover of hovers) {
      for (const c of hover.contents) {
        contents.push(serializeMarkdown(c));
      }
      if (!range && hover.range) {
        range = serializeRange(hover.range);
      }
    }
    return { contents, range };
  }

  private async executeDefinition(
    uri: vscode.Uri,
    position: vscode.Position,
  ): Promise<SerializedLocation[] | null> {
    const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider",
      uri,
      position,
    );
    if (!result || result.length === 0) { return null; }

    const locations: SerializedLocation[] = [];
    for (const item of result) {
      const loc = this.serializeLocationOrLink(item);
      if (loc) { locations.push(loc); }
    }
    return locations.length > 0 ? locations : null;
  }

  private async executeSignatureHelp(
    uri: vscode.Uri,
    position: vscode.Position,
    triggerCharacter?: string,
  ): Promise<SerializedSignatureHelp | null> {
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      uri,
      position,
      triggerCharacter,
    );
    if (!help) { return null; }
    return {
      signatures: help.signatures.map((sig) => ({
        label: sig.label,
        documentation: sig.documentation ? serializeMarkdown(sig.documentation as vscode.MarkdownString | string) : undefined,
        parameters: (sig.parameters || []).map((p) => ({
          label: p.label,
          documentation: p.documentation ? serializeMarkdown(p.documentation as vscode.MarkdownString | string) : undefined,
        })),
      })),
      activeSignature: help.activeSignature,
      activeParameter: help.activeParameter,
    };
  }

  // Host: serialization helpers

  private serializeCompletionItem(item: vscode.CompletionItem): SerializedCompletionItem {
    const result: SerializedCompletionItem = {
      label: typeof item.label === "string"
        ? item.label
        : { label: item.label.label, detail: item.label.detail, description: item.label.description },
    };

    if (item.kind !== undefined) { result.kind = item.kind; }
    if (item.detail) { result.detail = item.detail; }
    if (item.documentation) {
      result.documentation = serializeMarkdown(item.documentation as vscode.MarkdownString | string);
    }
    if (item.sortText) { result.sortText = item.sortText; }
    if (item.filterText) { result.filterText = item.filterText; }
    if (item.preselect) { result.preselect = item.preselect; }

    if (item.insertText) {
      if (typeof item.insertText === "string") {
        result.insertText = item.insertText;
      } else {
        result.insertText = { snippet: item.insertText.value };
      }
    }

    if (item.range) {
      if (item.range instanceof vscode.Range) {
        result.range = serializeRange(item.range);
      } else {
        result.range = {
          inserting: serializeRange(item.range.inserting),
          replacing: serializeRange(item.range.replacing),
        };
      }
    }

    if (item.commitCharacters && item.commitCharacters.length > 0) {
      result.commitCharacters = item.commitCharacters;
    }

    if (item.additionalTextEdits && item.additionalTextEdits.length > 0) {
      result.additionalTextEdits = item.additionalTextEdits.map((edit) => ({
        range: serializeRange(edit.range),
        newText: edit.newText,
      }));
    }

    return result;
  }

  private serializeLocationOrLink(
    item: vscode.Location | vscode.LocationLink,
  ): SerializedLocation | null {
    let targetUri: vscode.Uri;
    let targetRange: vscode.Range;

    if (item instanceof vscode.Location) {
      targetUri = item.uri;
      targetRange = item.range;
    } else {
      targetUri = item.targetUri;
      targetRange = item.targetSelectionRange ?? item.targetRange;
    }

    const relativePath = toRelativePath(targetUri);
    if (!relativePath) { return null; }
    return { filePath: relativePath, range: serializeRange(targetRange) };
  }

  // Client: deserialization helpers

  private deserializeCompletionList(
    r: IntellisenseResult & { kind: "completion" },
  ): vscode.CompletionList | null {
    if (!r.data) { return null; }
    const items = r.data.items.map((item) => this.deserializeCompletionItem(item));
    return new vscode.CompletionList(items, r.data.isIncomplete);
  }

  private deserializeCompletionItem(item: SerializedCompletionItem): vscode.CompletionItem {
    const label = typeof item.label === "string"
      ? item.label
      : { label: item.label.label, detail: item.label.detail, description: item.label.description };

    const ci = new vscode.CompletionItem(label, item.kind);

    if (item.detail) { ci.detail = item.detail; }
    if (item.documentation) { ci.documentation = deserializeMarkdown(item.documentation); }
    if (item.sortText) { ci.sortText = item.sortText; }
    if (item.filterText) { ci.filterText = item.filterText; }
    if (item.preselect) { ci.preselect = item.preselect; }

    if (item.insertText) {
      if (typeof item.insertText === "string") {
        ci.insertText = item.insertText;
      } else {
        ci.insertText = new vscode.SnippetString(item.insertText.snippet);
      }
    }

    if (item.range) {
      if ("inserting" in item.range) {
        ci.range = {
          inserting: deserializeRange(item.range.inserting),
          replacing: deserializeRange(item.range.replacing),
        };
      } else {
        ci.range = deserializeRange(item.range);
      }
    }

    if (item.commitCharacters) { ci.commitCharacters = item.commitCharacters; }

    if (item.additionalTextEdits) {
      ci.additionalTextEdits = item.additionalTextEdits.map(
        (edit) => new vscode.TextEdit(deserializeRange(edit.range), edit.newText),
      );
    }

    return ci;
  }

  private deserializeHover(
    r: IntellisenseResult & { kind: "hover" },
  ): vscode.Hover | null {
    if (!r.data) { return null; }
    const contents = r.data.contents.map((c) => deserializeMarkdown(c));
    const range = r.data.range ? deserializeRange(r.data.range) : undefined;
    return new vscode.Hover(contents, range);
  }

  private deserializeLocations(
    r: IntellisenseResult & { kind: "definition" },
  ): vscode.Location[] | null {
    if (!r.data) { return null; }
    return r.data.map((loc) =>
      new vscode.Location(toAbsoluteUri(loc.filePath), deserializeRange(loc.range)),
    );
  }

  private deserializeSignatureHelp(
    r: IntellisenseResult & { kind: "signatureHelp" },
  ): vscode.SignatureHelp | null {
    if (!r.data) { return null; }
    const help = new vscode.SignatureHelp();
    help.activeSignature = r.data.activeSignature;
    help.activeParameter = r.data.activeParameter;
    help.signatures = r.data.signatures.map((sig) => {
      const info = new vscode.SignatureInformation(sig.label);
      if (sig.documentation) {
        info.documentation = deserializeMarkdown(sig.documentation);
      }
      info.parameters = sig.parameters.map((p) => {
        const param = new vscode.ParameterInformation(p.label);
        if (p.documentation) {
          param.documentation = deserializeMarkdown(p.documentation);
        }
        return param;
      });
      return info;
    });
    return help;
  }
}

// Shared serialization utilities

function serializeRange(range: vscode.Range): SerializedRange {
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

function deserializeRange(r: SerializedRange): vscode.Range {
  return new vscode.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter);
}

function serializeMarkdown(
  content: vscode.MarkdownString | vscode.MarkedString | string,
): SerializedMarkdownContent {
  if (typeof content === "string") { return content; }
  if (content instanceof vscode.MarkdownString) {
    return { kind: "markdown", value: content.value };
  }
  if (typeof content === "object" && "language" in content) {
    return { kind: "markdown", value: `\`\`\`${content.language}\n${content.value}\n\`\`\`` };
  }
  return String(content);
}

function deserializeMarkdown(c: SerializedMarkdownContent): vscode.MarkdownString | string {
  if (typeof c === "string") { return c; }
  return new vscode.MarkdownString(c.value);
}

function completionKey(item: vscode.CompletionItem): string {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  return `${label}|${item.kind ?? ""}`;
}
