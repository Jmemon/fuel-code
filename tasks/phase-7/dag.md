# Phase 7: Slack Integration + Change Orchestration — Task Dependency DAG

## Overview

Phase 7 adds a Slack-driven change request workflow to fuel-code. A user messages a Slack bot with a change description, and fuel-code provisions a remote environment (Phase 5), runs headless Claude Code to implement the change, deploys a preview on the EC2 instance, and sends an interactive Slack message with Approve/Reject buttons. On approval, the branch is merged to main. On rejection, the environment is cleaned up.

**What Phase 7 delivers:**
- A new **Change Request** entity beyond the 5 core abstractions — an orchestration record tracking the lifecycle of a code change from Slack message to merged PR
- `POST /api/changes`, `GET /api/changes/:id`, `POST /api/changes/:id/approve`, `POST /api/changes/:id/reject` server endpoints
- A Slack bot (Bolt framework) that listens for mentions/DMs, posts progress updates as thread replies, and sends interactive Approve/Reject buttons
- A change orchestrator state machine driving: provision → implement → deploy → approve/reject → merge/cleanup
- Headless Claude Code invocation over SSH on remote environments
- Preview URL construction (EC2 public IP + exposed port)
- `fuel-code changes` and `fuel-code change <id>` CLI commands
- New event types: `change.requested`, `change.implementing`, `change.deployed`, `change.approved`, `change.rejected`, `change.merged`, `change.failed`

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Change Request Entity + DB Migration | A | — |
| 2 | Change Orchestrator State Machine | B | 1 |
| 3 | Server API Endpoints for Changes | B | 1 |
| 4 | Headless CC Invocation over SSH | C | 2 |
| 5 | Preview URL Construction + App Runner | C | 3 |
| 6 | Slack Bot (Bolt Framework) | D | 2, 3 |
| 7 | CLI `changes` Commands | D | 3 |
| 8 | Phase 7 E2E Integration Tests | E | 4, 5, 6, 7 |

## Dependency Graph

```
Group A ─── Task 1: Change Request entity + DB migration
               │
        ┌──────┴──────┐
        ▼              ▼
Group B ─── Task 2    Task 3
            Orchestrator  API endpoints
            state machine
               │         │
        ┌──────┤    ┌────┘───────┐
        ▼      │    ▼            ▼
Group C ─── Task 4    Task 5
            Headless CC  Preview URL +
            over SSH     app runner
               │         │
        ┌──────┴────┬────┘
        │           │
        ▼           ▼
Group D ─── Task 6  Task 7
            Slack Bot  CLI changes
               │       │
               └───┬───┘
                   ▼
Group E ─── Task 8: E2E integration tests
```

## Parallel Groups

- **A**: Task 1 (foundation: entity + schema)
- **B**: Tasks 2, 3 (independent: orchestrator logic and API endpoints both need only the entity)
- **C**: Tasks 4, 5 (independent: headless CC needs orchestrator; preview URL needs API)
- **D**: Tasks 6, 7 (independent: Slack bot needs orchestrator + API; CLI needs API)
- **E**: Task 8 (final verification)

## Critical Path

Task 1 → Task 2 → Task 4 → Task 8

(4 sequential stages)

## Dependency Edges (precise)

- Task 1 → Tasks 2, 3 (entity types + DB schema needed by orchestrator and API)
- Task 2 → Tasks 4, 6 (orchestrator state machine needed by headless CC invocation and Slack bot)
- Task 3 → Tasks 5, 6, 7 (API endpoints needed by preview URL, Slack bot, and CLI)
- Tasks 4, 5, 6, 7 → Task 8 (E2E tests verify everything)

## Cross-Phase Dependencies

- **Phase 5**: Remote env provisioning (Tasks 6, 8), SSH key lifecycle (Task 4), EC2 client (Task 3) — Phase 7 calls existing Phase 5 provisioning APIs and SSH infrastructure
- **Phase 3**: Git event handlers — Phase 7 leverages existing git.push tracking when CC pushes branches
- **Phase 1**: Event pipeline — new `change.*` event types flow through existing pipeline
- **Phase 2**: Session pipeline — headless CC sessions are tracked as normal sessions

## Key Design Decisions

### 1. Change Request as a New Abstraction
The Change Request is a workflow orchestration record, not an extension of Session or Event. It has its own lifecycle (pending → provisioning → implementing → deployed → approved → merging → merged | rejected | failed) and references Sessions, Devices, and Workspaces. This is deliberately a 6th abstraction beyond CORE.md's original 5.

### 2. EC2 is the Preview (Option A)
The remote environment already has the code, Docker, ports, and a public IP. After CC makes the change, just run the app on the remote and construct the URL from `{public_ip}:{port}`. This reuses existing Phase 5 infrastructure with zero new deployment abstractions. The remote stays alive until approval/rejection instead of auto-terminating on idle.

### 3. Remote Env TTL Override for Change Requests
Remote environments provisioned for change requests override the default idle timeout. They stay alive until explicit approval/rejection, not auto-terminate after 60 minutes of "idle." The lifecycle enforcer (Phase 5 Task 9) checks `remote_envs.change_request_id` and skips idle termination for linked environments.

### 4. Headless CC via `claude --task`
Claude Code supports headless execution via `claude --task "<description>"`. The change orchestrator SSHs into the remote environment and runs this command, capturing exit code and output. The session is tracked through the normal event pipeline.

### 5. Simple Merge Strategy
Start with `git merge --no-ff` on the remote, then push to main. For repos with branch protection rules, a future enhancement would create a PR via GitHub API. Start simple.

### 6. Slack Security
Since fuel-code is single-user, the Slack bot verifies the requesting user matches configured Slack workspace/user IDs. Slack's `event_id` is used as a dedup key to prevent duplicate change requests from message retries.

### 7. Cost Awareness
Each change request provisions an EC2 instance. At ~$0.17/hr for t3.xlarge, a 30-minute change cycle costs ~$0.09. The bot includes cost info in its acknowledgment message.

## Dependencies Added in Phase 7

```bash
# Slack bot (new package)
mkdir -p packages/slack && cd packages/slack && bun init
bun add @slack/bolt
bun add -d @types/node

# No new deps for server, CLI, or core — all existing infrastructure reused.
```

## What Already Exists (from Phases 1-6)

### Remote Environments (Phase 5)
- `POST /api/remote` — provision EC2 instance from blueprint
- `GET /api/remote/:id` — status polling
- `POST /api/remote/:id/terminate` — cleanup
- SSH key lifecycle (generate, upload to S3, download, cleanup)
- Lifecycle enforcer (idle/TTL/orphan detection)
- `fuel-code remote up/ssh/ls/down` CLI commands

### Event Pipeline (Phase 1)
- POST /api/events/ingest → Redis Stream → Processor → Postgres
- Handler registry: `registry.register("type", handler)`
- All event types defined in shared schemas

### Session Tracking (Phase 2)
- Transcript upload, parse, summarize pipeline
- Session lifecycle state machine

### Git Tracking (Phase 3)
- Git hooks capture commit, push, checkout, merge events
- Session-git correlation

### TUI Dashboard (Phase 4)
- WebSocket live updates
- Ink-based terminal UI

### Hardening (Phase 6)
- Retry utilities, error formatting, progress indicators
- Graceful Ctrl-C with cleanup stacks
