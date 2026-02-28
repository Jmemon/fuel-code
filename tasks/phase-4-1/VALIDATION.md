# fuel-code Phase 4 Validation Playbook

Manual validation workflows for confirming the system works end-to-end before moving to Phase 5. Every workflow describes exact commands, expected output, and what to look for. If all workflows pass, we have high confidence the system is solid.

**Environment**: macOS, Docker Compose (Postgres:5433, Redis:6380, LocalStack:4566), Server on port 3020

---

## Table of Contents

- [Prerequisites & Setup](#prerequisites--setup)
  - [W0.1: Infrastructure Boot](#w01-infrastructure-boot)
  - [W0.2: Server Startup](#w02-server-startup)
  - [W0.3: CLI Init (Fresh)](#w03-cli-init-fresh)
  - [W0.4: CLI Init (Re-init)](#w04-cli-init-re-init)
- [Hook Lifecycle](#hook-lifecycle)
  - [W1.1: Hook Installation](#w11-hook-installation)
  - [W1.2: Hook Status Verification](#w12-hook-status-verification)
  - [W1.3: Hook Uninstall/Reinstall Cycle](#w13-hook-uninstallreinstall-cycle)
  - [W1.4: Hook Test (Synthetic Pipeline Test)](#w14-hook-test-synthetic-pipeline-test)
- [Live Session Pipeline](#live-session-pipeline)
  - [W2.1: Session Start Detection](#w21-session-start-detection)
  - [W2.2: Session End & Transcript Upload](#w22-session-end--transcript-upload)
  - [W2.3: Transcript Parsing](#w23-transcript-parsing)
  - [W2.4: Summary Generation](#w24-summary-generation)
  - [W2.5: Full Lifecycle Walk-Through](#w25-full-lifecycle-walk-through)
- [Git Tracking](#git-tracking)
  - [W3.1: Git Commit Tracking](#w31-git-commit-tracking)
  - [W3.2: Git Checkout Tracking](#w32-git-checkout-tracking)
  - [W3.3: Git Push Tracking](#w33-git-push-tracking)
  - [W3.4: Git-Session Correlation](#w34-git-session-correlation)
  - [W3.5: Orphan Git Activity (No Active Session)](#w35-orphan-git-activity-no-active-session)
- [CLI Query Commands](#cli-query-commands)
  - [W4.1: Status Command](#w41-status-command)
  - [W4.2: Sessions — Default List](#w42-sessions--default-list)
  - [W4.3: Sessions — Workspace Filter](#w43-sessions--workspace-filter)
  - [W4.4: Sessions — Today Filter](#w44-sessions--today-filter)
  - [W4.5: Sessions — Lifecycle Filter](#w45-sessions--lifecycle-filter)
  - [W4.6: Sessions — Live Filter](#w46-sessions--live-filter)
  - [W4.7: Sessions — Tag Filter](#w47-sessions--tag-filter)
  - [W4.8: Sessions — Pagination](#w48-sessions--pagination)
  - [W4.9: Sessions — JSON Output](#w49-sessions--json-output)
  - [W4.10: Session Detail — Summary Card](#w410-session-detail--summary-card)
  - [W4.11: Session Detail — Transcript](#w411-session-detail--transcript)
  - [W4.12: Session Detail — Events](#w412-session-detail--events)
  - [W4.13: Session Detail — Git Activity](#w413-session-detail--git-activity)
  - [W4.14: Session Tag](#w414-session-tag)
  - [W4.15: Session Reparse](#w415-session-reparse)
  - [W4.16: Session Export JSON](#w416-session-export-json)
  - [W4.17: Session Export Markdown](#w417-session-export-markdown)
  - [W4.18: Timeline — Default](#w418-timeline--default)
  - [W4.19: Timeline — Workspace Filter](#w419-timeline--workspace-filter)
  - [W4.20: Timeline — Date Filters](#w420-timeline--date-filters)
  - [W4.21: Timeline — JSON Output](#w421-timeline--json-output)
  - [W4.22: Workspaces — List](#w422-workspaces--list)
  - [W4.23: Workspaces — Detail](#w423-workspaces--detail)
  - [W4.24: Workspaces — JSON Output](#w424-workspaces--json-output)
- [TUI Dashboard](#tui-dashboard)
  - [W5.1: TUI Launch](#w51-tui-launch)
  - [W5.2: TUI Navigation](#w52-tui-navigation)
  - [W5.3: TUI Session Detail](#w53-tui-session-detail)
  - [W5.4: TUI Live Updates](#w54-tui-live-updates)
- [Queue & Offline Resilience](#queue--offline-resilience)
  - [W6.1: Queue Status (Empty)](#w61-queue-status-empty)
  - [W6.2: Offline Queuing](#w62-offline-queuing)
  - [W6.3: Queue Drain](#w63-queue-drain)
  - [W6.4: Dead-Letter Inspection](#w64-dead-letter-inspection)
- [Backfill](#backfill)
  - [W7.1: Backfill Dry-Run](#w71-backfill-dry-run)
  - [W7.2: Backfill Full Run](#w72-backfill-full-run)
  - [W7.3: Backfill Idempotency](#w73-backfill-idempotency)
  - [W7.4: Backfill Status](#w74-backfill-status)
- [WebSocket](#websocket)
  - [W8.1: WebSocket Connection](#w81-websocket-connection)
  - [W8.2: WebSocket Subscribe & Events](#w82-websocket-subscribe--events)
- [Edge Cases & Error Handling](#edge-cases--error-handling)
  - [W9.1: Nonexistent Workspace Filter](#w91-nonexistent-workspace-filter)
  - [W9.2: Invalid Lifecycle Filter](#w92-invalid-lifecycle-filter)
  - [W9.3: Nonexistent Session ID](#w93-nonexistent-session-id)
  - [W9.4: Malformed JSON in Emit](#w94-malformed-json-in-emit)
  - [W9.5: Bad Auth Token](#w95-bad-auth-token)
  - [W9.6: Session in Non-Git Directory](#w96-session-in-non-git-directory)
  - [W9.7: Empty Transcript Upload](#w97-empty-transcript-upload)
  - [W9.8: Duplicate Transcript Upload](#w98-duplicate-transcript-upload)
  - [W9.9: No Config File](#w99-no-config-file)
  - [W9.10: Server Down During CLI Command](#w910-server-down-during-cli-command)
- [Known Bug Regression Checks](#known-bug-regression-checks)
  - [W10.1: Session Duration Not Zero](#w101-session-duration-not-zero)
  - [W10.2: Live Filter Shows Active Sessions](#w102-live-filter-shows-active-sessions)
  - [W10.3: Device Name Not "unknown-device"](#w103-device-name-not-unknown-device)
  - [W10.4: Event Data Clean (No _device_name Leakage)](#w104-event-data-clean-no-_device_name-leakage)
  - [W10.5: Tokens Column (Not Cost)](#w105-tokens-column-not-cost)
  - [W10.6: Stale Stop Hook Cleanup](#w106-stale-stop-hook-cleanup)
- [API Direct Verification](#api-direct-verification)
  - [W11.1: Health Endpoint](#w111-health-endpoint)
  - [W11.2: Sessions API](#w112-sessions-api)
  - [W11.3: Workspaces API](#w113-workspaces-api)
  - [W11.4: Devices API](#w114-devices-api)
  - [W11.5: Timeline API](#w115-timeline-api)
  - [W11.6: Transcript Raw Download](#w116-transcript-raw-download)

---

## Prerequisites & Setup

### W0.1: Infrastructure Boot

**Goal**: Docker services start clean and are reachable.

```bash
docker compose -f docker-compose.test.yml up -d
```

**Verify all 3 services are running:**
```bash
docker compose -f docker-compose.test.yml ps
```

**Expected**: Three services with status "running":
| Service    | Port |
|------------|------|
| postgres   | 5433 |
| redis      | 6380 |
| localstack | 4566 |

**Verify connectivity:**
```bash
# Postgres
psql postgresql://test:test@localhost:5433/fuel_code_test -c "SELECT 1;"

# Redis
redis-cli -p 6380 PING

# LocalStack S3
curl -s http://localhost:4566/_localstack/health | jq .services.s3
```

**Expected**: Postgres returns `1`, Redis returns `PONG`, LocalStack S3 shows `"available"` or `"running"`.

**FAIL condition**: Any service not running. Fix: `docker compose -f docker-compose.test.yml down -v && docker compose -f docker-compose.test.yml up -d`

---

### W0.2: Server Startup

**Goal**: Server boots, runs migrations, initializes S3 bucket, starts Redis consumer.

```bash
cd packages/server && bun run src/index.ts
```

**Expected log output (look for all of these):**
```
Migrations complete { applied: N, skipped: M, errors: 0 }
S3 bucket ensured: fuel-code-blobs
Pipeline dependencies initialized
Server started in XXms. DB: ok. Redis: ok. WS: ok. Port: 3020.
Event consumer started { registeredHandlers: [...] }
```

**CHECK**: `errors: 0` in migrations. If errors > 0, migrations failed — check DATABASE_URL.

**CHECK**: S3 bucket message. If missing, check S3_ENDPOINT and LocalStack.

**CHECK**: Port 3020. If different, check PORT in .env.

**Verify the health endpoint responds:**
```bash
curl -s http://localhost:3020/api/health | jq .
```

**Expected:**
```json
{
  "status": "ok",
  "checks": {
    "db": { "ok": true },
    "redis": { "ok": true }
  }
}
```

**FAIL condition**: `"status": "unhealthy"` means DB is down. `"status": "degraded"` means Redis is down (events won't process but API still works).

---

### W0.3: CLI Init (Fresh)

**Goal**: First-time device registration works, config file is created, backend connectivity is confirmed.

**If you already have a config, back it up first:**
```bash
mv ~/.fuel-code/config.yaml ~/.fuel-code/config.yaml.bak
```

```bash
fuel-code init \
  --url http://localhost:3020 \
  --api-key fc_local_dev_key_123
```

**Expected output includes:**
- `Device ID:` followed by a 26-character ULID
- `Device name:` followed by your hostname (e.g., `Johns-MacBook-Pro.local`)
- `Backend URL: http://localhost:3020`
- `Backend connectivity: OK`

**Verify config was created:**
```bash
cat ~/.fuel-code/config.yaml
```

**CHECK**: `backend.url` is `http://localhost:3020`
**CHECK**: `backend.api_key` is `fc_local_dev_key_123`
**CHECK**: `device.id` is a 26-char ULID
**CHECK**: `device.name` is your hostname
**CHECK**: `device.type` is `local`
**CHECK**: `pipeline.post_timeout_ms` is `5000` (default)

**Verify directories were created:**
```bash
ls -la ~/.fuel-code/
```

**CHECK**: `queue/` and `dead-letter/` directories exist.

---

### W0.4: CLI Init (Re-init)

**Goal**: `--force` re-initialization preserves device ID but updates backend connection.

```bash
fuel-code init \
  --url http://localhost:3020 \
  --api-key fc_local_dev_key_123 \
  --force
```

**CHECK**: The Device ID in the output matches the one from W0.3. (--force preserves existing valid device IDs.)

**Without --force, init should refuse:**
```bash
fuel-code init --url http://localhost:3020 --api-key fc_local_dev_key_123
```

**Expected**: Message like "Already initialized" or similar refusal.

---

## Hook Lifecycle

### W1.1: Hook Installation

**Goal**: CC hooks registered in settings.json, git hooks installed at ~/.fuel-code/git-hooks/.

```bash
fuel-code hooks install
```

**Expected output includes:**
```
Claude Code hooks installed successfully.
  SessionStart → bash -c 'data=$(cat); ...
  SessionEnd   → bash -c 'data=$(cat); ...
  Settings     → ~/.claude/settings.json

Git hooks installed successfully.
  Hooks dir:  ~/.fuel-code/git-hooks
  Installed:  post-commit, post-checkout, post-merge, pre-push
```

**Verify CC hooks in settings.json:**
```bash
cat ~/.claude/settings.json | python3 -m json.tool | grep -A5 "SessionStart\|SessionEnd"
```

**CHECK**: Both SessionStart and SessionEnd have entries with commands containing `fuel-code cc-hook`.
**CHECK**: Commands use the `data=$(cat)` stdin capture pattern.
**CHECK**: Commands are backgrounded with `&`.

**Verify git hooks exist and are executable:**
```bash
ls -la ~/.fuel-code/git-hooks/
```

**CHECK**: `post-commit`, `post-checkout`, `post-merge`, `pre-push` all present
**CHECK**: All have execute permission (`-rwxr-xr-x`)

**Verify global git config:**
```bash
git config --global core.hooksPath
```

**CHECK**: Points to `~/.fuel-code/git-hooks` (or the expanded absolute path).

---

### W1.2: Hook Status Verification

**Goal**: Hook status command accurately reports installation state.

```bash
fuel-code hooks status
```

**Expected:**
```
Claude Code hooks:
  SessionStart: installed
  SessionEnd:   installed

Git hooks:
  core.hooksPath: ~/.fuel-code/git-hooks
  post-commit:    installed
  post-checkout:  installed
  post-merge:     installed
  pre-push:       installed
```

**CHECK**: All 6 entries show "installed". If any show "not installed", hooks install had a partial failure.

---

### W1.3: Hook Uninstall/Reinstall Cycle

**Goal**: Full uninstall removes hooks cleanly, reinstall restores them.

```bash
# Uninstall
fuel-code hooks uninstall

# Verify uninstalled
fuel-code hooks status
```

**CHECK**: All hooks show "not installed".

```bash
# Verify CC hooks removed from settings.json
cat ~/.claude/settings.json | python3 -m json.tool | grep -c "fuel-code"
```

**CHECK**: Count should be 0 (no fuel-code references remain).

```bash
# Verify git config reset
git config --global core.hooksPath
```

**CHECK**: Either empty/unset or restored to previous value (not ~/.fuel-code/git-hooks).

```bash
# Reinstall
fuel-code hooks install
fuel-code hooks status
```

**CHECK**: All hooks show "installed" again.

---

### W1.4: Hook Test (Synthetic Pipeline Test)

**Goal**: Synthetic event flows through the full pipeline (emit → ingest → Redis → Postgres).

```bash
fuel-code hooks test
```

**Expected:**
```
Emitting synthetic session.start event...
Test event emitted successfully (exit code 0).
The event was either sent to the backend or queued locally.
```

**CHECK**: Exit code is 0.

**Verify the event arrived in the server (check server terminal logs):**
```
Event received: session.start ...
```

**Verify a session was created:**
```bash
fuel-code sessions --limit 5
```

**CHECK**: A session appears. Note: it may be associated with `_unassociated` workspace since the test event doesn't come from a real git repo.

---

## Live Session Pipeline

### W2.1: Session Start Detection

**Goal**: Starting a Claude Code session triggers the SessionStart hook, creating a session record in the database.

**In terminal 1 (watch server logs):** Server should already be running.

**In terminal 2:**
```bash
cd /path/to/fuel-code  # or any git repo with a remote
claude
```

**In terminal 3 (immediately after starting claude):**
```bash
fuel-code sessions --limit 1
```

**CHECK**: A new session appears with:
- **STATUS**: Should be `DETECTED` (or `CAPTURING` if the bug has been fixed)
- **WORKSPACE**: Should match the repo name (e.g., `fuel-code`), NOT `_unassociated`
- **DEVICE**: Your device name
- **STARTED**: `just now` or similar recent timestamp

**Server log CHECK**: Look for:
```
Event received: session.start { session_id: "...", workspace_id: "..." }
Session created: ...
```

**CRITICAL CHECK**: If the workspace shows as `_unassociated` despite being in a git repo, the workspace resolution in cc-hook is failing. Check:
```bash
# Does git remote exist?
git remote get-url origin
```

---

### W2.2: Session End & Transcript Upload

**Goal**: Exiting Claude Code triggers SessionEnd hook, emits session.end event, and uploads transcript.

**In the Claude session from W2.1, do a small amount of work (ask a question, have it read a file), then exit:**
```
/exit
```

**In terminal 3:**
```bash
# Wait 5-10 seconds for pipeline processing
sleep 10
fuel-code sessions --limit 1
```

**CHECK**: The session now shows:
- **STATUS**: Should be `ENDED`, `PARSED`, or `SUMMARIZED` (depending on how fast the pipeline processes)
- **DURATION**: Should be a non-zero value (e.g., `2m 15s`). **This is a known bug — if it shows `-` or `0s`, the duration_ms fix hasn't been applied.**

**Server log CHECK**: Look for (in order):
```
Event received: session.end ...
Session transition: ... → ended
Transcript uploaded for session ...
Pipeline: parsing transcript ...
Session transition: ended → parsed
```

If ANTHROPIC_API_KEY is set:
```
Pipeline: generating summary ...
Session transition: parsed → summarized
```

---

### W2.3: Transcript Parsing

**Goal**: After a session ends and transcript is uploaded, the parser extracts messages and content blocks.

**Using the session ID from W2.2:**
```bash
fuel-code session <id-prefix> --transcript
```

**CHECK**: Output shows a conversation with:
- At least one `user` message (your prompt)
- At least one `assistant` message (Claude's response)
- Tool use blocks if Claude used tools (Read, Edit, Bash, etc.)
- Proper formatting with role labels and content

**If `--transcript` shows nothing or errors:**
1. Check parse_status:
```bash
fuel-code session <id-prefix> --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('parse_status','?'))"
```
2. If `parse_status` is `failed`, check `parse_error` in the JSON output.
3. If `parse_status` is `pending`, the pipeline hasn't run yet — check S3 transcript upload.

---

### W2.4: Summary Generation

**Goal**: If ANTHROPIC_API_KEY is configured, sessions get LLM-generated summaries.

**Prerequisites**: `ANTHROPIC_API_KEY` set in `packages/server/.env`.

```bash
fuel-code session <id-prefix>
```

**CHECK**: The `Summary` field shows a 1-3 sentence past-tense description of what happened in the session.

**If summary is "(no summary)":**
1. Check lifecycle — must be `summarized`
2. If lifecycle is `parsed`, summary generation may have failed. Check server logs for Anthropic API errors.
3. If `ANTHROPIC_API_KEY` is not set, sessions will stop at `parsed` — this is expected.

---

### W2.5: Full Lifecycle Walk-Through

**Goal**: Verify every lifecycle transition happens in order for a single session.

This is the most critical workflow. Do it slowly and check at each step.

**Step 1: Start session**
```bash
claude
```

**Step 2: Check — session should be DETECTED**
```bash
fuel-code sessions --limit 1
```
**CHECK**: STATUS is `DETECTED`. Note the session ID prefix.

**Step 3: Do work in the session (at least one tool use)**
Ask Claude to read a file or run a command.

**Step 4: Check — session should transition**
```bash
fuel-code sessions --limit 1
```
**CHECK**: STATUS is still `DETECTED` (or `CAPTURING` if the lifecycle bug is fixed).
> **KNOWN ISSUE**: Nothing currently transitions sessions from `detected` to `capturing`. If this hasn't been fixed, `DETECTED` is the "active" state.

**Step 5: End session**
Type `/exit` or Ctrl+C.

**Step 6: Wait and check — session should be ENDED then PARSED**
```bash
sleep 5
fuel-code sessions --limit 1
```
**CHECK**: STATUS is `ENDED` or `PARSED`.

**Step 7: Wait more and check — session should be SUMMARIZED**
```bash
sleep 15
fuel-code sessions --limit 1
```
**CHECK**: STATUS is `SUMMARIZED` (if ANTHROPIC_API_KEY is set) or `PARSED` (if not).

**Step 8: Verify all details are populated**
```bash
fuel-code session <id-prefix>
```

**CHECK ALL of these fields:**
- [ ] Workspace name is correct (not `_unassociated`)
- [ ] Device name is your hostname (not `unknown-device`)
- [ ] Duration is non-zero
- [ ] Started/Ended timestamps are present and reasonable
- [ ] Model shows the Claude model used
- [ ] Branch shows the git branch
- [ ] Tokens in/out are non-zero
- [ ] Stats: messages > 0, tool uses >= 0
- [ ] Summary is present (if ANTHROPIC_API_KEY set)
- [ ] Tags is empty array (no spurious tags)

---

## Git Tracking

### W3.1: Git Commit Tracking

**Goal**: Post-commit hook fires and creates git.commit event.

**In a git repo where hooks are installed:**
```bash
echo "test-validation" > /tmp/validation-test.txt
cp /tmp/validation-test.txt .
git add validation-test.txt
git commit -m "test: validation commit for fuel-code tracking"
```

**CHECK**: Git commit succeeds immediately (hook is fire-and-forget, should not delay).

**Wait a moment, then check:**
```bash
fuel-code timeline --today
```

**CHECK**: The commit appears in the timeline:
```
↑ abc1234 test: validation commit for fuel-code tracking (1 file)
```

**Clean up:**
```bash
git reset --hard HEAD~1
rm -f validation-test.txt
```

---

### W3.2: Git Checkout Tracking

**Goal**: Post-checkout hook fires on branch switches.

```bash
git checkout -b test-validation-branch
```

**Wait, then check:**
```bash
fuel-code timeline --today
```

**CHECK**: A checkout event appears (e.g., "checkout: main → test-validation-branch").

```bash
git checkout main
git branch -d test-validation-branch
```

---

### W3.3: Git Push Tracking

**Goal**: Pre-push hook fires and records push events.

> **NOTE**: This requires actually pushing to a remote. If you don't want to push, you can skip this and verify via the hooks test mechanism instead. If you DO push, make sure you're on a safe branch.

```bash
# Only if you have an expendable branch:
git push origin main
```

**CHECK**: Push completes successfully (hook must not block the push).

**Check timeline for push event.**

---

### W3.4: Git-Session Correlation

**Goal**: Git commits made during an active CC session are linked to that session.

**Step 1: Start a Claude session:**
```bash
cd /path/to/fuel-code
claude
```

**Step 2: In another terminal, make a commit while the session is active:**
```bash
echo "test-correlation" > /tmp/correlation-test.txt
cp /tmp/correlation-test.txt .
git add correlation-test.txt
git commit -m "test: commit during active CC session"
```

**Step 3: Get the active session ID:**
```bash
fuel-code sessions --limit 1
```

**Step 4: Check git activity is linked to the session:**
```bash
fuel-code session <id-prefix> --git
```

**CHECK**: The test commit appears in the session's git activity table with the correct commit hash and message.

**Step 5: End the CC session, clean up:**
```bash
git reset --hard HEAD~1
rm -f correlation-test.txt
```

---

### W3.5: Orphan Git Activity (No Active Session)

**Goal**: Git commits made WITHOUT an active CC session still appear in the timeline, but not linked to any session.

**Ensure NO Claude Code session is running, then:**
```bash
echo "orphan-test" > /tmp/orphan-test.txt
cp /tmp/orphan-test.txt .
git add orphan-test.txt
git commit -m "test: orphan commit (no CC session)"
```

```bash
fuel-code timeline --today
```

**CHECK**: The commit appears in the timeline but NOT grouped under any session. It should appear as standalone git activity.

**Clean up:**
```bash
git reset --hard HEAD~1
rm -f orphan-test.txt
```

---

## CLI Query Commands

### W4.1: Status Command

**Goal**: Status shows device info, connectivity, queue, hooks, and today's summary.

```bash
fuel-code status
```

**CHECK all sections present:**
- [ ] `Device:` line with name and ID prefix
- [ ] `Type: local`
- [ ] `Backend: ✓ Connected` with URL and latency
- [ ] `Queue:` line with pending and dead-letter counts
- [ ] `Active Sessions:` section (may say "No active sessions")
- [ ] `Hooks:` section showing CC and Git hook status
- [ ] `Today:` summary line with session count and duration

```bash
fuel-code status --json | python3 -m json.tool | head -20
```

**CHECK**: Valid JSON output with `device`, `backend`, `queue`, `hooks`, `today` fields.

---

### W4.2: Sessions — Default List

**Goal**: Sessions command shows a formatted table of recent sessions.

```bash
fuel-code sessions
```

**CHECK**: Table has columns: STATUS, ID, WORKSPACE, DEVICE, DURATION, TOKENS, STARTED, SUMMARY
**CHECK**: Sessions are sorted by most recent first
**CHECK**: At most 20 sessions shown (default limit)

---

### W4.3: Sessions — Workspace Filter

**Goal**: Workspace filter narrows results correctly.

```bash
fuel-code sessions --workspace fuel-code
```

**CHECK**: Every session in the output has WORKSPACE = `fuel-code`.

```bash
# Partial match should also work (prefix matching)
fuel-code sessions --workspace fuel
```

**CHECK**: Same results as above (case-insensitive prefix match).

---

### W4.4: Sessions — Today Filter

**Goal**: `--today` shows only sessions from today.

```bash
fuel-code sessions --today
```

**CHECK**: All sessions have STARTED showing today's relative times ("just now", "5m ago", "2h ago" etc.), NOT "yesterday" or dates.

---

### W4.5: Sessions — Lifecycle Filter

**Goal**: Lifecycle filter narrows by state.

```bash
fuel-code sessions --lifecycle summarized
fuel-code sessions --lifecycle parsed
fuel-code sessions --lifecycle ended
fuel-code sessions --lifecycle detected
```

**CHECK**: Each command shows only sessions in that specific lifecycle state.

---

### W4.6: Sessions — Live Filter

**Goal**: `--live` shows currently active sessions.

> **KNOWN ISSUE**: `--live` filters on `lifecycle = capturing`. If sessions never transition from `detected` to `capturing`, this will always be empty. After the fix, it should filter on `detected` OR `capturing`.

```bash
# Start a Claude session in another terminal first, then:
fuel-code sessions --live
```

**CHECK**: Active sessions appear. If the list is empty despite having an active CC session, the `capturing` lifecycle bug hasn't been fixed.

---

### W4.7: Sessions — Tag Filter

**Goal**: Tag filter shows only tagged sessions.

**First, tag a session (see W4.14), then:**
```bash
fuel-code sessions --tag review-needed
```

**CHECK**: Only sessions with the `review-needed` tag appear.

---

### W4.8: Sessions — Pagination

**Goal**: Pagination works with --limit and --cursor.

```bash
fuel-code sessions --limit 2
```

**CHECK**: At most 2 sessions shown.
**CHECK**: If more exist, footer shows: `Showing 2 sessions (more available). Next page: --cursor <cursor>`

```bash
# Use the cursor from the previous output:
fuel-code sessions --limit 2 --cursor <cursor_value>
```

**CHECK**: Next page of results shown. No overlap with first page.

---

### W4.9: Sessions — JSON Output

**Goal**: `--json` returns valid, parseable JSON.

```bash
fuel-code sessions --json | python3 -m json.tool | head -30
```

**CHECK**: Valid JSON. Contains `sessions` array with objects having `id`, `lifecycle`, `workspace_id`, `device_id`, etc.

```bash
# Verify field presence
fuel-code sessions --json | python3 -c "
import sys, json
data = json.load(sys.stdin)
s = data['sessions'][0] if data.get('sessions') else {}
required = ['id', 'lifecycle', 'workspace_id', 'device_id', 'started_at']
for f in required:
    print(f'{f}: {\"present\" if f in s else \"MISSING\"}')"
```

---

### W4.10: Session Detail — Summary Card

**Goal**: Session detail shows all metadata.

```bash
fuel-code sessions
# Pick an ID prefix from the list
fuel-code session <id-prefix>
```

**CHECK all fields present:**
- [ ] Session ID (full)
- [ ] Workspace name and canonical ID
- [ ] Device name and type
- [ ] Lifecycle/status
- [ ] Started time
- [ ] Duration (non-zero for ended sessions)
- [ ] Model name
- [ ] Git branch
- [ ] Token counts (in/out)
- [ ] Summary (or "(no summary)")
- [ ] Tags
- [ ] Stats: messages, tool uses
- [ ] Hint line: `use --transcript, --events, or --git for more detail`

---

### W4.11: Session Detail — Transcript

**Goal**: Parsed transcript renders correctly with message roles and tool trees.

```bash
fuel-code session <id-prefix> --transcript
```

**CHECK**:
- [ ] User messages shown with `user` role label
- [ ] Assistant messages shown with `assistant` role label
- [ ] Tool use blocks shown with tool name (Read, Edit, Bash, etc.)
- [ ] Tool results shown with content preview
- [ ] Thinking blocks shown (if any)
- [ ] Messages are in chronological order
- [ ] No raw JSON visible — properly formatted

**If empty or error:**
- Session must have `parse_status = completed`. Check with `fuel-code session <id> --json`.

---

### W4.12: Session Detail — Events

**Goal**: Raw events for a session are listed chronologically.

```bash
fuel-code session <id-prefix> --events
```

**CHECK**:
- [ ] At minimum: `session.start` event present
- [ ] If session is ended: `session.end` event present
- [ ] Events show TIME (HH:MM:SS), TYPE, and DATA columns
- [ ] Data column shows relevant info (branch, model, duration, reason)

---

### W4.13: Session Detail — Git Activity

**Goal**: Git activity during a session is shown.

```bash
fuel-code session <id-prefix> --git
```

**CHECK**: If git commits were made during the session, they appear with HASH, MESSAGE, BRANCH, +/-, FILES columns. If no git activity, shows "No git activity for this session."

---

### W4.14: Session Tag

**Goal**: Tags can be added to sessions.

```bash
fuel-code session <id-prefix> --tag "review-needed"
```

**Expected**: `Tag "review-needed" added to session 01HZ...`

**Verify:**
```bash
fuel-code session <id-prefix>
```

**CHECK**: Tags section shows `review-needed`.

**Add another tag:**
```bash
fuel-code session <id-prefix> --tag "phase-4"
```

**CHECK**: Tags section now shows `review-needed, phase-4` (both tags).

---

### W4.15: Session Reparse

**Goal**: Reparse re-triggers transcript processing from S3.

```bash
fuel-code session <id-prefix> --reparse
```

**Expected**: `Reparse triggered for session 01HZ...`

**Verify** (after a few seconds):
```bash
fuel-code session <id-prefix> --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('parse_status'))"
```

**CHECK**: `parse_status` is `completed` (after pipeline finishes) or `parsing` (if still in progress).

---

### W4.16: Session Export JSON

**Goal**: Session data exports to a JSON file.

```bash
fuel-code session <id-prefix> --export json
```

**Expected**: File created: `session-<8-char-id>.json`

**Verify:**
```bash
python3 -m json.tool session-*.json | head -20
```

**CHECK**: Contains `session`, `transcript`, `events`, `git_activity`, `exported_at` fields.

**Clean up:**
```bash
rm -f session-*.json
```

---

### W4.17: Session Export Markdown

**Goal**: Session data exports to a readable Markdown file.

```bash
fuel-code session <id-prefix> --export md
```

**Expected**: File created: `session-<8-char-id>.md`

**Verify:**
```bash
head -30 session-*.md
```

**CHECK**: Contains header with session metadata, transcript content, and git activity sections.

**Clean up:**
```bash
rm -f session-*.md
```

---

### W4.18: Timeline — Default

**Goal**: Timeline shows session-grouped activity with date headers.

```bash
fuel-code timeline
```

**CHECK**:
- [ ] Sessions grouped by date (Today, Yesterday, etc.)
- [ ] Each session shows: time, lifecycle icon, workspace, device, duration, tokens
- [ ] Summary line under each session
- [ ] Git commits shown under their associated session (↑ icon + short SHA + message)
- [ ] Footer with total stats: sessions, duration, tokens, commits

---

### W4.19: Timeline — Workspace Filter

```bash
fuel-code timeline --workspace fuel-code
```

**CHECK**: Only sessions from the fuel-code workspace appear.

---

### W4.20: Timeline — Date Filters

```bash
# Relative: last 3 days
fuel-code timeline --after -3d

# Relative: last 12 hours
fuel-code timeline --after -12h

# Relative: this week
fuel-code timeline --week

# Absolute date
fuel-code timeline --after 2026-02-20

# Combined
fuel-code timeline --workspace fuel-code --after -1w
```

**CHECK** each command: Results respect the date range. No sessions outside the range.

---

### W4.21: Timeline — JSON Output

```bash
fuel-code timeline --json | python3 -m json.tool | head -20
```

**CHECK**: Valid JSON with `items` array. Each item has `type` ("session" or "git_activity").

---

### W4.22: Workspaces — List

```bash
fuel-code workspaces
```

**CHECK**: Table with columns: WORKSPACE, SESSIONS, ACTIVE, DEVICES, LAST ACTIVITY, TOTAL TOKENS, TOTAL TIME

**CHECK**:
- [ ] SESSIONS count matches what you see in `fuel-code sessions`
- [ ] TOTAL TIME is non-zero (if the duration bug is fixed)
- [ ] TOTAL TOKENS shows compact format (e.g., `123K/50K`)
- [ ] Sorted by most recent activity first

---

### W4.23: Workspaces — Detail

```bash
fuel-code workspace fuel-code
```

**CHECK**:
- [ ] Canonical ID shown (e.g., `github.com/user/fuel-code`)
- [ ] Devices section lists your device with CC/Git hook status
- [ ] Recent sessions shown
- [ ] Git activity summary (commits, pushes, branches)

---

### W4.24: Workspaces — JSON Output

```bash
fuel-code workspaces --json | python3 -m json.tool | head -20
```

**CHECK**: Valid JSON. Array of workspace objects with stats.

---

## TUI Dashboard

### W5.1: TUI Launch

**Goal**: TUI renders correctly and shows data.

```bash
fuel-code
```

**CHECK**:
- [ ] Two-column layout: workspaces on left, sessions on right
- [ ] Workspaces show session counts
- [ ] Sessions show lifecycle status, workspace, device, duration
- [ ] Footer shows keybindings and connection status
- [ ] No crash, no blank screen

**Exit**: Press `q`.

---

### W5.2: TUI Navigation

```bash
fuel-code
```

**Test keybindings:**
- [ ] `j` / `k` — moves selection highlight up/down in session list
- [ ] `Tab` — switches focus between workspace and session panes
- [ ] `r` — refreshes data (session list updates)
- [ ] `q` — exits cleanly

---

### W5.3: TUI Session Detail

```bash
fuel-code
# Navigate to a session with j/k, press Enter
```

**CHECK**:
- [ ] Session detail view opens
- [ ] `t` — shows transcript tab with conversation
- [ ] `e` — shows events tab
- [ ] `g` — shows git activity tab
- [ ] `Space` / `PageDown` / `PageUp` — scrolls content
- [ ] `b` — returns to dashboard
- [ ] `q` — exits TUI entirely

---

### W5.4: TUI Live Updates

**Goal**: TUI updates in real-time when new sessions appear.

**Step 1**: Open TUI in terminal 1:
```bash
fuel-code
```

**Step 2**: Start a Claude session in terminal 2:
```bash
claude
```

**CHECK**: Within a few seconds, a new session appears in the TUI session list with `DETECTED` (or `CAPTURING`) status.

**Step 3**: End the Claude session in terminal 2.

**CHECK**: The session's status updates in the TUI (to `ENDED`, then `PARSED`, then `SUMMARIZED`).

---

## Queue & Offline Resilience

### W6.1: Queue Status (Empty)

**Goal**: Queue reports correctly when empty.

```bash
fuel-code queue status
```

**Expected**: `0 events pending` and `0 events` dead-letter.

---

### W6.2: Offline Queuing

**Goal**: Events queue locally when the server is down.

**Step 1: Stop the server** (Ctrl+C in the server terminal).

**Step 2: Emit an event:**
```bash
fuel-code hooks test
```

**CHECK**: Command exits 0 (success). The event was queued locally.

**Step 3: Verify queue:**
```bash
fuel-code queue status
```

**CHECK**: Shows `1 events pending` (or more if you ran the test multiple times).

**Step 4: Check the queue directory:**
```bash
ls ~/.fuel-code/queue/
```

**CHECK**: At least one `.json` file exists.

---

### W6.3: Queue Drain

**Goal**: Queued events are delivered when connectivity returns.

**Step 1: Restart the server:**
```bash
cd packages/server && bun run src/index.ts
```

**Step 2: Drain the queue:**
```bash
fuel-code queue drain
```

**Expected output includes:**
- `Drained: N events`
- `Remaining: 0`

**Step 3: Verify queue is empty:**
```bash
fuel-code queue status
```

**CHECK**: `0 events pending`.

---

### W6.4: Dead-Letter Inspection

```bash
fuel-code queue dead-letter
```

**CHECK**: Should be empty in normal operation. If events are here, they permanently failed delivery.

---

## Backfill

### W7.1: Backfill Dry-Run

**Goal**: Dry-run scans for historical sessions without ingesting.

```bash
fuel-code backfill --dry-run
```

**CHECK**:
- [ ] Shows number of sessions discovered
- [ ] Groups by workspace/project
- [ ] Shows file sizes
- [ ] Does NOT ingest anything (verify with `fuel-code sessions` — count shouldn't change)

---

### W7.2: Backfill Full Run

**Goal**: Full backfill ingests historical sessions.

```bash
fuel-code backfill
```

**CHECK**:
- [ ] Progress indicator shows sessions being processed
- [ ] Final summary shows ingested/skipped/failed counts
- [ ] `fuel-code sessions` now shows more sessions than before
- [ ] Historical sessions have correct workspace associations

---

### W7.3: Backfill Idempotency

**Goal**: Running backfill again doesn't duplicate sessions.

```bash
fuel-code backfill
```

**CHECK**: All sessions should be "skipped" (already ingested). Zero new ingestions.

---

### W7.4: Backfill Status

**Goal**: Backfill status reports last run info.

```bash
fuel-code backfill --status
```

**CHECK**: Shows last backfill timestamp and ingested/skipped/failed counts.

> **KNOWN ISSUE**: This may always say "No backfill has been run yet" if the status persistence hasn't been fixed.

---

## WebSocket

### W8.1: WebSocket Connection

**Goal**: WebSocket connects with proper auth.

```bash
# Install wscat if needed: bun install -g wscat
wscat -c "ws://localhost:3020/api/ws?token=fc_local_dev_key_123"
```

**CHECK**: Connection established (no "Unauthorized" disconnect). You should see the wscat `>` prompt.

**Test bad auth:**
```bash
wscat -c "ws://localhost:3020/api/ws?token=wrong_key"
```

**CHECK**: Connection is immediately closed with "Unauthorized" or similar error.

---

### W8.2: WebSocket Subscribe & Events

**Step 1: Connect and subscribe:**
```bash
wscat -c "ws://localhost:3020/api/ws?token=fc_local_dev_key_123"
```

Type:
```json
{"type":"subscribe","scope":"all"}
```

**CHECK**: Receive a `subscribed` confirmation.

**Step 2: Trigger activity** (in another terminal, run `fuel-code hooks test` or start a Claude session).

**CHECK**: WebSocket receives event messages in real-time.

**Disconnect**: Ctrl+C.

---

## Edge Cases & Error Handling

### W9.1: Nonexistent Workspace Filter

```bash
fuel-code sessions --workspace nonexistent-workspace-xyz
```

**CHECK**: Returns an error (not a crash). Should show a message like "Workspace 'nonexistent-workspace-xyz' not found" or similar, possibly with a list of available workspaces.

---

### W9.2: Invalid Lifecycle Filter

```bash
fuel-code sessions --lifecycle invalidstate
```

**CHECK**: Returns an error (not a crash). Should reject the invalid lifecycle value.

---

### W9.3: Nonexistent Session ID

```bash
fuel-code session 01NONEXISTENT
```

**CHECK**: Returns "Session not found" error (not a crash or stack trace).

---

### W9.4: Malformed JSON in Emit

```bash
fuel-code emit test.event --data "not valid json"
```

**CHECK**: Does NOT crash. Exit code is 0 (hooks must never fail). The malformed data is wrapped as `{ _raw: "not valid json" }`.

---

### W9.5: Bad Auth Token

```bash
curl -s -H "Authorization: Bearer wrong_key" http://localhost:3020/api/sessions | python3 -m json.tool
```

**CHECK**: HTTP 401 response with clear error message.

---

### W9.6: Session in Non-Git Directory

**Goal**: Sessions from non-git directories are tracked under `_unassociated`.

```bash
# Navigate to a directory with no git repo
cd /tmp
claude
# Do something brief, then /exit
```

```bash
fuel-code sessions --limit 1
```

**CHECK**: The session's WORKSPACE should be `_unassociated`.

---

### W9.7: Empty Transcript Upload

```bash
curl -s -X POST \
  -H "Authorization: Bearer fc_local_dev_key_123" \
  http://localhost:3020/api/sessions/nonexistent/transcript/upload
```

**CHECK**: Returns HTTP 400 with `Content-Length header required` or similar error (not a crash).

---

### W9.8: Duplicate Transcript Upload

**Goal**: Re-uploading a transcript for a session that already has one is idempotent.

**Find a session that has a transcript:**
```bash
fuel-code sessions --json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('sessions', []):
    if s.get('transcript_s3_key'):
        print(s['id']); break"
```

**Upload again (dummy content):**
```bash
curl -s -X POST \
  -H "Authorization: Bearer fc_local_dev_key_123" \
  -H "Content-Type: application/x-ndjson" \
  -H "Content-Length: 5" \
  -d "hello" \
  http://localhost:3020/api/sessions/<session-id>/transcript/upload | python3 -m json.tool
```

**CHECK**: Returns HTTP 200 with `{ "status": "already_uploaded" }` (idempotent, not an error).

---

### W9.9: No Config File

**Goal**: CLI commands fail gracefully without a config file.

```bash
# Temporarily move config
mv ~/.fuel-code/config.yaml ~/.fuel-code/config.yaml.bak

fuel-code sessions

# Restore
mv ~/.fuel-code/config.yaml.bak ~/.fuel-code/config.yaml
```

**CHECK**: Error message about missing config (not a stack trace). Should suggest running `fuel-code init`.

---

### W9.10: Server Down During CLI Command

**Goal**: CLI commands fail gracefully when server is unreachable.

**Stop the server, then:**
```bash
fuel-code sessions
```

**CHECK**: Error message about backend being unreachable (not a stack trace). Should include the URL that failed.

**Restart the server after testing.**

---

## Known Bug Regression Checks

These verify whether the known issues from the Phase 4.1 audit have been fixed.

### W10.1: Session Duration Not Zero

**AUDIT ITEM #1 (CRITICAL)**: `duration_ms` is always 0 for live sessions.

```bash
# Find any ended session
fuel-code session <id-prefix>
```

**CHECK**: Duration field shows a non-zero value (e.g., `3m 42s`).

**Direct API check:**
```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  http://localhost:3020/api/sessions | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('sessions', [])[:5]:
    print(f\"  {s['id'][:8]}  lifecycle={s['lifecycle']}  duration_ms={s.get('duration_ms')}\")"
```

**CHECK**: `duration_ms` should be > 0 for all ended/parsed/summarized sessions.

**If duration_ms is 0**: The server-side fix (computing `ended_at - started_at` when `duration_ms` is 0) has not been applied. See audit report item #1.

---

### W10.2: Live Filter Shows Active Sessions

**AUDIT ITEM #2 (CRITICAL)**: `capturing` lifecycle state is never reached.

**Start a Claude session, then:**
```bash
fuel-code sessions --live
```

**CHECK**: The active session appears in the list.

**If the list is empty**: The `--live` filter still uses `lifecycle = capturing`, and nothing transitions to `capturing`. See audit report item #2. Fix: either add the transition or change `--live` to filter on `detected`.

---

### W10.3: Device Name Not "unknown-device"

**AUDIT ITEM from git review**: Devices should use actual hostname.

```bash
fuel-code status
```

**CHECK**: `Device:` line shows your actual hostname (e.g., `Johns-MacBook-Pro.local`), NOT `unknown-device`.

**Direct DB check:**
```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  http://localhost:3020/api/devices | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data.get('devices', []):
    name = d.get('name', '?')
    print(f\"  {d['id'][:8]}  name={name}\")
    if name == 'unknown-device':
        print('    *** FAIL: device still named unknown-device ***')"
```

---

### W10.4: Event Data Clean (No _device_name Leakage)

**AUDIT ITEM #4**: `_device_name` and `_device_type` leak into persisted event data.

```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions?limit=1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('sessions'):
    sid = data['sessions'][0]['id']
    print(f'Checking events for session {sid[:8]}...')
" 2>/dev/null

# Get events for the most recent session
SESS_ID=$(curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions?limit=1" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'][0]['id'])")

curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions/${SESS_ID}/events" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for e in data.get('events', []):
    d = e.get('data', {})
    if '_device_name' in d or '_device_type' in d:
        print(f\"  *** FAIL: event {e['id'][:8]} has _device_name={d.get('_device_name')} _device_type={d.get('_device_type')} ***)
    else:
        print(f\"  OK: event {e['id'][:8]} type={e['type']} — no leakage\")"
```

**CHECK**: No events have `_device_name` or `_device_type` in their data field.

**If they appear**: The event processor isn't stripping transport metadata before persistence. See audit report item #4.

---

### W10.5: Tokens Column (Not Cost)

**AUDIT ITEM from git review**: CLI displays tokens, not cost.

```bash
fuel-code sessions --limit 3
```

**CHECK**: The column header is `TOKENS` (not `COST`). Values show format like `123K/50K` (not `$0.42`).

```bash
fuel-code workspaces
```

**CHECK**: Column is `TOTAL TOKENS` (not `TOTAL COST`). Values show token format.

---

### W10.6: Stale Stop Hook Cleanup

**AUDIT ITEM #5**: Old `Stop` hooks may still be registered.

```bash
cat ~/.claude/settings.json | python3 -c "
import sys, json
settings = json.load(sys.stdin)
hooks = settings.get('hooks', {})
if 'Stop' in hooks:
    print('*** FAIL: Stale Stop hook still present ***')
    print('Run: fuel-code hooks install (to clean up)')
else:
    print('OK: No stale Stop hook')"
```

**CHECK**: No `Stop` hook in settings.json. `fuel-code hooks install` should remove it.

---

## API Direct Verification

These bypass the CLI and hit the API directly, useful for isolating whether bugs are in the CLI or server.

### W11.1: Health Endpoint

```bash
curl -s http://localhost:3020/api/health | python3 -m json.tool
```

**CHECK**: `status` is `ok`, both `db` and `redis` checks have `ok: true`.

---

### W11.2: Sessions API

```bash
# List sessions
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions?limit=3" | python3 -m json.tool

# Session detail
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions/<id>" | python3 -m json.tool

# Session transcript
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions/<id>/transcript" | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
print(f'{len(msgs)} messages')
for m in msgs[:3]:
    print(f'  [{m[\"ordinal\"]}] {m[\"message_type\"]}: {len(m.get(\"content_blocks\", []))} blocks')"
```

---

### W11.3: Workspaces API

```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/workspaces" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for w in data.get('workspaces', []):
    print(f\"  {w['display_name']}  sessions={w.get('session_count',0)}  tokens_in={w.get('total_tokens_in',0)}\")"
```

---

### W11.4: Devices API

```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/devices" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data.get('devices', []):
    print(f\"  {d['name']}  type={d['type']}  sessions={d.get('session_count',0)}\")"
```

---

### W11.5: Timeline API

```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/timeline?limit=5" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('items', []):
    t = item.get('type', '?')
    if t == 'session':
        s = item.get('session', {})
        git = item.get('git_activity', [])
        print(f\"  session: {s.get('id','?')[:8]}  git_events={len(git)}\")
    else:
        print(f\"  {t}: {len(item.get('git_activity', []))} events\")"
```

---

### W11.6: Transcript Raw Download

**Goal**: Verify the raw JSONL transcript can be downloaded from S3 via presigned URL.

```bash
# Get a session with a transcript
SESS_ID=$(curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions?limit=1" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'][0]['id'])")

# Get presigned URL (without redirect)
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions/${SESS_ID}/transcript/raw?redirect=false" | python3 -m json.tool
```

**CHECK**: Returns `{ "url": "http://localhost:4566/fuel-code-blobs/..." }` — a presigned S3 URL.

**Download the raw transcript:**
```bash
URL=$(curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions/${SESS_ID}/transcript/raw?redirect=false" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
curl -s "$URL" | head -5
```

**CHECK**: Returns JSONL content (one JSON object per line). First line should contain session metadata or the first user message.

---

## Validation Summary Checklist

Use this as a quick pass/fail summary after running all workflows.

### Infrastructure
- [ ] W0.1: Docker services running (Postgres, Redis, LocalStack)
- [ ] W0.2: Server starts with 0 migration errors
- [ ] W0.3: CLI init creates config and verifies connectivity
- [ ] W0.4: Re-init with --force preserves device ID

### Hooks
- [ ] W1.1: Hooks install (CC + Git)
- [ ] W1.2: Hook status reports correctly
- [ ] W1.3: Uninstall/reinstall cycle works
- [ ] W1.4: Synthetic pipeline test delivers event

### Live Pipeline
- [ ] W2.1: Session start creates session record
- [ ] W2.2: Session end sets lifecycle and uploads transcript
- [ ] W2.3: Transcript parses into messages/blocks
- [ ] W2.4: Summary generated (if API key set)
- [ ] W2.5: Full lifecycle: detected → ended → parsed → summarized

### Git
- [ ] W3.1: Commits tracked via post-commit hook
- [ ] W3.2: Checkouts tracked via post-checkout hook
- [ ] W3.3: Pushes tracked via pre-push hook
- [ ] W3.4: Commits correlated to active CC sessions
- [ ] W3.5: Orphan commits tracked without session

### CLI Queries
- [ ] W4.1: Status command shows all sections
- [ ] W4.2: Sessions default list works
- [ ] W4.3: Workspace filter narrows results
- [ ] W4.4: Today filter works
- [ ] W4.5: Lifecycle filter works
- [ ] W4.6: Live filter shows active sessions
- [ ] W4.7: Tag filter works
- [ ] W4.8: Pagination with --limit and --cursor
- [ ] W4.9: JSON output is valid
- [ ] W4.10: Session detail summary card
- [ ] W4.11: Session transcript rendering
- [ ] W4.12: Session events listing
- [ ] W4.13: Session git activity
- [ ] W4.14: Session tagging
- [ ] W4.15: Session reparse
- [ ] W4.16: Export JSON
- [ ] W4.17: Export Markdown
- [ ] W4.18: Timeline default view
- [ ] W4.19: Timeline workspace filter
- [ ] W4.20: Timeline date filters
- [ ] W4.21: Timeline JSON output
- [ ] W4.22: Workspaces list with stats
- [ ] W4.23: Workspace detail
- [ ] W4.24: Workspaces JSON output

### TUI
- [ ] W5.1: TUI launches and renders
- [ ] W5.2: Keyboard navigation works
- [ ] W5.3: Session detail view works
- [ ] W5.4: Live updates via WebSocket

### Resilience
- [ ] W6.1: Queue reports empty when empty
- [ ] W6.2: Events queue locally when server is down
- [ ] W6.3: Queue drain delivers events
- [ ] W6.4: Dead-letter queue is accessible

### Backfill
- [ ] W7.1: Dry-run scans without ingesting
- [ ] W7.2: Full backfill ingests sessions
- [ ] W7.3: Second backfill is idempotent (all skipped)
- [ ] W7.4: Backfill status reports correctly

### WebSocket
- [ ] W8.1: WebSocket connects with valid auth
- [ ] W8.2: Subscribe receives real-time events

### Edge Cases
- [ ] W9.1: Nonexistent workspace → clean error
- [ ] W9.2: Invalid lifecycle → clean error
- [ ] W9.3: Nonexistent session → clean error
- [ ] W9.4: Malformed JSON → exit 0, no crash
- [ ] W9.5: Bad auth → 401
- [ ] W9.6: Non-git directory → _unassociated
- [ ] W9.7: Empty transcript upload → 400
- [ ] W9.8: Duplicate transcript → idempotent 200
- [ ] W9.9: No config → helpful error
- [ ] W9.10: Server down → helpful error

### Known Bug Regressions
- [ ] W10.1: Duration is non-zero for ended sessions
- [ ] W10.2: --live shows active sessions
- [ ] W10.3: Device name is not "unknown-device"
- [ ] W10.4: No _device_name/_device_type in event data
- [ ] W10.5: TOKENS column (not COST)
- [ ] W10.6: No stale Stop hook in settings.json

### API Direct
- [ ] W11.1: Health endpoint returns ok
- [ ] W11.2: Sessions API returns data
- [ ] W11.3: Workspaces API returns stats
- [ ] W11.4: Devices API returns device list
- [ ] W11.5: Timeline API returns items
- [ ] W11.6: Raw transcript downloadable from S3
