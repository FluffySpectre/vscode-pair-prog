// Message Types

export enum MessageType {
  // Handshake
  Hello = "hello",
  Welcome = "welcome",

  // Document sync
  Edit = "edit",
  FullSync = "fullSync",
  OpenFile = "openFile",

  // Cursor sync
  CursorUpdate = "cursorUpdate",
  FollowUpdate = "followUpdate",

  // File operations
  FileCreated = "fileCreated",
  FileDeleted = "fileDeleted",
  FileRenamed = "fileRenamed",

  // Whiteboard
  WhiteboardStroke = "whiteboardStroke",
  WhiteboardClear = "whiteboardClear",

  // Terminal sharing
  TerminalShared = "terminalShared",
  TerminalOutput = "terminalOutput",
  TerminalInput = "terminalInput",
  TerminalResize = "terminalResize",
  TerminalClosed = "terminalClosed",
  TerminalUnshared = "terminalUnshared",
  TerminalReadonlyChanged = "terminalReadonlyChanged",

  // Lifecycle
  Ping = "ping",
  Pong = "pong",
  Disconnect = "disconnect",
  Error = "error",
}

// Base Message

export interface Message<T = unknown> {
  type: MessageType;
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

export interface TextChange {
  rangeOffset: number; // start offset in the document
  rangeLength: number; // number of chars replaced (0 = pure insert)
  text: string; // replacement / inserted text
}

export interface EditPayload {
  filePath: string; // workspace-relative
  version: number; // document version this edit is based on
  changes: TextChange[];
}

export interface FullSyncPayload {
  filePath: string;
  content: string;
  version: number;
}

export interface OpenFilePayload {
  filePath: string;
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

export interface WhiteboardStrokePayload {
  points: { x: number; y: number }[];
  color: string;
  width: number;
}

export interface WhiteboardClearPayload {}

// Terminal payloads

export interface TerminalSharedPayload {
  terminalId: string;
  name: string;
  cols: number;
  rows: number;
  readonly?: boolean; // defaults to true if absent
}

export interface TerminalOutputPayload {
  terminalId: string;
  data: string;
}

export interface TerminalInputPayload {
  terminalId: string;
  data: string;
}

export interface TerminalResizePayload {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalClosedPayload {
  terminalId: string;
}

export interface TerminalUnsharedPayload {
  terminalId: string;
}

export interface TerminalReadonlyChangedPayload {
  terminalId: string;
  readonly: boolean;
}

export interface ErrorPayload {
  message: string;
  code?: string;
}

// Beacon (UDP discovery - not a WebSocket message)

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

export function createMessage<T>(type: MessageType, payload: T): Message<T> {
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
