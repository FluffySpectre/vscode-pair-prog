// Protocol version
// Increment whenever the message format changes in a backwards-incompatible way. 
// Both sides reject a connection if the versions do not match exactly.
export const PROTOCOL_VERSION = 1;

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
  WhiteboardEntityAdd = "whiteboardEntityAdd",
  WhiteboardEntityUpdate = "whiteboardEntityUpdate",
  WhiteboardEntityDelete = "whiteboardEntityDelete",
  WhiteboardFullSync = "whiteboardFullSync",
  WhiteboardClear = "whiteboardClear",
  WhiteboardCursorUpdate = "whiteboardCursorUpdate",

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
  protocolVersion: number;
}

export interface WelcomePayload {
  hostUsername: string;
  openFiles: string[]; // workspace-relative paths of open documents
  protocolVersion: number;
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
  isDirectory: boolean;
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

// Whiteboard entity types

export type WhiteboardEntityType = "stroke" | "rect" | "line" | "text";

export interface WhiteboardEntityBase {
  id: string;
  type: WhiteboardEntityType;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  createdBy: string;
}

export interface WhiteboardStrokeEntity extends WhiteboardEntityBase {
  type: "stroke";
  points: { x: number; y: number }[];
  strokeWidth: number;
}

export interface WhiteboardRectEntity extends WhiteboardEntityBase {
  type: "rect";
  strokeWidth: number;
  filled: boolean;
}

export interface WhiteboardLineEntity extends WhiteboardEntityBase {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
}

export interface WhiteboardTextEntity extends WhiteboardEntityBase {
  type: "text";
  text: string;
  fontSize: number;
}

export type WhiteboardEntity =
  | WhiteboardStrokeEntity
  | WhiteboardRectEntity
  | WhiteboardLineEntity
  | WhiteboardTextEntity;

export interface WhiteboardEntityAddPayload {
  entity: WhiteboardEntity;
}

export interface WhiteboardEntityUpdatePayload {
  id: string;
  changes: Record<string, unknown>;
}

export interface WhiteboardEntityDeletePayload {
  id: string;
}

export interface WhiteboardFullSyncPayload {
  entities: WhiteboardEntity[];
}

export interface WhiteboardClearPayload {}

export interface WhiteboardCursorUpdatePayload {
  username: string;
  x: number;        // world-space X coordinate
  y: number;        // world-space Y coordinate
  visible: boolean; // false when cursor leaves the whiteboard canvas
}

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
  requiresPassphrase?: boolean;
}

// Message Handler

export interface MessageHandler {
  readonly messageTypes: string[];
  handleMessage(msg: Message): void | Promise<void>;
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
