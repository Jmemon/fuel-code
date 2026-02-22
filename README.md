# fuel-code

CLI-first developer activity tracking. Captures Claude Code sessions, git activity, and events into a centralized backend — making your coding work queryable, browsable, and analyzable.

**Current status: Phase 4 complete** (Foundation + Session Lifecycle + Git Tracking + CLI/TUI)

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [1. Install Dependencies](#1-install-dependencies)
  - [2. Start Infrastructure](#2-start-infrastructure)
  - [3. Configure and Start the Server](#3-configure-and-start-the-server)
  - [4. Initialize the CLI](#4-initialize-the-cli)
  - [5. Install Hooks](#5-install-hooks)
- [Verification Workflows](#verification-workflows)
  - [Workflow 1: Health Check and Status](#workflow-1-health-check-and-status)
  - [Workflow 2: Hook Installation and Verification](#workflow-2-hook-installation-and-verification)
  - [Workflow 3: Live Session Capture (End-to-End)](#workflow-3-live-session-capture-end-to-end)
  - [Workflow 4: Session List and Filtering](#workflow-4-session-list-and-filtering)
  - [Workflow 5: Session Detail Deep-Dive](#workflow-5-session-detail-deep-dive)
  - [Workflow 6: Git Activity Tracking](#workflow-6-git-activity-tracking)
  - [Workflow 7: Timeline View](#workflow-7-timeline-view)
  - [Workflow 8: Workspace Management](#workflow-8-workspace-management)
  - [Workflow 9: TUI Dashboard (Interactive)](#workflow-9-tui-dashboard-interactive)
  - [Workflow 10: Historical Backfill](#workflow-10-historical-backfill)
  - [Workflow 11: Local Queue and Offline Resilience](#workflow-11-local-queue-and-offline-resilience)
  - [Workflow 12: Session Export](#workflow-12-session-export)
  - [Workflow 13: Session Tagging and Reparse](#workflow-13-session-tagging-and-reparse)
  - [Workflow 14: WebSocket Live Updates](#workflow-14-websocket-live-updates)
  - [Workflow 15: Pipeline Test (Hooks Test Command)](#workflow-15-pipeline-test-hooks-test-command)
- [CLI Command Reference](#cli-command-reference)
- [TUI Keybindings](#tui-keybindings)
- [Project Structure](#project-structure)
- [Environment Variable Reference](#environment-variable-reference)
- [Running Tests](#running-tests)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Bun** v1.1+ (`curl -fsSL https://bun.sh/install | bash`)
- **Docker** and **Docker Compose** (for Postgres and Redis)
- **Git** (for git hook functionality)
- **An Anthropic API key** (optional — needed for LLM-generated session summaries)

---

## Setup

### 1. Install Dependencies

```bash
cd /path/to/fuel-code
bun install
```

### 2. Start Infrastructure

The project uses Docker Compose for Postgres 16 and Redis 7. The compose file uses non-standard ports to avoid conflicts with any local instances:

```bash
docker compose -f docker-compose.test.yml up -d
```

This starts:

| Service    | Internal Port | Exposed Port | Purpose                     |
|------------|---------------|--------------|-----------------------------|
| Postgres   | 5432          | **5433**     | Primary database            |
| Redis      | 6379          | **6380**     | Event stream (Redis Streams)|
| LocalStack | 4566          | **4566**     | Local S3 for transcripts    |

Verify they're running:
```bash
docker compose -f docker-compose.test.yml ps
```

All three should show as "running".

### 3. Configure and Start the Server

Create the server `.env` file:

```bash
cp packages/server/.env.example packages/server/.env
```

Edit `packages/server/.env` with these values for local development:

```env
DATABASE_URL=postgresql://test:test@localhost:5433/fuel_code_test
REDIS_URL=redis://localhost:6380
API_KEY=fc_local_dev_key_123
PORT=3020
LOG_LEVEL=info
NODE_ENV=development

# S3 transcript storage via LocalStack (optional but recommended)
S3_BUCKET=fuel-code-blobs
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:4566
S3_FORCE_PATH_STYLE=true

# LLM-powered session summaries (optional)
# Uncomment and set your key to enable automatic session summaries:
# ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Start the server (migrations run automatically on first startup):

```bash
bun run packages/server/src/index.ts
```

You should see log output including:
```
Migrations complete { applied: 4, skipped: 0, errors: 0 }
Pipeline dependencies initialized { s3Bucket: "fuel-code-blobs", summaryEnabled: true }
Server started in XXms. DB: ok. Redis: ok. WS: ok. Port: 3020.
Event consumer started { registeredHandlers: [...] }
```

**Leave this terminal running.** Open a new terminal for the next steps.

### 4. Initialize the CLI

```bash
bun run packages/cli/src/index.ts init \
  --url http://localhost:3020 \
  --api-key fc_local_dev_key_123
```

Expected output:
```
fuel-code initialized successfully!

  Device ID:    01JXXXXXXXXXXXXXXXXX
  Device name:  your-hostname
  Backend URL:  http://localhost:3020
  Queue path:   /Users/you/.fuel-code/queue

  Backend connectivity: OK
```

This creates `~/.fuel-code/config.yaml` with your device identity and backend connection info.

### 5. Install Hooks

Install both Claude Code hooks and git hooks:

```bash
bun run packages/cli/src/index.ts hooks install
```

Expected output:
```
Claude Code hooks installed successfully.
  SessionStart → /path/to/packages/hooks/claude/SessionStart.sh
  Stop         → /path/to/packages/hooks/claude/SessionEnd.sh
  Settings     → ~/.claude/settings.json

Git hooks installed successfully.
  Hooks dir:  ~/.fuel-code/git-hooks
  Installed:  post-commit, post-checkout, post-merge, pre-push
```

You are now fully set up. Every Claude Code session and git operation in any repo will be tracked automatically.

---

## Verification Workflows

Each workflow describes what to do, what commands to run, and what output to expect. They are ordered from simple infrastructure checks to full end-to-end flows.

> **Shorthand**: Throughout these workflows, `fuel-code` means:
> ```bash
> bun run /path/to/fuel-code/packages/cli/src/index.ts
> ```
> You can create an alias for convenience:
> ```bash
> alias fuel-code="bun run /path/to/fuel-code/packages/cli/src/index.ts"
> ```

---

### Workflow 1: Health Check and Status

**What it tests**: Backend connectivity, database health, Redis health, device registration, queue state, hook detection.

**Steps**:

1. Check the health endpoint directly:
```bash
curl http://localhost:3020/api/health | jq .
```

**Expected**: JSON response:
```json
{
  "status": "ok",
  "checks": {
    "db": { "ok": true, "latency_ms": 2 },
    "redis": { "ok": true, "latency_ms": 1 }
  },
  "ws_clients": 0,
  "uptime_seconds": 42,
  "version": "0.1.0"
}
```

2. Run the CLI status command:
```bash
fuel-code status
```

**Expected**:
```
fuel-code status

  Device:     your-hostname (01JXXXXX...)
  Type:       local
  Backend:    ✓ Connected (http://localhost:3020) · XXms
  Queue:      0 pending · 0 dead-letter

  Active Sessions:
    No active sessions

  Recent Sessions:
    (none)

  Hooks:
    CC hooks:   ✓ Installed
    Git hooks:  ✓ Installed

  Today: 0 sessions · 0s · $0.00
```

3. JSON output:
```bash
fuel-code status --json | jq .device
```

**Verify**: Device ID, name, and type are present. Backend status is `"connected"`.

---

### Workflow 2: Hook Installation and Verification

**What it tests**: CC hook registration in `~/.claude/settings.json`, git hook script creation, hook status reporting, uninstall/reinstall cycle.

**Steps**:

1. Check hook status:
```bash
fuel-code hooks status
```

**Expected**:
```
Claude Code hooks:
  SessionStart: installed
  Stop:         installed

Git hooks:
  core.hooksPath: ~/.fuel-code/git-hooks
  post-commit:    installed
  post-checkout:  installed
  post-merge:     installed
  pre-push:       installed
```

2. Verify CC hooks are in Claude's settings:
```bash
cat ~/.claude/settings.json | jq '.hooks.SessionStart, .hooks.Stop'
```

**Verify**: Both have entries with commands pointing to `fuel-code` hook scripts.

3. Verify git hook scripts exist and are executable:
```bash
ls -la ~/.fuel-code/git-hooks/
```

**Verify**: `post-commit`, `post-checkout`, `post-merge`, `pre-push` — all executable (`-rwxr-xr-x`).

4. Verify global git config:
```bash
git config --global core.hooksPath
```

**Expected**: `~/.fuel-code/git-hooks` (or the full expanded path).

5. Test the full uninstall/reinstall cycle:
```bash
# Uninstall everything
fuel-code hooks uninstall
fuel-code hooks status
# CC hooks and git hooks should all show "not installed"

# Reinstall
fuel-code hooks install
fuel-code hooks status
# Everything should show "installed" again
```

---

### Workflow 3: Live Session Capture (End-to-End)

**What it tests**: The full event pipeline — hook fires on Claude Code session start/end, events flow through Redis Stream to Postgres, session lifecycle transitions from `detected` through `capturing` to `ended`/`parsed`/`summarized`.

**Prerequisites**: Hooks installed (Workflow 2). Server running.

**Steps**:

1. Start a Claude Code session in a git repository:
```bash
cd /path/to/fuel-code   # or any git repo with a remote
claude
```

2. In a separate terminal, immediately check for the active session:
```bash
fuel-code sessions --live
```

**Expected**: A table row showing:
```
STATUS      ID        WORKSPACE    DEVICE          DURATION  COST   STARTED      SUMMARY
● capturing 01JXXXXX  fuel-code    your-hostname   5s        $0.00  just now     (no summary)
```

3. Do some work in the Claude Code session (ask it a question, have it read files, etc.), then exit the session (type `/exit` or Ctrl+C).

4. Wait a few seconds for the pipeline to process, then check:
```bash
fuel-code sessions --today
```

**Expected**: The session should appear with lifecycle `ended`, `parsed`, or `summarized`:
- `ended` — session end event received, transcript not yet parsed
- `parsed` — transcript has been parsed into structured messages
- `summarized` — LLM summary has been generated (requires `ANTHROPIC_API_KEY`)

5. Watch the server terminal logs for the processing pipeline:
```
Event received: session.start ...
Session created: 01J... lifecycle=detected
Session transition: detected → capturing
Event received: session.end ...
Session transition: capturing → ended
Pipeline: parsing transcript for 01J...
Session transition: ended → parsed
Pipeline: generating summary for 01J...
Session transition: parsed → summarized
```

---

### Workflow 4: Session List and Filtering

**What it tests**: Session listing with various filters, pagination, and JSON output.

**Prerequisites**: At least one session exists (from Workflow 3 or Workflow 10).

**Steps**:

1. List all sessions (default: 20 most recent):
```bash
fuel-code sessions
```

**Expected**: A formatted table:
```
STATUS        ID        WORKSPACE    DEVICE          DURATION   COST    STARTED       SUMMARY
✓ summarized  01JXXXXX  fuel-code    your-hostname   3m 42s     $0.12   2 hours ago   Refactored the...
✓ parsed      01JYYYYY  other-repo   your-hostname   1m 15s     $0.04   yesterday     (no summary)
```

2. Filter by workspace name:
```bash
fuel-code sessions --workspace fuel-code
```

**Verify**: Only sessions from the `fuel-code` workspace appear.

3. Filter by today only:
```bash
fuel-code sessions --today
```

**Verify**: Only sessions started after midnight local time.

4. Filter by lifecycle state:
```bash
fuel-code sessions --lifecycle summarized
fuel-code sessions --lifecycle parsed
fuel-code sessions --lifecycle ended
```

**Verify**: Each shows only sessions in that specific state.

5. Show only live sessions:
```bash
fuel-code sessions --live
```

**Verify**: Equivalent to `--lifecycle capturing`. Shows sessions currently being captured.

6. Limit and paginate:
```bash
fuel-code sessions --limit 2
```

**Verify**: Shows at most 2 sessions. If more exist, a footer shows:
```
Showing 2 sessions (more available). Next page: --cursor <cursor>
```

Use the cursor:
```bash
fuel-code sessions --limit 2 --cursor <cursor_value>
```

7. JSON output:
```bash
fuel-code sessions --json | jq '.sessions[0] | {id, lifecycle, workspace_id}'
```

---

### Workflow 5: Session Detail Deep-Dive

**What it tests**: Session summary card, transcript rendering, event listing, git activity for a session.

**Prerequisites**: At least one session with a parsed transcript.

**Steps**:

1. Get a session ID:
```bash
fuel-code sessions
# Note an ID prefix from the ID column (e.g., "01JXXXXX")
```

2. View the session summary card (default view):
```bash
fuel-code session 01JXXXXX
```

**Expected**: A detailed card:
```
Session 01JXXXXX...

  Workspace:  fuel-code
  Device:     your-hostname
  Lifecycle:  summarized
  Duration:   3m 42s
  Started:    2025-02-22T10:30:00Z
  Ended:      2025-02-22T10:33:42Z

  Tokens:     in: 12,450 · out: 3,200 · cache: 8,100
  Cost:       $0.12
  Summary:    Refactored the authentication middleware to use JWT tokens...
  Tags:       (none)
  Branch:     main

  Stats:
    Messages:   24
    Tool uses:  8
    Commits:    2
```

3. View the parsed transcript:
```bash
fuel-code session 01JXXXXX --transcript
```

**Expected**: A rendered conversation showing:
```
┃ user
│ Can you read the config file?
│
┃ assistant
│ I'll read that file for you.
│   ┃ tool_use: Read
│   │ file_path: /path/to/config.ts
│   ┃ tool_result: (1,250 chars)
│ Here's what I found in the config...
```

4. View raw events for the session:
```bash
fuel-code session 01JXXXXX --events
```

**Expected**: Table of events (session.start, session.end, possibly git.commit etc.) with timestamps.

5. View git activity during the session:
```bash
fuel-code session 01JXXXXX --git
```

**Expected**: Table of git commits, checkouts, or pushes that occurred while the session was active. If no git activity happened during this session, it shows an empty message.

---

### Workflow 6: Git Activity Tracking

**What it tests**: Git hooks fire events on commit/checkout/push, events are stored, commits are correlated to active sessions.

**Prerequisites**: Hooks installed, server running.

**Steps**:

1. Start a Claude Code session (so there's an active session for correlation):
```bash
cd /path/to/fuel-code
claude
```

2. In a separate terminal, make a test commit in the same repo:
```bash
cd /path/to/fuel-code
echo "test-file" > /tmp/git-test-file.txt
cp /tmp/git-test-file.txt .
git add git-test-file.txt
git commit -m "test: verify git hook tracking"
```

The post-commit hook fires silently in the background (hooks exit 0, never block git).

3. Check the timeline for the commit:
```bash
fuel-code timeline
```

**Expected**: The timeline shows the commit grouped under the active session:
```
Today
────────────────────────────────────────
  ● fuel-code · your-hostname · capturing · 2m 15s
    Summary: (still capturing)
    ├── git commit abc1234 — test: verify git hook tracking (1 file)
```

4. Check git activity for the specific session:
```bash
fuel-code session <active-session-id> --git
```

**Expected**: The test commit appears, linked to the session.

5. End the Claude Code session, then clean up:
```bash
git reset --hard HEAD~1
rm -f git-test-file.txt
```

6. Test checkout tracking:
```bash
git checkout -b test-tracking-branch
# post-checkout hook fires
git checkout main
# post-checkout hook fires again
git branch -d test-tracking-branch
```

Check the timeline — checkout events should appear.

---

### Workflow 7: Timeline View

**What it tests**: Unified activity feed with sessions and git activity grouped by date, relative date filtering, footer stats.

**Prerequisites**: Some sessions and/or git activity in the database.

**Steps**:

1. View the full timeline:
```bash
fuel-code timeline
```

**Expected**: A date-grouped activity feed:
```
Today
────────────────────────────────────────
  ✓ fuel-code · your-hostname · summarized · 3m 42s · $0.12
    Refactored the authentication middleware...
    ├── git commit abc1234 — test: verify git hook tracking (1 file)
    └── Tools: Read (5), Edit (3), Bash (2)

Yesterday
────────────────────────────────────────
  ✓ other-repo · your-hostname · parsed · 1m 15s · $0.04
    (no summary)

────────────────────────────────────────
Total: 2 sessions · 4m 57s · $0.16
```

2. Filter by workspace:
```bash
fuel-code timeline --workspace fuel-code
```

**Verify**: Only sessions from the fuel-code workspace.

3. Filter by relative date (last 3 days):
```bash
fuel-code timeline --after -3d
```

4. Filter by relative hours:
```bash
fuel-code timeline --after -12h
```

5. Filter by absolute date:
```bash
fuel-code timeline --after 2025-02-20
```

6. Combine filters:
```bash
fuel-code timeline --workspace fuel-code --after -1w
```

7. JSON output:
```bash
fuel-code timeline --json | jq '.items | length'
```

---

### Workflow 8: Workspace Management

**What it tests**: Workspace listing with aggregated stats, workspace detail with devices and sessions.

**Prerequisites**: At least one session in a workspace.

**Steps**:

1. List all workspaces:
```bash
fuel-code workspaces
```

**Expected**: A table:
```
WORKSPACE    SESSIONS  ACTIVE  DEVICES  LAST ACTIVITY  TOTAL COST  TOTAL TIME
fuel-code    5         0       1        2 hours ago    $0.45       15m 30s
other-repo   2         0       1        yesterday      $0.08       3m 12s
```

2. View workspace detail (use the workspace name):
```bash
fuel-code workspace fuel-code
```

**Expected**: Detailed info:
```
Workspace: fuel-code

  Canonical ID:  github.com/you/fuel-code
  Display name:  fuel-code
  Devices:       1 (your-hostname)

  Recent Sessions:
    ✓ 01JXXXXX · 3m 42s · $0.12 · 2 hours ago
    ✓ 01JYYYYY · 5m 10s · $0.18 · yesterday
    ...
```

3. JSON output:
```bash
fuel-code workspaces --json | jq '.[0].display_name'
```

---

### Workflow 9: TUI Dashboard (Interactive)

**What it tests**: Ink-based terminal UI, two-column layout, WebSocket live updates, session detail navigation.

**Prerequisites**: Server running, at least one session in the database.

**Steps**:

1. Launch the TUI (fuel-code with no subcommand):
```bash
fuel-code
```

**Expected**: A two-column dashboard:
```
┌─ Workspaces ──────┬─ Sessions ─────────────────────────────────────┐
│                    │                                                │
│ ► fuel-code (5)    │  ✓ 01JXXXXX · 3m 42s · Refactored the...     │
│   other-repo (2)   │  ✓ 01JYYYYY · 5m 10s · Added new API...      │
│                    │  ● 01JZZZZZ · capturing · (live)              │
│                    │                                                │
└────────────────────┴────────────────────────────────────────────────┘
```

2. Keyboard navigation:
   - **`j`/`k`** — Move selection up/down in the session list
   - **`Enter`** — Open session detail view
   - **`b`** — Go back to dashboard from detail view
   - **`q`** — Quit the TUI

3. Session detail view (press Enter on a session):
   - **`t`** — Transcript tab (conversation with tool trees)
   - **`e`** — Events tab (raw events table)
   - **`g`** — Git tab (git activity during session)
   - **`Space`/`PageDown`/`PageUp`** — Scroll through long content
   - **`x`** — Export session
   - **`b`** — Back to dashboard

4. Test live updates: While the TUI is open, start a Claude Code session in another terminal. Within ~500ms, the TUI should:
   - Show the new session appearing with `capturing` status
   - Update the workspace session count
   - When the session ends, transition the status indicator

5. Quit with `q`.

---

### Workflow 10: Historical Backfill

**What it tests**: Discovering existing Claude Code sessions from `~/.claude/projects/` and ingesting them into the backend.

**Steps**:

1. Dry-run scan (reports what would be ingested without doing it):
```bash
fuel-code backfill --dry-run
```

**Expected**: Output listing discovered sessions:
```
Scanning ~/.claude/projects/ for historical sessions...
Found 12 historical sessions across 3 workspaces.

  fuel-code:     7 sessions
  other-repo:    3 sessions
  third-project: 2 sessions

Dry run complete. Use 'fuel-code backfill' to ingest.
```

2. Run the actual backfill:
```bash
fuel-code backfill
```

**Expected**: Progress output as sessions are ingested:
```
Ingesting 12 sessions...
  [1/12] fuel-code session from 2025-02-15 ... ok
  [2/12] fuel-code session from 2025-02-16 ... ok
  ...
Backfill complete: 12 ingested, 0 failed.
```

3. Check backfill status:
```bash
fuel-code backfill --status
```

**Expected**: Last run info — timestamp, sessions discovered/ingested/failed.

4. Verify the backfilled sessions appear:
```bash
fuel-code sessions
```

**Verify**: Historical sessions now appear in the list with workspace names, durations, and (if ANTHROPIC_API_KEY is set) summaries.

---

### Workflow 11: Local Queue and Offline Resilience

**What it tests**: Events queue locally when the backend is unreachable, then drain when connectivity returns.

**Steps**:

1. Stop the server (Ctrl+C in the server terminal).

2. Emit a test event while the server is down:
```bash
fuel-code hooks test
```

**Expected**:
```
Emitting synthetic session.start event...
Test event emitted successfully (exit code 0).
The event was either sent to the backend or queued locally.
```

3. Check the local queue:
```bash
fuel-code queue status
```

**Expected**: Shows pending events:
```
Queue: 1 pending · 0 dead-letter
```

4. Inspect the queue directory:
```bash
ls ~/.fuel-code/queue/
```

**Verify**: One `.json` file exists containing the queued event.

5. Restart the server:
```bash
bun run packages/server/src/index.ts
```

6. Drain the queue:
```bash
fuel-code queue drain
```

**Expected**: Queued events are sent to the backend. Output confirms success.

7. Verify the queue is empty:
```bash
fuel-code queue status
```

**Expected**: `0 pending · 0 dead-letter`.

8. Check dead-letter queue (events that permanently failed):
```bash
fuel-code queue dead-letter
```

**Expected**: Should be empty in normal operation.

---

### Workflow 12: Session Export

**What it tests**: Exporting session data (transcript, events, git activity) in JSON or Markdown format.

**Prerequisites**: At least one session with a parsed transcript.

**Steps**:

1. Export as JSON:
```bash
fuel-code session <id-prefix> --export json
```

**Expected**: Writes a `.json` file containing:
- Full session metadata (lifecycle, duration, cost, tokens)
- Parsed transcript messages with content blocks
- All events for the session
- Git activity during the session
- Export timestamp

2. Export as Markdown:
```bash
fuel-code session <id-prefix> --export md
```

**Expected**: Writes a `.md` file with a human-readable report: session summary, rendered transcript, git activity.

---

### Workflow 13: Session Tagging and Reparse

**What it tests**: Mutating session metadata (tags), triggering re-processing of transcripts.

**Prerequisites**: At least one session.

**Steps**:

1. Add a tag:
```bash
fuel-code session <id-prefix> --tag "review-needed"
```

**Expected**: Confirmation that the tag was added.

2. Verify the tag appears on the session:
```bash
fuel-code session <id-prefix>
```

**Verify**: The detail card shows `Tags: review-needed`.

3. Filter sessions by tag:
```bash
fuel-code sessions --tag review-needed
```

**Verify**: Only tagged sessions appear.

4. Trigger a transcript reparse:
```bash
fuel-code session <id-prefix> --reparse
```

**Expected**: The session's transcript is re-fetched from S3 and re-parsed. Useful if the parser logic was updated.

---

### Workflow 14: WebSocket Live Updates

**What it tests**: Real-time event broadcasting to connected clients.

**Steps**:

1. Connect to the WebSocket:
```bash
# Install wscat if needed: npm install -g wscat
wscat -c "ws://localhost:3020/api/ws?token=fc_local_dev_key_123"
```

2. Subscribe to all events:
```json
{"type":"subscribe","channel":"all"}
```

3. In another terminal, trigger activity (start a Claude Code session or run `fuel-code hooks test`).

4. Watch the WebSocket terminal — you should see real-time messages:
```json
{"type":"event","data":{"id":"01J...","type":"session.start",...}}
{"type":"session.update","data":{"id":"01J...","lifecycle":"capturing",...}}
```

5. Subscribe to a specific workspace:
```json
{"type":"subscribe","channel":"workspace","id":"<workspace-id>"}
```

6. Disconnect with Ctrl+C.

---

### Workflow 15: Pipeline Test (Hooks Test Command)

**What it tests**: The emit pipeline end-to-end using a synthetic event.

**Steps**:

1. Run the test:
```bash
fuel-code hooks test
```

**Expected**:
```
Emitting synthetic session.start event...
Test event emitted successfully (exit code 0).
The event was either sent to the backend or queued locally.
```

2. Check server logs — you should see the synthetic event arrive and be processed.

3. The test creates a session with `_unassociated` as the workspace. Verify:
```bash
fuel-code sessions
```

**Verify**: A session with the test session ID appears.

---

## CLI Command Reference

```
fuel-code                         Launch TUI dashboard
fuel-code init                    Initialize ~/.fuel-code/ config
  --name <name>                   Device name (default: hostname)
  --url <url>                     Backend URL
  --api-key <key>                 API key
  --force                         Re-initialize even if already configured
fuel-code status                  Show device info and connectivity
  --json                          Output as JSON
fuel-code sessions                List sessions
  -w, --workspace <name>          Filter by workspace
  -d, --device <name>             Filter by device
  --today                         Today's sessions only
  --live                          Live (capturing) sessions only
  --lifecycle <state>             Filter by lifecycle state
  --tag <tag>                     Filter by tag
  -l, --limit <n>                 Max results (default 20)
  --cursor <cursor>               Pagination cursor
  --json                          Output as JSON
fuel-code session <id>            Session detail view
  --transcript                    Show parsed transcript
  --events                        Show events
  --git                           Show git activity
  --export json|md                Export session data
  --tag <tag>                     Add a tag
  --reparse                       Re-parse transcript from S3
fuel-code timeline                Unified activity feed
  -w, --workspace <name>          Filter by workspace
  --after <date|-Nd|-Nh|-Nw>      Show activity after date
  --before <date>                 Show activity before date
  --json                          Output as JSON
fuel-code workspaces              List all workspaces
  --json                          Output as JSON
fuel-code workspace <name>        Workspace detail
  --json                          Output as JSON
fuel-code hooks install           Install CC + git hooks
  --cc-only                       Install only Claude Code hooks
  --git-only                      Install only git hooks
  --per-repo                      Git hooks in .git/hooks/ only
  --force                         Override competing hook manager warnings
fuel-code hooks uninstall         Remove hooks
  --cc-only / --git-only          Remove specific hook type
  --restore                       Restore previous git hooksPath
fuel-code hooks status            Check installation state
fuel-code hooks test              Emit synthetic event to test pipeline
fuel-code backfill                Ingest historical sessions
  --dry-run                       Scan without ingesting
  --status                        Show last backfill status
  --force                         Run even if backfill in progress
fuel-code emit <type>             Emit an event (internal, used by hooks)
  --data <json>                   Event payload
  --workspace-id <id>             Target workspace
  --session-id <id>               Associated session
fuel-code queue status            Show queue depth
fuel-code queue drain             Send queued events to backend
fuel-code queue dead-letter       Show failed events
fuel-code transcript <path>       Upload transcript for processing
```

## TUI Keybindings

### Dashboard View

| Key       | Action                                    |
|-----------|-------------------------------------------|
| `j` / `k` | Navigate up/down in session list          |
| `Enter`   | Open session detail                       |
| `Tab`     | Switch between workspace and session panes|
| `r`       | Refresh data                              |
| `q`       | Quit                                      |

### Session Detail View

| Key                       | Action                     |
|---------------------------|----------------------------|
| `t`                       | Transcript tab             |
| `e`                       | Events tab                 |
| `g`                       | Git activity tab           |
| `Space` / `PageDown`      | Scroll down                |
| `PageUp`                  | Scroll up                  |
| `x`                       | Export session              |
| `b`                       | Back to dashboard           |
| `q`                       | Quit                        |

---

## Project Structure

```
packages/
  shared/   Schema definitions, types, Zod validators, utilities (contract layer — zero side effects)
  core/     Business logic — event processor, session lifecycle, transcript parser, summary generator
  server/   Express API + Redis Stream consumer + WebSocket server (deployed to Railway)
  cli/      Commander CLI commands + Ink TUI dashboard
  hooks/    Git and Claude Code hook shell scripts
```

---

## Environment Variable Reference

### Server (`packages/server/.env`)

| Variable                    | Required | Default                      | Description                              |
|-----------------------------|----------|------------------------------|------------------------------------------|
| `DATABASE_URL`              | Yes      | —                            | Postgres connection string               |
| `REDIS_URL`                 | Yes      | —                            | Redis connection string                  |
| `API_KEY`                   | Yes      | —                            | Auth key for API and WebSocket           |
| `PORT`                      | No       | `3000`                       | HTTP server port                         |
| `LOG_LEVEL`                 | No       | `info`                       | Pino log level                           |
| `NODE_ENV`                  | No       | —                            | `development` or `production`            |
| `S3_BUCKET`                 | No       | `fuel-code-blobs`            | S3 bucket for transcripts                |
| `S3_REGION`                 | No       | `us-east-1`                  | AWS region                               |
| `S3_ENDPOINT`               | No       | —                            | Custom S3 endpoint (LocalStack)          |
| `S3_FORCE_PATH_STYLE`       | No       | —                            | `true` for LocalStack                    |
| `ANTHROPIC_API_KEY`         | No       | —                            | Enables LLM session summaries            |
| `SUMMARY_ENABLED`           | No       | `true`                       | `false` to disable summaries             |
| `SUMMARY_MODEL`             | No       | `claude-sonnet-4-5-20250929` | Claude model for summaries               |
| `SUMMARY_TEMPERATURE`       | No       | `0.3`                        | Generation temperature (0-1)             |
| `SUMMARY_MAX_OUTPUT_TOKENS` | No       | `150`                        | Max tokens in summary                    |

### CLI

| Variable                | Description                                        |
|-------------------------|----------------------------------------------------|
| `FUEL_CODE_BACKEND_URL` | Backend URL (alternative to `--url` on init)       |
| `FUEL_CODE_API_KEY`     | API key (alternative to `--api-key` on init)       |
| `LOG_LEVEL`             | CLI log verbosity (default: `warn`)                |

---

## Running Tests

```bash
# Ensure test infrastructure is running
docker compose -f docker-compose.test.yml up -d

# Run all tests (~770 tests across unit and E2E suites)
bun test --recursive

# Run specific phase E2E tests
bun test packages/server/src/__tests__/e2e/   # Phase 1-3 pipeline tests
bun test packages/cli/src/__tests__/e2e/      # Phase 4 CLI/TUI tests

# Quick summary of pass/fail
bun test --recursive 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

---

## Troubleshooting

### Server won't start: "Missing required environment variables"
Ensure `packages/server/.env` exists and has `DATABASE_URL`, `REDIS_URL`, and `API_KEY`. Copy from `.env.example` and fill in values per the [setup section](#3-configure-and-start-the-server).

### "Backend connectivity: FAILED" during `fuel-code init`
The server isn't reachable. Verify:
- Server is running (`bun run packages/server/src/index.ts`)
- The `--url` matches the server's port
- No firewall blocking localhost connections

### "Config file not found" on CLI commands
Run `fuel-code init` first. The CLI requires `~/.fuel-code/config.yaml`.

### No sessions appearing after a Claude Code session
1. Check hooks: `fuel-code hooks status` — both CC and git hooks should be installed
2. Check server logs for incoming events (look for "Event received")
3. Check the queue: `fuel-code queue status` — events may be queued if the server was briefly down
4. Drain pending events: `fuel-code queue drain`

### Sessions stuck at "ended" (not parsing)
- S3 must be available for transcript storage. Check LocalStack is running: `docker compose -f docker-compose.test.yml ps`
- Verify S3 env vars are set: `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`
- Check server logs for S3 errors

### Sessions show "(no summary)"
Summaries require `ANTHROPIC_API_KEY` in the server `.env`. Without it, sessions complete at the `parsed` state.

### Git commits not tracked
1. `fuel-code hooks status` — all 4 git hooks should be "installed"
2. `git config --global core.hooksPath` — should point to `~/.fuel-code/git-hooks/`
3. If using husky/lefthook, reinstall with `fuel-code hooks install --per-repo`
4. Hooks are fire-and-forget — check server logs for git events arriving

### Database migration errors
- Verify Postgres is running: `docker compose -f docker-compose.test.yml ps`
- Verify `DATABASE_URL` uses port `5433` (not the default 5432)
- Check credentials match: `postgresql://test:test@localhost:5433/fuel_code_test`

### TUI blank or crashes
- Terminal must be at least 80 columns wide
- Try with debug logging: `LOG_LEVEL=debug fuel-code`
- If WebSocket fails, TUI falls back to 10-second polling — still functional, just slower updates
