# codex-telegram

A Telegram bot gateway that turns your local Codex sessions into a multi-project, multi-threaded, multi-agent remote control panel.

Built for developers who already use Codex locally and want to:

- Keep working through Telegram when away from the desk
- Manage multiple repos and conversation threads in one place
- Review history, check run status, and retry from anywhere
- Fork sub-agents from a running thread
- Import existing Codex / App / CLI sessions

This is a **local-first** project: the bot runs on your own machine and talks directly to your Codex home and session data.

## Full-Auth Mode

Every Codex session runs in **full-auth** mode — no approval prompts, no sandbox restrictions:

| Call | Parameters | Purpose |
|------|-----------|---------|
| `threadStart` | `approvalPolicy: 'never'`, `sandbox: 'danger-full-access'` | Thread-level: skip all approvals, full access |
| `turnStart` | `approvalPolicy: 'never'`, `sandboxPolicy: { type: 'dangerFullAccess' }` | Per-turn override to enforce full access |

Both are set in `src/core/app-server-client.ts` to ensure every thread and turn runs unrestricted.

> Note: When the bot falls back to `codex exec` mode (the spawn path), Codex may still request approval. The bot treats this as a `waiting_approval` failure and prompts the user to retry.

> ⚠️ This gives the AI unrestricted file, shell, and network access. Run it in a trusted environment and restrict Telegram access via the built-in access controls.

## Channel Architecture

The bot connects to the Codex `app-server` over WebSocket, enabling real-time sync between Telegram and a local CLI:

```
┌─────────────┐     Relay WS     ┌─────────────┐     App-Server WS    ┌──────────────────┐
│ connect.ts  │◀────────────────▶│ Telegram Bot │◀───────────────────▶│  codex app-server │
│ (Local CLI) │                  │  (Node.js)   │                     │  (auto-managed)   │
└─────────────┘                  └──────┬───────┘                     └──────────────────┘
                                        │
                                        ▼
                                  Telegram API
```

The bot is the **sole client** to app-server. The CLI tool (`connect.ts`) connects indirectly through the bot's relay WebSocket, so the bot can intercept all events and forward them to both Telegram and the CLI.

With the channel active:

- **Streaming output** — replies appear progressively in Telegram ("⏳ Thinking..." → live text → final message)
- **Bidirectional sync** — Telegram messages appear in the CLI and vice versa (prefixed "🖥️ Local:")
- **Auto-import** — threads created via `connect.ts` are automatically imported into the bot's database
- **Graceful degradation** — if app-server is unavailable, the bot falls back to `codex exec` mode

### How It Works

1. On startup, the bot spawns `codex app-server` and connects via WebSocket (JSON-RPC)
2. A relay WebSocket server starts on a random port
3. Both URLs are saved to `~/.codex-telegram/app-server.json`
4. Telegram messages trigger `turn/start` RPC calls
5. `item/agentMessage/delta` notifications stream to Telegram and relay clients in real time
6. Messages from `connect.ts` are also routed through app-server
7. If app-server crashes, the bot reconnects automatically (exponential backoff)

## Core Concepts

`codex-telegram` layers an operational model on top of Codex sessions:

| Concept | Description |
|---------|-------------|
| `Source` | A Codex home directory (shared or bot-isolated) |
| `Project` | A repository or working directory |
| `Thread` | A Codex conversation bound to a project |
| `Agent` | A sub-task forked from a parent thread |
| `Run` | A single execution attempt (queued → running → completed/failed/cancelled) |

## Command Reference

### Quick Reference

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Usage guide |
| `/new` | Create a new thread |
| `/cwd` | Show current working directory |
| `/kill` | Kill the running process |
| `/cancel` | Cancel the current execution |
| `/undo` | Undo the last turn |
| `/pair <code>` | Authorize via pairing code |
| `/ss [app]` | Screenshot (specific app window or full screen) |
| `/unlock` | Unlock the screen |
| `/lock` | Lock the screen |
| `/wake` | Wake the display |
| `/windows` | List all open windows |
| `/project` | Project management |
| `/thread` | Thread management |
| `/agent` | Agent management |
| `/run` | Run management |
| `/source` | Data source management |

### Screen Control

These commands provide remote control of the macOS desktop, implemented in `src/bot/commands/general.ts`:

**`/ss [app]`** — Screenshot

- No argument: captures the full screen
- With argument: captures the specified app's window (e.g., `/ss Ghostty`)
- Uses the `scripts/tg-screenshot` shell script under the hood
- Images wider than 2560px are downscaled 2× via Python PIL (requires `Pillow`)
- 45-second timeout

**`/unlock`** — Unlock screen

- Requires the `SCREEN_PASSWORD` environment variable
- Wakes the display → sends a spacebar keystroke → runs the Swift unlock script to type the password
- Uses `caffeinate` to keep the display awake during the process

**`/lock`** — Lock screen

- Calls `pmset displaysleepnow` to put the display to sleep

**`/wake`** — Wake display

- Calls `caffeinate -u -t 10` to wake and hold for 10 seconds

**`/windows`** — List windows

- Uses the CoreGraphics API to enumerate all windows (including minimized and those in other Spaces)
- Automatically filters out system windows (Dock, Control Center, Notification Center, Raycast, and 10+ others)

### Source Commands

| Command | Description |
|---------|-------------|
| `/source list [page] [pageSize]` | List data sources |
| `/source search <keyword>` | Search sources |
| `/source show <id>` | View source details |
| `/source enable <id>` | Enable a source |
| `/source disable <id>` | Disable a source |
| `/source where <index\|id>` | Locate a source |

### Project Commands

| Command | Description |
|---------|-------------|
| `/project list [--sort name\|recent]` | List projects |
| `/project search <keyword>` | Search projects |
| `/project show` | View current project |
| `/project new <name> [cwd]` | Create a project |
| `/project use <index\|id\|name\|cwd>` | Switch project |
| `/project rename <new_name>` | Rename |
| `/project archive` | Archive |
| `/project delete` | Delete |
| `/project set-source <shared\|bot_local>` | Set default source |
| `/project set-source-mode <prefer\|force>` | Set source selection mode |
| `/project set-agent-source-override <allow\|deny>` | Agent source override policy |
| `/project set-agent-auto-writeback <on\|off>` | Agent auto-writeback |
| `/project sync` | Sync |
| `/project sync status` | Sync status |

### Thread Commands

| Command | Description |
|---------|-------------|
| `/thread list [--sort name\|recent]` | List threads |
| `/thread search <keyword>` | Search threads |
| `/thread show` | View current thread |
| `/thread new` | Create a thread |
| `/thread use <index\|thread_id>` | Switch thread |
| `/thread rename <new_name>` | Rename |
| `/thread move <project>` | Move to another project |
| `/thread history [N] [--since ISO] [--until ISO]` | View history |
| `/thread turns [N] [--turn N]` | View by turn |
| `/thread summary [N]` | Summary view |
| `/thread pin` / `unpin` | Pin / unpin |
| `/thread archive` / `delete` | Archive / delete |

### Agent Commands

| Command | Description |
|---------|-------------|
| `/agent spawn <role> <task>` | Fork a sub-agent |
| `/agent list` | List agents |
| `/agent show <id>` | View agent details |
| `/agent cancel <id>` | Cancel an agent |
| `/agent apply <id>` | Apply agent results to the parent thread |

Agent roles: `worker`, `explorer`, `reviewer`, `summarizer`, `general`

### Run Commands

| Command | Description |
|---------|-------------|
| `/run list [status]` | List runs |
| `/run show <run_id>` | View run details |
| `/run cancel <run_id>` | Cancel a run |
| `/run retry <run_id>` | Retry a run |

## tg-screenshot Script

Located at `scripts/tg-screenshot`. Handles macOS screenshots and screen control.

### Usage

```bash
# Full-screen screenshot
tg-screenshot

# Capture a specific app window
tg-screenshot --app Ghostty

# Unlock first, then screenshot
tg-screenshot --unlock <password> --app Ghostty

# Unlock only
tg-screenshot --unlock <password>

# Lock screen only
tg-screenshot --lock
```

### Options

| Flag | Description |
|------|-------------|
| `--app <name>` | Capture a specific app's window |
| `--unlock <password>` | Unlock the screen before capturing |
| `-o <path>` | Output file path |
| `--lock` | Lock the screen only |

### Localized App Name Mapping

The script maps common Chinese app names to their macOS process names:

- `微信` / `wechat` → WeChat
- `QQ` → QQ / 腾讯QQ

### Window Capture Flow

1. Activate the target app via `osascript`
2. Enumerate window IDs using CoreGraphics `CGWindowListCopyWindowInfo` (with `.optionAll` to include all windows)
3. Capture by window ID with `screencapture -x -l"$WID"`
4. Fall back to full-screen capture if the window can't be found

## Environment Variables

Create a `.env` file in the project root:

```dotenv
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_here      # From @BotFather
OWNER_TELEGRAM_ID=your_telegram_id_here      # Your Telegram user ID

# Optional
# SCREEN_PASSWORD=                           # macOS screen unlock password (for /unlock)
# CODEX_HOME=                                # Override the default shared Codex home path
# CODEX_APP_SERVER_PORT=                     # Fixed app-server port (default: auto-assigned)
```

| Variable | Required | Description |
|----------|:--------:|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram Bot Token (from @BotFather) |
| `OWNER_TELEGRAM_ID` | ✅ | Bot owner's Telegram user ID |
| `SCREEN_PASSWORD` | ❌ | macOS screen unlock password, used by `/unlock` |
| `CODEX_HOME` | ❌ | Override shared Codex home path (default: `~/.codex`) |
| `CODEX_APP_SERVER_PORT` | ❌ | Fixed app-server WebSocket port (default: auto-assigned) |

## Installation

### Prerequisites

- Node.js 20+
- A Telegram Bot Token (from @BotFather)
- Codex installed and accessible locally
- A persistent macOS host (screen control commands depend on macOS APIs)

### Setup

```bash
# Clone the repo
git clone <repo-url> ~/.codex-telegram
cd ~/.codex-telegram

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_ID
```

## Running

```bash
# Development (hot reload)
npm run dev

# Production
npm run start

# Local CLI client
npm run connect -- --new
```

npm scripts use `scripts/with-node.sh` to ensure the real Node.js binary is used (bypassing Bun's `node` shim), since `tsx`, `vitest`, and `better-sqlite3` require Node.

## First Run

On startup, the bot will:

1. Load `.env`
2. Bootstrap owner access if `OWNER_TELEGRAM_ID` is set
3. Initialize the state store and importer
4. Start polling for Telegram updates

In Telegram:

1. Send `/start`
2. Send `/help` for the usage guide
3. Complete `/pair` if needed
4. Send a message or use `/new` to start working

## Architecture

### Module Layout

**Root modules:**

| File | Description |
|------|-------------|
| `server.ts` | Bot entry point, startup and routing |
| `session-manager.ts` | Orchestration — project/thread/session lifecycle |
| `run-scheduler.ts` | Run queue and state machine |
| `agent-manager.ts` | Sub-agent tracking and writeback |
| `history-reader.ts` | Thread history extraction and summarization |
| `importer.ts` | Incremental import and sync |
| `state-store.ts` | SQLite persistent storage |
| `storage-policy.ts` | Source and writeback policies |
| `project-normalizer.ts` | Path → project name inference |
| `access.ts` | Access control and pairing |
| `import-cursor.ts` | Import scan cursor management |
| `models.ts` | Shared type definitions |

**`src/bot/` — Telegram interaction layer:**

- `commands/` — one module per command group (`general`, `project`, `thread`, `agent`, `run`, `source`, `messages`)
- `views/` — output formatting (`formatting`, `pagination`, `sections`)
- `middleware/` — request middleware (`auth`, `ack`, `helpers`)
- `callbacks/` — callback query handling
- `i18n/` — localization (`zh`)
- `delivery.ts` — message delivery and streaming

**`src/core/` — Core services:**

| File | Description |
|------|-------------|
| `app-server-client.ts` | Typed JSON-RPC client (with full-auth parameters) |
| `codex-bridge.ts` | App-server process management and WebSocket bridge |
| `execution-engine.ts` | Dual-path execution: app-server or spawn fallback |
| `relay-server.ts` | Relay WebSocket server for CLI clients |
| `project-service.ts` | Project CRUD |
| `thread-service.ts` | Thread CRUD |
| `undo-manager.ts` | Undo logic |
| `query-service.ts` | Search, pagination, and list queries |

**`src/data/` — SQLite data layer:**

- `database.ts` — connection and schema management
- `repositories/` — typed repository classes (source, project, thread, agent, selection, cursor, access)
- `migrate-json.ts` — one-time JSON → SQLite migration
- `migrations/` — schema migrations (currently embedded in `database.ts`)

### Storage

All bot state is stored in a single SQLite database:

| Path | Description |
|------|-------------|
| `~/.codex` | Shared Codex home |
| `~/.codex-telegram/codex-home` | Bot-isolated Codex home |
| `~/.codex-telegram/state/` | Bot state directory |
| `~/.codex-telegram/state/codex-telegram.sqlite` | Main database |

Two built-in data sources:

- **`shared`** — backed by your Codex home, policy: `shared`
- **`bot_local`** — backed by the bot's own Codex home, policy: `isolated`

## Access Control

Configured in `access.ts`, persisted to the SQLite database (`access_config` table in `~/.codex-telegram/state/codex-telegram.sqlite`).

DM policies: `pairing`, `allowlist`, `disabled`

Group chats support per-group whitelists and an `@mention required` option.

Pairing flow:

1. User messages the bot
2. Bot generates a short-lived pairing code (valid for 1 hour)
3. An authorized user confirms with `/pair <code>`

## Source Policies

| Concept | Options | Description |
|---------|---------|-------------|
| `defaultSourceId` | — | Default data source for a project |
| `sourceMode` | `prefer` / `force` / `policy-default` | Source selection mode |
| `agentSourceOverrideMode` | `allow` / `deny` / `policy-default` | Whether agents can use a different source than their parent thread |

## Run States and Retries

Runs follow a clear state machine: `queued` → `running` → `completed` / `failed` / `cancelled`

Key behaviors:

- Cancel aborts the running process, not just queued items
- Non-zero exit codes are treated as failures, not completions
- Retries preserve the retry chain for traceability
- In degraded mode (spawn path), Codex may request approval — the bot marks this as a `waiting_approval` failure

## Undo Semantics

`/undo` follows a conservative strategy:

1. Cancel all queued and running tasks for the thread
2. Find the most recent visible user turn (skipping hidden ones)
3. If the thread is safe (a bot-owned Telegram thread), perform a physical undo via app-server
4. Otherwise, fall back to local history masking (hidden flag in the bot's database)

## Development

```bash
# Type-check
npm run typecheck

# Run tests
npm test
```

Tech stack:

- TypeScript + ESM (`.js` extension imports)
- `tsx` runtime (via `scripts/with-node.sh`)
- `grammy` — Telegram integration
- `better-sqlite3` — SQLite persistence
- `ws` — WebSocket
- `vitest` — testing

No build step required — just the TypeScript toolchain.

## Project Structure

```text
.
├── server.ts                    # Bot entry point
├── session-manager.ts           # Orchestration layer
├── run-scheduler.ts             # Run queue
├── agent-manager.ts             # Agent management
├── history-reader.ts            # History extraction
├── importer.ts                  # Incremental import
├── import-cursor.ts             # Import scan cursor
├── state-store.ts               # SQLite storage
├── access.ts                    # Access control
├── storage-policy.ts            # Source and writeback policies
├── project-normalizer.ts        # Path → project name inference
├── models.ts                    # Type definitions
├── connect.ts                   # Local CLI client
├── scripts/
│   ├── tg-screenshot            # Screenshot script (v8)
│   └── with-node.sh             # Node.js environment wrapper
├── src/
│   ├── bot/
│   │   ├── commands/            # Command handlers
│   │   │   ├── general.ts       #   /start, /help, /ss, /unlock, /lock, /wake, /windows, ...
│   │   │   ├── project.ts       #   /project *
│   │   │   ├── thread.ts        #   /thread *
│   │   │   ├── agent.ts         #   /agent *
│   │   │   ├── run.ts           #   /run *
│   │   │   ├── source.ts        #   /source *
│   │   │   └── messages.ts      #   Plain text message handling
│   │   ├── views/               # Output formatting
│   │   ├── callbacks/           # Callback query handling
│   │   ├── middleware/          # Middleware
│   │   ├── i18n/                # Localization (zh)
│   │   └── delivery.ts          # Message delivery
│   ├── core/                    # Core services
│   │   ├── app-server-client.ts #   JSON-RPC client (full-auth)
│   │   ├── codex-bridge.ts      #   App-server bridge
│   │   ├── execution-engine.ts  #   Dual-path execution engine
│   │   ├── relay-server.ts      #   Relay WebSocket
│   │   └── ...                  #   project/thread/undo/query
│   └── data/                    # SQLite data layer
│       ├── database.ts
│       ├── repositories/        # Typed repositories
│       ├── migrate-json.ts
│       └── migrations/
├── tests/                       # vitest test suite
├── unlock.swift                 # macOS unlock helper
├── tsconfig.json
└── package.json
```

## Verifying the Channel

### Prerequisites

1. Codex CLI installed (`codex --version`)
2. Bot running (`npm run dev`)
3. Telegram session configured

### Basic Verification

```bash
# Start the bot and watch the logs for:
# [server] codex app-server connected via WebSocket
# [server] relay server listening on ws://127.0.0.1:XXXXX

# Create a thread:
npm run connect -- --new

# Or pick an existing one:
npm run connect --
```

### Diagnostic Checklist

| Check | Expected Result | How to Verify |
|-------|----------------|---------------|
| App-server starts | Log shows `connected via WebSocket` | Watch startup logs |
| Relay starts | Log shows `relay server listening` | Watch startup logs |
| connect.ts connects | Output shows `Connected.` | `npm run connect -- --new` |
| Local → Telegram | Telegram shows "🖥️ Local:" messages | Type in connect.ts |
| Telegram → Local | connect.ts shows streaming replies | Send a message in Telegram |
| Cancel / interrupt | Streaming stops | Send `/cancel` mid-reply |
| Degraded mode | Replies still work (no streaming) | Kill app-server, then send a message |

### Troubleshooting

- **Bot not running** — start the bot first; connect.ts reads `~/.codex-telegram/app-server.json`
- **Relay unavailable** — restart the bot
- **No streaming in connect.ts** — verify the thread ID is correct
- **Telegram not forwarding** — check `OWNER_TELEGRAM_ID` in `.env`
- **App-server won't start** — make sure `codex` is on your PATH

## Security

- This bot is a privileged local control panel — anyone with Telegram access can trigger Codex tasks on your machine
- Full-auth mode gives the AI unrestricted file and network access — make sure the host environment is secure
- `scripts/tg-screenshot` reads the screen-unlock password from the `--unlock` CLI argument — never hardcode secrets in scripts
- Use the isolated data source for high-risk or high-frequency automation
- Review writeback policies before enabling auto-writeback
- For group chats, configure whitelists and the `@mention required` option carefully

## Non-Goals

This project is not:

- A hosted SaaS service
- A general-purpose Telegram bot framework
- A replacement for Codex
- An abstract workflow engine decoupled from a local Codex home

It's a practical operations layer for local Codex users.

## License

MIT (or your license of choice). Add a `LICENSE` file before publishing.
