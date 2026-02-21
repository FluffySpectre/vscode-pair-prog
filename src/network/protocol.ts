// Message Types

export enum MessageType {
  // Handshake
  Hello = "hello",
  Welcome = "welcome",

  // Cursor sync
  CursorUpdate = "cursorUpdate",
  FollowUpdate = "followUpdate",

  // File operations
  FileCreated = "fileCreated",
  FileDeleted = "fileDeleted",
  FileRenamed = "fileRenamed",
  FileSaveRequest = "fileSaveRequest",
  FileSaved = "fileSaved",

  // Whiteboard
  WhiteboardStroke = "whiteboardStroke",
  WhiteboardClear = "whiteboardClear",

  // Chat
  ChatMessage = "chatMessage",

  // Terminal sharing
  TerminalOutput = "terminalOutput",
  TerminalClear = "terminalClear",

  // Virtual workspace
  DirectoryTree = "directoryTree",
  FileContentRequest = "fileContentRequest",
  FileContentResponse = "fileContentResponse",

  // Lifecycle
  Ping = "ping",
  Pong = "pong",
  Disconnect = "disconnect",
  Error = "error",
}

// Base Message

export interface Message<T = unknown> {
  type: MessageType | string;
  seq: number;
  timestamp: number;
  payload: T;
}

// Payload Types

export interface HelloPayload {
  username: string;
  workspaceFolder: string; // root folder name for compatibility check
  passphrase?: string;
}

export interface WelcomePayload {
  hostUsername: string;
  openFiles: string[]; // workspace-relative paths of open documents
}

export interface CursorPosition {
  line: number;
  character: number;
}

export interface CursorUpdatePayload {
  filePath: string;
  username: string;
  cursors: Array<{
    position: CursorPosition;
    selection?: {
      start: CursorPosition;
      end: CursorPosition;
    };
  }>;
}

export interface FollowUpdatePayload {
  following: boolean;
  username: string;
}

export interface FileCreatedPayload {
  filePath: string;
  content: string;
}

export interface FileDeletedPayload {
  filePath: string;
}

export interface FileRenamedPayload {
  oldPath: string;
  newPath: string;
}

export interface FileSaveRequestPayload {
  filePath: string;
}

export interface FileSavedPayload {
  filePath: string;
}

export interface WhiteboardStrokePayload {
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

export interface WhiteboardClearPayload {}

export interface ChatMessagePayload {
  text: string;
  username: string;
}

export interface TerminalOutputPayload {
  data: string; // raw terminal data
  terminalName: string;
}

export interface TerminalClearPayload {}

export interface ErrorPayload {
  message: string;
  code?: string;
}

// Virtual workspace payloads

export interface DirectoryTreeEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: number;
}

export interface DirectoryTreePayload {
  entries: DirectoryTreeEntry[];
  workspaceName: string;
}

export interface FileContentRequestPayload {
  filePath: string;
}

export interface FileContentResponsePayload {
  filePath: string;
  content: string;
  encoding: "utf8" | "base64";
}

// Beacon (UDP discovery)

export const BEACON_PORT = 9877;
export const BEACON_MAGIC = "pairprog-beacon-v1";

export interface BeaconPayload {
  magic: string;
  name: string;
  address: string;
  workspaceFolder: string;
}

// Serialization

let _seqCounter = 0;

export function createMessage<T>(type: MessageType | string, payload: T): Message<T> {
  return {
    type,
    seq: _seqCounter++,
    timestamp: Date.now(),
    payload,
  };
}

export function serialize(msg: Message): string {
  return JSON.stringify(msg);
}

export function deserialize(data: string): Message {
  return JSON.parse(data) as Message;
}

export function resetSeq(): void {
  _seqCounter = 0;
}
