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

export interface ErrorPayload {
  message: string;
  code?: string;
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
