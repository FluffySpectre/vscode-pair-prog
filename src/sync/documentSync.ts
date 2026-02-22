import * as vscode from "vscode";
import {
  Message,
  MessageType,
  MessageHandler,
  FileSaveRequestPayload,
  FileSavedPayload,
  createMessage,
} from "../network/protocol";
import { toRelativePath, toAbsoluteUri, isSyncableDocument } from "../utils/pathUtils";
import { PairProgFileSystemProvider } from "../vfs/pairProgFileSystemProvider";

/**
 * DocumentSync handles file save delegation.
 *
 * - Client: intercepts saves and delegates to host via existing WebSocket protocol
 * - Host: handles FileSaveRequest (saves to disk, responds with FileSaved)
 */
export class DocumentSync implements vscode.Disposable, MessageHandler {
  private disposables: vscode.Disposable[] = [];
  private sendFn: (msg: Message) => void;
  private isHost: boolean;
  private vfsProvider?: PairProgFileSystemProvider;
  private _readonly = false;

  constructor(sendFn: (msg: Message) => void, isHost: boolean, vfsProvider?: PairProgFileSystemProvider) {
    this.sendFn = sendFn;
    this.isHost = isHost;
    this.vfsProvider = vfsProvider;
  }

  setReadonly(readonly: boolean): void {
    this._readonly = readonly;
  }

  // MessageHandler

  get messageTypes(): string[] {
    return this.isHost ? [MessageType.FileSaveRequest] : [MessageType.FileSaved];
  }

  async handleMessage(msg: Message): Promise<void> {
    switch (msg.type) {
      case MessageType.FileSaveRequest:
        await this.handleFileSaveRequest(msg.payload as FileSaveRequestPayload);
        break;
      case MessageType.FileSaved:
        await this.handleFileSaved(msg.payload as FileSavedPayload);
        break;
    }
  }

  activate(): void {
    // Client: intercept save and forward to host
    if (!this.isHost) {
      this.disposables.push(
        vscode.workspace.onWillSaveTextDocument((e) => {
          if (this._readonly) {
            return;
          }
          if (!isSyncableDocument(e.document.uri)) {
            return;
          }
          const filePath = toRelativePath(e.document.uri);
          if (!filePath) {
            return;
          }

          // Suppress the local save and ask the host to save instead
          e.waitUntil(
            Promise.resolve().then(() => {
              this.sendFn(
                createMessage(MessageType.FileSaveRequest, {
                  filePath,
                } as FileSaveRequestPayload)
              );
              return [];
            })
          );
        })
      );
    }
  }

  // Host: client requested a file save

  async handleFileSaveRequest(payload: FileSaveRequestPayload): Promise<void> {
    const uri = toAbsoluteUri(payload.filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
      this.sendFn(
        createMessage(MessageType.FileSaved, {
          filePath: payload.filePath,
        } as FileSavedPayload)
      );
    } catch {
      // If save fails, silently ignore - client will keep dirty state
    }
  }

  // Client: host confirmed the file was saved

  async handleFileSaved(payload: FileSavedPayload): Promise<void> {
    const uri = toAbsoluteUri(payload.filePath);

    // For VFS documents, fire a change event to clear the dirty state
    if (this.vfsProvider) {
      this.vfsProvider.fireChanged(payload.filePath);
      return;
    }

    try {
      await vscode.commands.executeCommand("workbench.action.files.revert", uri);
    } catch {
      // Ignore if revert fails
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
