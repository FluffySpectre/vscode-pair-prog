# vscode-pair-prog

Real-time peer-to-peer pair programming on a shared workspace.

## Quick Start

### Host a Session

1. Open a workspace (e.g., a git repo)
2. Run command: **PairProg: Start Hosting Session** (`Ctrl+Shift+P`)
3. Copy the displayed address (e.g., `192.168.1.5:9876`)
4. Share the address with your partner

### Join a Session

1. Open the **same workspace** (same repo, same branch)
2. Run command: **PairProg: Join Session**
3. Enter the host's address
4. You're connected — edits sync in real-time. Wohooo!

## How It Works

```
┌──────────────┐     WebSocket (LAN)     ┌──────────────┐
│     HOST     │<----------------------->│    CLIENT    │
│              │                         │              │
│  Source of   │  -- Edit (client->host) │  Sends edits │
│  truth for   │  -- Edit confirmed -->  │  to host,    │
│  all files   │  -- FullSync -------->  │  receives    │
│              │  -- CursorUpdate <--->  │  confirmed   │
│  Files saved │  -- FileCreated ----->  │  state back  │
│  to disk     │  -- FileDeleted ----->  │              │
│  HERE only   │  -- FileRenamed ----->  │  No disk     │
│              │                         │  writes for  │
│              │                         │  text edits  │
└──────────────┘                         └──────────────┘
```

## Configuration

| Setting                   | Default       | Description                          |
|---------------------------|---------------|--------------------------------------|
| `pairprog.port`             | `9876`        | WebSocket server port                |
| `pairprog.username`         | OS username   | Your display name                    |
| `pairprog.highlightColor`   | `#00BFFF`     | Remote partner's cursor color        |
| `pairprog.ignoredPatterns`  | see below     | Glob patterns to exclude from sync   |

Default ignored patterns:
```json
["node_modules/**", ".git/**", "*.lock", "out/**", "dist/**"]
```

## Commands

| Command                          | Description                    |
|----------------------------------|--------------------------------|
| `PairProg: Start Hosting Session`  | Start a WebSocket server       |
| `PairProg: Stop Hosting Session`   | Stop hosting and disconnect    |
| `PairProg: Join Session`           | Connect to a host              |
| `PairProg: Leave Session`          | Disconnect from host           |

Click the status bar item for a quick-pick menu with these options.

## Development

### Setup

```bash
cd vscode-pair-prog
npm install
npm run compile
```

### Debug / Run

1. Open this folder in VS Code
2. Press **F5** to launch the Extension Development Host
3. In the new VS Code window, open a workspace folder


### Packaging

```bash
npm install -g @vscode/vsce
vsce package
```

This produces a `.vsix` file you can install in VS Code via:
**Extensions -> ⋯ -> Install from VSIX...**
