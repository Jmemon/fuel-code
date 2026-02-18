# Phase 5: Remote Dev Environments — Task Dependency DAG

## Overview

Phase 5 adds disposable remote dev environments to fuel-code. Users auto-detect a project's environment requirements, provision an EC2 instance running Docker, SSH into it, and have remote events flow through the same pipeline as local events. Environments auto-terminate on idle timeout or TTL expiry. Orphaned instances are detected and cleaned up.

**What Phase 5 delivers**:
- `fuel-code blueprint detect` — auto-detect runtime, deps, Docker image from repo contents
- `fuel-code blueprint show` / `fuel-code blueprint validate` — inspect and validate `.fuel-code/env.yaml`
- `fuel-code remote up` — provision EC2 + Docker from blueprint, with progress display and graceful Ctrl-C abort
- `fuel-code remote ssh <id>` — SSH into a running remote environment
- `fuel-code remote ls` — list active remote environments with status, uptime, cost
- `fuel-code remote down <id>` / `fuel-code remote down --all` — terminate environments
- Server-side lifecycle management: idle timeout (60 min default), TTL (8 hour default), provisioning timeout (10 min), orphan detection
- Remote event handlers (`remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, `remote.terminate`)
- TUI remote panel showing active environments with live WebSocket updates

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Blueprint Detector: Auto-Detect Project Environment | A | — |
| 2 | Blueprint Schema, Validation, and env.yaml I/O | A | — |
| 3 | AWS EC2 Client Wrapper with Mock Boundary | A | — |
| 4 | SSH Key Lifecycle Manager | A | — |
| 5 | User-Data Script + Dockerfile.remote + Template Renderer | A | — |
| 6 | Remote API Endpoints + DB Queries + Migration | B | 3, 4 |
| 7 | Remote Event Handlers (provision.start/ready/error, terminate) | B | 6 |
| 8 | Provisioning Orchestrator (Full Pipeline) | C | 3, 4, 5, 6 |
| 9 | Lifecycle Enforcer: Idle/TTL + Orphan Detection | C | 3, 6 |
| 10 | Blueprint CLI Commands (detect, show, validate) | D | 1, 2 |
| 11 | `fuel-code remote up` + Graceful Abort | D | 8, 10 |
| 12 | `fuel-code remote ssh` | D | 6 |
| 13 | `fuel-code remote ls` + `fuel-code remote down` | D | 6 |
| 14 | TUI Remote Panel + WebSocket Integration | E | 7, 13 |
| 15 | Phase 5 E2E Integration Tests | F | 9, 10, 11, 12, 13, 14 |

## Dependency Graph

```
Group A ─── Task 1: Blueprint   Task 2: Blueprint   Task 3: AWS EC2    Task 4: SSH Key   Task 5: User-data
            detector            schema + I/O         client wrapper     lifecycle mgr     script + renderer
               │                   │                    │    │              │                    │
               │                   │                    │    │              │                    │
               │                   │                    │    └──────┐       │                    │
               │                   │                    │          │       │                    │
               │                   │                    │          ▼       ▼                    │
Group B ───────│───────────────────│─────────────── Task 6: Remote API endpoints ──────────────│──
               │                   │                 + DB queries + migration                   │
               │                   │                    │         │                             │
               │                   │                    │         │                             │
               │                   │                    │    Task 7: Remote                     │
               │                   │                    │    event handlers                     │
               │                   │                    │         │                             │
               │                   │           ┌────────┤         │                             │
               │                   │           │        │         │                             │
               ▼                   ▼           ▼        │         │                ┌────────────┘
Group C ─── ──────────── Task 8: Provisioning  │        │         │
                         orchestrator (full     │        │         │
                         pipeline) ◄────────────────────┘         │
               │                   │           │                  │
               │                   │      Task 9: Lifecycle       │
               │                   │      enforcer (idle/TTL      │
               │                   │      + orphan detection)     │
               │                   │           │                  │
               ▼                   ▼           │                  │
Group D ─── Task 10: blueprint    Task 11:     │    Task 12:    Task 13:
            CLI commands          remote up     │    remote ssh  remote ls +
               │                  + abort       │                remote down
               │                     │          │        │           │
               │                     │          │        │           │
               │                     │          │        │           ▼
Group E ───────│─────────────────────│──────────│────────│──── Task 14: TUI
               │                     │          │        │    remote panel +
               │                     │          │        │    WS integration
               │                     │          │        │           │
               └─────────────────────┴──────────┴────────┴───────────┘
                                     │
                                     ▼
Group F ─── Task 15: Phase 5 E2E Integration Tests
```

## Parallel Groups

- **A**: Tasks 1, 2, 3, 4, 5 (fully independent: blueprint detection logic, blueprint I/O, AWS EC2 wrapper, SSH key manager, user-data script)
- **B**: Tasks 6, 7 (API endpoints need EC2 client + SSH keys; event handlers need the API/DB layer)
- **C**: Tasks 8, 9 (orchestrator composes all infra pieces; lifecycle enforcer needs EC2 + API)
- **D**: Tasks 10, 11, 12, 13 (CLI commands: blueprint needs detector + I/O; remote up needs orchestrator + blueprint; ssh/ls/down need API)
- **E**: Task 14 (TUI integration needs event handlers + ls/down commands)
- **F**: Task 15 (final E2E verification)

## Critical Path

Task 3 → Task 6 → Task 8 → Task 11 → Task 15

(5 sequential stages. The AWS client feeds the API endpoints, which feed the orchestrator, which feeds `remote up`, then E2E tests. Parallel path: Task 1 → Task 10 → Task 11 merges at `remote up`.)

## Dependency Edges (precise)

- Task 1 → Task 10 (detector logic needed by `blueprint detect` command)
- Task 2 → Task 10 (I/O and validation functions needed by blueprint CLI commands)
- Task 3 → Tasks 6, 8, 9 (EC2 client needed by API authorize-ip endpoint, provisioning orchestrator, and lifecycle enforcer for termination)
- Task 4 → Tasks 6, 8 (SSH key manager needed by ssh-key download endpoint and provisioning orchestrator)
- Task 5 → Task 8 (user-data template needed by provisioning orchestrator)
- Task 6 → Tasks 7, 8, 9, 12, 13 (API endpoints + DB layer consumed by event handlers, orchestrator, lifecycle enforcer, and all CLI remote commands)
- Task 7 → Task 14 (event handlers produce `remote.update` events the TUI panel subscribes to)
- Task 8 → Task 11 (`remote up` triggers the server-side orchestrator)
- Task 10 → Task 11 (`remote up` calls blueprint detect/load as first step)
- Task 13 → Task 14 (TUI remote panel reuses the data-fetching from `remote ls`)
- Tasks 9, 10, 11, 12, 13, 14 → Task 15 (E2E tests verify everything)

## Key Design Decisions

### 1. EC2 Client as Interface + Mock (from Draft C)
The EC2 client defines a clean `Ec2Operations` interface that both the real `@aws-sdk/client-ec2` implementation and a `MockEc2Client` satisfy. All server code depends on the interface, never on the AWS SDK directly. The mock records calls and supports injectable failures for testing cleanup logic at each provisioning stage.

### 2. Provisioning is Server-Side, Not CLI-Side (all drafts)
`fuel-code remote up` calls `POST /api/remote` with the frozen blueprint. The server performs all AWS operations. The CLI polls `GET /api/remote/:id` for progress (falling back from WebSocket). This is critical because the server has AWS credentials, can receive the EC2 ready callback, and tracks instances even if the CLI crashes.

### 3. User-Data Script is a Bash Template (all drafts)
The user-data script (`infra/docker/scripts/user-data.sh`) uses `{{VARIABLE}}` placeholders replaced at provisioning time. The `renderUserData(params)` function reads the template, substitutes all placeholders, validates none remain, and returns the script for base64 encoding. Template variables: `{{DOCKER_IMAGE}}`, `{{REPO_URL}}`, `{{REPO_BRANCH}}`, `{{SETUP_COMMANDS}}`, `{{ENV_VARS}}`, `{{PORT_MAPPINGS}}`, `{{BACKEND_URL}}`, `{{API_KEY}}`, `{{REMOTE_ENV_ID}}`, `{{ANTHROPIC_API_KEY}}`, `{{SSH_PUBLIC_KEY}}`, `{{SYSTEM_DEPS}}`.

### 4. SSH Key Security: Ephemeral, One-Time Download, Cleaned Up (from Drafts A + C)
SSH keys are generated fresh per-environment (ed25519 via `ssh-keygen`), stored in S3 with server-side encryption, downloadable exactly once (410 Gone on subsequent calls), cached locally at `~/.fuel-code/ssh-keys/{id}/id_ed25519`, and deleted from S3 on termination. The local copy is cleaned up by `remote down`.

### 5. Security Group: Per-User, Reused Across Environments (from Draft A)
A single `fuel-code-remote` security group is created once and reused. On each `remote up` / `remote ssh`, the caller's public IP is authorized for SSH ingress. This avoids accumulating security groups. The API has `POST /api/remote/:id/authorize-ip` for the CLI to add its own IP before SSH.

### 6. Blueprint Detection is Pure (from Draft B)
The detector in `packages/core/` receives a structured `ProjectInfo` (file contents + file list) and returns a `BlueprintConfig`. No direct filesystem I/O in the detector itself — the CLI handles reading files and passing them in. This makes the detector fully unit-testable without touching the filesystem.

### 7. Lifecycle Enforcer with Orphan Detection (from Drafts A + C, synthesized)
A single server-side periodic job handles three concerns:
- **TTL check** (every 60s): environments older than `ttl_minutes` from provisioning are terminated
- **Idle check** (every 60s): environments with no events for `idle_timeout_minutes` transition to `idle` first (warning), then terminate on the next check if still idle (two-step from Draft B)
- **Provisioning timeout** (every 60s): environments stuck in `provisioning` for >10 minutes are marked `error` and terminated
- **Orphan sweep** (every 5 min): cross-references AWS EC2 instances tagged `fuel-code:managed=true` with `remote_envs` table, cleans up discrepancies in either direction
- Exposes `runOnce()` and injectable `now()` for deterministic testing

### 8. Graceful Ctrl-C During Provisioning (from Draft C)
The `remote up` command wraps provisioning in an abort handler. On SIGINT: prints "Aborting...", calls `POST /api/remote/:id/terminate` to clean up server-side, prints cleanup status. If cleanup fails, prints the manual cleanup command. Double Ctrl-C forces immediate exit. Implemented as a `withAbortHandler()` utility.

### 9. Provisioning Orchestrator as State Machine (from Draft C)
The provisioning flow tracks named stages: `INIT → KEYS_GENERATED → SG_READY → INSTANCE_LAUNCHED → TAGGED → DONE`. On failure at any stage, cleanup rolls back everything created in previous stages. This makes partial-failure behavior predictable and testable.

### 10. Session-Device Status Correlation (from Draft B)
When `session.start` fires from a remote device, the remote_env transitions to `active`. When the last active session ends (`session.end`), the remote_env transitions back to `ready`. This gives users accurate status in `remote ls` and the TUI.

### 11. Two-Step Idle Transition (from Draft B)
Idle detection uses two phases: first transition to `idle` (visible in TUI as yellow), then terminate on the next lifecycle check if still idle. This gives users a warning window. If they start a new session, the env transitions to `active` and the idle timer resets.

### 12. ApiClient Extended, Not Replaced (from Draft B)
The existing `ApiClient` in `packages/cli/src/lib/api-client.ts` gets new remote environment methods: `provisionRemote()`, `getRemoteEnvs()`, `getRemoteEnv()`, `terminateRemoteEnv()`, `getRemoteEnvSshKey()`, `authorizeRemoteIp()`. Same pattern as sessions/workspaces.

## What Already Exists (from Phases 1-4)

### Server (packages/server/)
- Express app with auth middleware, error handling, pino logging
- Full event pipeline: POST /api/events/ingest → Redis Stream → Event processor → Postgres
- Session CRUD endpoints, timeline, workspace/device endpoints
- WebSocket server with subscriptions and broadcast (`remote.update` message type already defined)
- S3 client (`@aws-sdk/client-s3`) for transcript storage — extendable for SSH key storage
- Postgres pool, migrations runner, health check
- Handler registry for event types (session.start, session.end, git.*)
- `packages/server/src/aws/` directory (has s3-client.ts)

### CLI (packages/cli/)
- Commander entry point with all Phase 1-4 commands
- `ApiClient` class with methods for sessions, workspaces, devices, timeline, health
- `WsClient` for WebSocket with auto-reconnect
- Config management (`~/.fuel-code/config.yaml` with `aws.region`, `aws.profile`, `remote.*` fields)
- Output formatting utilities (tables, durations, costs, colors)
- Ink-based TUI dashboard with workspace sidebar, session list, live updates
- Error hierarchy (FuelCodeError subclasses), pino logger

### Shared (packages/shared/)
- All types: Event, Session, Workspace, Device, Blueprint, RemoteEnv
- Zod schemas for `remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, `remote.terminate` event payloads
- Blueprint Zod schema for env.yaml validation
- ULID generation, canonical ID normalization

### Core (packages/core/)
- Event processor, transcript parser, summary generator
- Workspace resolver, session manager, git correlator

### Infrastructure
> **NOTE: No infrastructure files exist yet.** The `infra/` directory, `Dockerfile.remote`, `user-data.sh`, and `schema.sql` do NOT exist from prior phases. Phase 5 creates all of these.

### Database
> **NOTE: `remote_envs` and `blueprints` tables do NOT exist.** Phase 1's schema has only 5 tables: `workspaces`, `devices`, `workspace_devices`, `sessions`, `events`. Phase 5 Task 6 MUST create both tables via migration. Additionally, Phase 1's `sessions` table has a `remote_env_id TEXT` column with NO foreign key constraint — Phase 5's migration must `ALTER TABLE sessions ADD CONSTRAINT` to create the FK to `remote_envs`.

### What Phase 5 Must Create (does NOT already exist)
- `remote_envs` table (via migration in Task 6)
- `blueprints` table (via migration in Task 6)
- `ALTER TABLE sessions` to add FK on `remote_env_id` → `remote_envs(id)` (Task 6 migration)
- `blueprint-detector.ts` (Task 1 — no placeholder exists)
- `infra/docker/Dockerfile.remote` (Task 5)
- `infra/docker/scripts/user-data.sh` (Task 5)
- `packages/server/src/aws/ec2-client.ts` (Task 3)

### NOT yet built (Phase 5 creates)
- Blueprint detection logic (implementation)
- Blueprint YAML I/O and validation (read/write `.fuel-code/env.yaml`)
- EC2 client wrapper + mock
- SSH key generation + S3 storage
- Security group management
- User-data script + template renderer
- Remote API endpoints implementation
- Remote event handlers
- Provisioning orchestrator
- Lifecycle enforcer (idle/TTL/orphan)
- All `fuel-code blueprint` CLI commands
- All `fuel-code remote` CLI commands (up, ssh, ls, down)
- TUI remote panel

## Dependencies Added in Phase 5

```bash
# Server — EC2 SDK for provisioning
cd packages/server && bun add @aws-sdk/client-ec2

# Core — YAML parser for blueprint I/O
cd packages/core && bun add js-yaml
cd packages/core && bun add -d @types/js-yaml
```

No other new dependencies needed. `@aws-sdk/client-s3` (SSH key storage), `picocolors` (CLI output), `commander` (command registration), `ws` (WebSocket), `ink`/`react` (TUI) are all already installed from prior phases.
