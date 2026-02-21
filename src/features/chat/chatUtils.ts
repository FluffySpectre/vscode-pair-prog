import * as vscode from "vscode";
import { ChatMessagePayload } from "../../network/protocol";

export async function showChatMessage(
  payload: ChatMessagePayload,
  fallbackSender: string,
  onReply: () => Promise<void>
): Promise<void> {
  const text = payload.text ?? "";
  const sender = payload.username || fallbackSender;
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  const buttons: string[] = urlMatch
    ? ["Open Link", "Copy", "Reply"]
    : ["Copy", "Reply"];

  const action = await vscode.window.showInformationMessage(
    `${sender}: ${text}`,
    ...buttons
  );

  if (action === "Open Link" && urlMatch) {
    await vscode.env.openExternal(vscode.Uri.parse(urlMatch[0]));
  } else if (action === "Copy") {
    await vscode.env.clipboard.writeText(text);
  } else if (action === "Reply") {
    await onReply();
  }
}

export async function promptAndSendMessage(
  isConnected: boolean,
  notConnectedWarning: string,
  recipientLabel: string,
  onSend: (text: string) => void
): Promise<void> {
  if (!isConnected) {
    vscode.window.showWarningMessage(notConnectedWarning);
    return;
  }

  const text = await vscode.window.showInputBox({
    prompt: `Send a message to ${recipientLabel}`,
    placeHolder: "Type a message, link, or code snippet...",
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Message cannot be empty.";
      }
      if (value.length > 500) {
        return `Too long (${value.length}/500 chars).`;
      }
      return null;
    },
  });

  if (!text || text.trim().length === 0) {
    return;
  }

  onSend(text.trim());
}
