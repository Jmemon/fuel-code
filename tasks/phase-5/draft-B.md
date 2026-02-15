# Phase 5: Remote Dev Environments — Task Dependency DAG (Draft B: User-Journey-First)

## Overview

Phase 5 adds disposable remote dev environments to fuel-code. After Phase 5, a user can auto-detect their project's environment, provision an EC2 instance with Docker, SSH into it, list running environments, and tear them down — all from the CLI. Remote machines run fuel-code with the same hooks and event pipeline as local machines, so sessions on remote devices appear alongside local sessions in the dashboard.

**Design philosophy (Draft B)**: Organized around the five CLI commands the user will actually run: `blueprint detect`, `remote up`, `remote ssh`, `remote ls`, `remote down`. Each user-visible feature pulls in whatever backend, infra, or shared-layer pieces it needs. Cross-cutting infrastructure (EC2 client, SSH key management, remote API endpoints) is extracted into separate tasks only when multiple features depend on the same piece.

**What the user gets after Phase 5**:
- `fuel-code blueprint detect` — scans current repo, generates `.fuel-code/env.yaml`
- `fuel-code blueprint show` — displays current env.yaml
- `fuel-code blueprint validate` — validates env.yaml against schema
- `fuel-code remote up` — provisions EC2 + Docker from blueprint, waits for ready, connects
- `fuel-code remote ssh <id>` — SSH into an existing remote environment
- `fuel-code remote ls` — lists all remote environments with status
- `fuel-code remote down <id>` — terminates a remote environment
- `fuel-code remote down --all` — terminates all environments (with confirmation)
- Server-side idle timeout + TTL auto-termination
- Remote environments visible in TUI dashboard (sidebar shows active remotes)

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Blueprint Detector: Auto-Detection Engine | A | -- |
| 2 | `fuel-code blueprint` Commands (detect, show, validate) | B | 1 |
| 3 | Remote API Endpoints + Database Migration | A | -- |
| 4 | AWS EC2 Client + SSH Key Manager | A | -- |
| 5 | User-Data Script + Dockerfile.remote | A | -- |
| 6 | `fuel-code remote up` Command (Provisioning Orchestrator) | C | 2, 3, 4, 5 |
| 7 | `fuel-code remote ssh` Command | D | 3, 4 |
| 8 | `fuel-code remote ls` + `fuel-code remote down` Commands | D | 3, 4 |
| 9 | Remote Event Handlers + Idle/TTL Auto-Termination | D | 3, 4 |
| 10 | TUI Remote Panel + WebSocket remote.update | E | 8, 9 |
| 11 | Phase 5 E2E Integration Tests | F | 2, 6, 7, 8, 9, 10 |

## Dependency Graph

```
Group A ─── Task 1: Blueprint     Task 3: Remote API     Task 4: EC2 client    Task 5: User-data
            detector              endpoints + migration  + SSH key manager      script + Dockerfile
               │                     │         │            │        │
               ▼                     │         │            │        │
Group B ─── Task 2: blueprint       │         │            │        │
            detect/show/validate     │         │            │        │
               │                     │         │            │        │
               │         ┌───────────┘    ┌────┘       ┌────┘        │
               │         │               │            │             │
               │         │    ┌──────────┤            │             │
               │         │    │          │            │             │
               ▼         ▼    ▼          ▼            ▼             │
Group C ─── Task 6: remote up  ◄─────────────────────────────────────┘
            (orchestrates all of the above)
               │
               │         ┌───────────────┬─────────────────────┐
               │         │               │                     │
               │         ▼               ▼                     ▼
Group D ─── Task 7     Task 8          Task 9
            remote ssh  remote ls +     remote event
                        remote down     handlers + idle/TTL
               │         │               │
               │         └───────┬───────┘
               │                 ▼
Group E ───            Task 10: TUI remote
                       panel + WS updates
                                │
               ┌────────────────┤
               │                │
               ▼                ▼
Group F ─── Task 11: Phase 5 E2E integration tests
```

## Parallel Groups

- **A**: Tasks 1, 3, 4, 5 (fully independent: blueprint detection logic, server endpoints, AWS client, Docker/user-data infra)
- **B**: Task 2 (CLI blueprint commands, needs the detection engine from Task 1)
- **C**: Task 6 (the main provisioning orchestrator, needs blueprint commands + API + EC2 + user-data)
- **D**: Tasks 7, 8, 9 (all independent of each other, all need API endpoints + EC2 client; can be built in parallel with or after Task 6)
- **E**: Task 10 (TUI integration, needs list/down commands and event handlers to be done)
- **F**: Task 11 (E2E verification of everything)

## Critical Path

Task 1 --> Task 2 --> Task 6 --> Task 8 --> Task 10 --> Task 11

(6 sequential stages. Parallel paths: Task 3 feeds into 6/7/8/9; Task 4 feeds into 6/7/8/9; Task 5 feeds into 6)

## Dependency Edges (precise)

- Task 1 --> Task 2 (detector engine needed for `blueprint detect` command)
- Task 2 --> Task 6 (`remote up` calls blueprint detect/load as first step)
- Task 3 --> Tasks 6, 7, 8, 9 (all remote operations need API endpoints for CRUD and the migration for `remote_envs` rows)
- Task 4 --> Tasks 6, 7, 8 (EC2 client for provisioning, key download for SSH, instance termination for down)
- Task 5 --> Task 6 (user-data script and Dockerfile used during provisioning)
- Task 8 --> Task 10 (TUI panel lists remote envs using same data-fetch as `remote ls`)
- Task 9 --> Task 10 (TUI subscribes to `remote.update` WebSocket events from idle/TTL checker)
- Tasks 2, 6, 7, 8, 9, 10 --> Task 11 (E2E tests verify all features)

## Key Design Decisions

### 1. Blueprint Detection is Pure Core Logic
The blueprint detector lives in `packages/core/src/blueprint-detector.ts` with no I/O dependencies. It receives a file listing (directory contents, file contents) and returns a Blueprint config object. The CLI command handles filesystem I/O (reading package.json, Cargo.toml, etc.) and passes the data into the detector. This makes the detector unit-testable without touching the filesystem.

### 2. EC2 Client Wraps @aws-sdk/client-ec2 with Retry
The EC2 client (`packages/server/src/aws/ec2-client.ts`) wraps the AWS SDK with retry logic (exponential backoff, 3 attempts), structured logging, and typed return values. It exposes focused methods: `launchInstance()`, `terminateInstance()`, `describeInstance()`, `createSecurityGroup()`, `authorizeIngress()`. The S3 client pattern from Phase 1 is followed.

### 3. SSH Key Management via S3
Ephemeral SSH keys are generated locally (via `ssh-keygen`), uploaded to S3 at `ssh-keys/{remote_env_id}/id_ed25519[.pub]`, and downloaded by the `remote ssh` command. Keys are deleted from S3 on termination. The server never holds private keys in Postgres -- only the S3 path.

### 4. User-Data Script is a Templated Bash Script
The EC2 user-data script (`infra/docker/scripts/user-data.sh`) is a bash template. At provisioning time, the server renders it by substituting variables (Docker image, repo URL, branch, env vars, ports, setup commands, API key, backend URL, remote env ID). The rendered script is passed as EC2 user-data. No configuration management tools.

### 5. Provisioning is Server-Initiated, CLI-Polled
`fuel-code remote up` POSTs to `POST /api/remote` with the blueprint. The server creates the `remote_envs` row, generates SSH keys, launches EC2, and returns immediately with the remote env ID. The CLI then polls `GET /api/remote/:id` every 5 seconds, showing a spinner with status updates, until status becomes `ready` (or `error`). The EC2 instance calls back to `POST /api/remote/:id/ready` when user-data completes.

### 6. Idle Detection is Server-Side Polling
The server runs a periodic check (every 5 minutes) that queries `remote_envs WHERE status IN ('ready', 'active', 'idle')`. For each, it checks the last event timestamp from that device. If no events in `idle_timeout_minutes`, it transitions to `idle` and then terminates. If `provisioned_at + ttl_minutes` has passed, it terminates regardless. No daemon runs on the remote machine.

### 7. SSH Shells Out to System `ssh`
The `remote ssh` command downloads the private key from S3 to a temp file, runs `ssh -i <keyfile> -p 22 ec2-user@<ip>` via `Bun.spawn` with `stdio: 'inherit'`, and deletes the temp key file on exit. No ssh2 npm library.

### 8. Security Group Per User, Not Per Environment
A single security group named `fuel-code-remote` is created (or reused) in the target region. Its inbound SSH rule is updated to the caller's current public IP on each `remote up`. This avoids accumulating security groups. The trade-off: if the user's IP changes, they need to re-run `remote up` or manually update the SG. For a single-user system, this is acceptable.

### 9. Remote Events Flow Through Existing Pipeline
Remote machines have fuel-code installed with the same hooks. Events from remote devices hit the same `POST /api/events/ingest` endpoint and flow through the same Redis -> Processor -> Postgres pipeline. The backend does not special-case remote events. The `remote.provision.start`, `remote.provision.ready`, and `remote.terminate` events are new event types with their own handlers, but they use the same handler registry pattern.

### 10. ApiClient Extended, Not Replaced
The existing `ApiClient` in `packages/cli/src/lib/api-client.ts` is extended with remote environment methods (`provisionRemote()`, `getRemoteEnvs()`, `getRemoteEnv()`, `terminateRemoteEnv()`, `getRemoteEnvSshKey()`). Same pattern as sessions/workspaces.

## What Already Exists (from Phases 1-4)

### Server (packages/server/)
- Express app with auth middleware, error handling, pino logging
- Full event pipeline: POST /api/events/ingest --> Redis Stream --> Event processor --> Postgres
- Session CRUD endpoints, timeline, workspace/device endpoints
- WebSocket server with subscriptions and broadcast (`remote.update` message type already defined in WS protocol)
- S3 client (`packages/server/src/aws/s3-client.ts`) using @aws-sdk/client-s3
- Postgres pool, migrations runner, health check
- Handler registry for event types
- `packages/server/src/aws/` directory exists (has s3-client.ts)
- `packages/server/src/routes/remote.ts` -- placeholder or not yet created

### CLI (packages/cli/)
- Commander entry point with all Phase 1-4 commands registered
- `ApiClient` class with methods for sessions, workspaces, devices, timeline, health
- `WsClient` for WebSocket with auto-reconnect
- Config management (`~/.fuel-code/config.yaml` with `aws.region`, `aws.profile`, `remote.*` fields defined in CORE.md)
- Output formatting utilities (tables, durations, costs, colors)
- Ink-based TUI dashboard with workspace sidebar, session list, live updates
- TUI session detail view with transcript viewer
- `packages/cli/src/commands/blueprint.ts` -- placeholder or not yet created
- `packages/cli/src/commands/remote-up.ts` -- placeholder or not yet created
- `packages/cli/src/commands/remote-ssh.ts` -- placeholder or not yet created
- `packages/cli/src/commands/remote-ls.ts` -- placeholder or not yet created
- `packages/cli/src/commands/remote-down.ts` -- placeholder or not yet created

### Shared (packages/shared/)
- All types including `Blueprint`, `RemoteEnv` in `packages/shared/src/types/blueprint.ts` and `packages/shared/src/types/remote.ts`
- Zod schemas for `remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, `remote.terminate` event payloads
- Blueprint Zod schema for env.yaml validation
- ULID generation, canonical ID normalization

### Core (packages/core/)
- Event processor, transcript parser, summary generator
- Workspace resolver, session manager, git correlator
- `packages/core/src/blueprint-detector.ts` -- placeholder (exists but not implemented)

### Infrastructure
- `infra/docker/Dockerfile.remote` -- placeholder
- `infra/docker/scripts/user-data.sh` -- placeholder
- `infra/sql/schema.sql` -- includes `remote_envs` and `blueprints` tables

### Database Schema (already defined)
- `remote_envs` table with columns: id, workspace_id, device_id, status, instance_id, instance_type, region, public_ip, ssh_key_s3_key, blueprint (JSONB), ttl_minutes, idle_timeout_minutes, cost_per_hour_usd, total_cost_usd, provisioned_at, ready_at, terminated_at, termination_reason, metadata
- `blueprints` table with columns: id, workspace_id, name, source, detected_from, config (JSONB), created_at, updated_at
- Status enum: provisioning, ready, active, idle, terminated, error

---

## Task Details

---

### Task 1: Blueprint Detector — Auto-Detection Engine

**Parallel Group: A**

**Description**

Implement the blueprint auto-detection engine in `packages/core/src/blueprint-detector.ts`. This module scans a project's files to determine runtime, version, package manager, system dependencies, Docker base image, and setup commands. It receives a structured representation of the project's file tree and file contents (no direct filesystem I/O), and returns a complete Blueprint config object that can be serialized to `.fuel-code/env.yaml`.

The detector uses a priority-ordered list of detection strategies. Each strategy checks for specific files and extracts configuration. The first matching strategy's runtime wins, but system_deps and setup commands are merged across strategies.

**Detection strategies (ordered by priority)**:

1. **Existing env.yaml**: If `.fuel-code/env.yaml` already exists, parse and return it (no detection needed). The CLI layer handles this check before calling the detector.

2. **Node.js**: Check for `package.json`.
   - Runtime: `node`
   - Version: Parse `engines.node` from package.json. If absent, default `"22"`.
   - Package manager: Check for `bun.lockb` -> `bun`, `pnpm-lock.yaml` -> `pnpm`, `yarn.lock` -> `yarn`, default `npm`.
   - Base image: `node:{version}-bookworm` (Debian for broad compatibility).
   - Setup: `{package_manager} install`.
   - Detect ports from `scripts.start` or `scripts.dev` (look for `--port` or common patterns).

3. **Python**: Check for `pyproject.toml`, `requirements.txt`, `Pipfile`, or `setup.py`.
   - Runtime: `python`
   - Version: Parse from `pyproject.toml` `[project].requires-python` or `.python-version`. Default `"3.12"`.
   - Package manager: Check for `uv.lock` -> `uv`, `Pipfile.lock` -> `pipenv`, `poetry.lock` -> `poetry`, default `pip`.
   - Base image: `python:{version}-bookworm`.
   - Setup: `{pm} install` (or `pip install -r requirements.txt` for pip).

4. **Rust**: Check for `Cargo.toml`.
   - Runtime: `rust`
   - Version: Parse `rust-version` from Cargo.toml. Default `"stable"`.
   - Package manager: `cargo`.
   - Base image: `rust:{version}-bookworm`.
   - Setup: `cargo build`.

5. **Go**: Check for `go.mod`.
   - Runtime: `go`
   - Version: Parse `go` directive from go.mod. Default `"1.22"`.
   - Package manager: `go`.
   - Base image: `golang:{version}-bookworm`.
   - Setup: `go mod download`.

6. **Generic/Fallback**: No recognized project files.
   - Runtime: `generic`
   - Base image: `ubuntu:24.04`.
   - Setup: empty.

**System dependency detection**: Scan for common patterns across all strategies:
- `docker-compose.yml` or `compose.yaml` with `postgres` -> add `postgresql-client`.
- `docker-compose.yml` with `redis` -> add `redis-tools`.
- `.env` or config files referencing database URLs -> infer system deps.
- `Makefile` presence -> add `make` to system_deps.

**Resource defaults**:
- `instance_type`: `t3.xlarge` (from config, fallback)
- `region`: from CLI config `aws.region`, fallback `us-east-1`
- `disk_gb`: `50`

**Interface**:

```typescript
// Input: structured project info (no filesystem I/O)
export interface ProjectInfo {
  files: Map<string, string>;  // relative path -> file content (only config files, not all files)
  fileList: string[];           // all file paths in the project (for pattern detection)
  gitRemote: string | null;     // git remote URL
  gitBranch: string | null;     // current branch
}

// Output: complete blueprint config
export interface BlueprintConfig {
  runtime: string;
  version: string;
  package_manager: string;
  system_deps: string[];
  docker: {
    base_image: string;
    additional_packages: string[];
  };
  resources: {
    instance_type: string;
    region: string;
    disk_gb: number;
  };
  environment: Record<string, string>;
  ports: number[];
  setup: string[];
}

export function detectBlueprint(project: ProjectInfo): BlueprintConfig;
```

**Files to Create**
- `packages/core/src/blueprint-detector.ts` (replace placeholder)
- `packages/core/src/__tests__/blueprint-detector.test.ts`

**Files to Modify**
- `packages/core/src/index.ts` -- export `detectBlueprint`

**Tests**

`blueprint-detector.test.ts`:
1. Node.js project with `package.json` + `bun.lockb` -> runtime=node, pm=bun, base_image=node:22-bookworm.
2. Node.js project with `package.json` + `yarn.lock` -> pm=yarn.
3. Node.js with explicit `engines.node: "20"` -> version=20.
4. Python project with `pyproject.toml` + `uv.lock` -> runtime=python, pm=uv.
5. Python project with `requirements.txt` only -> pm=pip.
6. Rust project with `Cargo.toml` -> runtime=rust, pm=cargo.
7. Go project with `go.mod` -> runtime=go, version parsed from go directive.
8. No recognized files -> runtime=generic, base_image=ubuntu:24.04.
9. Node.js project with `docker-compose.yml` containing postgres service -> system_deps includes `postgresql-client`.
10. Node.js project with `docker-compose.yml` containing redis service -> system_deps includes `redis-tools`.
11. Project with Makefile -> system_deps includes `make`.
12. Multiple signals: Node.js + Makefile + docker-compose with postgres -> all merged correctly.
13. Empty project (no files at all) -> falls through to generic.
14. Package.json with `scripts.start` containing `--port 3000` -> ports includes 3000.

**Success Criteria**
1. `detectBlueprint()` correctly identifies Node.js, Python, Rust, Go, and generic projects.
2. Package manager detection is accurate across all supported lock files.
3. Version extraction works from package.json, pyproject.toml, Cargo.toml, go.mod.
4. System dependency detection finds postgres and redis from docker-compose.
5. Resource defaults are sensible (t3.xlarge, us-east-1, 50GB).
6. The function is pure (no filesystem I/O, no network calls).
7. Output matches the BlueprintConfig schema expected by env.yaml serialization.
8. Edge cases (missing fields, malformed files) produce reasonable defaults, not crashes.

---

### Task 2: `fuel-code blueprint` Commands (detect, show, validate)

**Parallel Group: B**

**Description**

Implement three blueprint-related CLI commands: `fuel-code blueprint detect` (auto-detect and generate env.yaml), `fuel-code blueprint show` (display current env.yaml), and `fuel-code blueprint validate` (validate env.yaml against schema). These commands handle the filesystem I/O that the detector engine (Task 1) intentionally avoids.

**Command: `fuel-code blueprint detect`**

1. Check if `.fuel-code/env.yaml` already exists. If so, ask "Blueprint already exists. Overwrite? (y/N)".
2. Read relevant project files (package.json, pyproject.toml, Cargo.toml, go.mod, docker-compose.yml, Makefile, etc.) from the current working directory.
3. Build a `ProjectInfo` object and pass it to `detectBlueprint()` from Task 1.
4. Serialize the result to YAML using `js-yaml`.
5. Write to `.fuel-code/env.yaml` (create `.fuel-code/` directory if needed).
6. Print the generated YAML to stdout with syntax highlighting (dim comments).
7. Optionally save a record to the backend: `POST /api/blueprints` (or inline in `remote up`).

Output:
```
Detected environment for fuel-code:

  runtime: node
  version: "22"
  package_manager: bun
  system_deps:
    - postgresql-client
  docker:
    base_image: "node:22-bookworm"
    additional_packages: []
  resources:
    instance_type: t3.xlarge
    region: us-east-1
    disk_gb: 50
  environment:
    NODE_ENV: development
  ports:
    - 3000
    - 5432
  setup:
    - bun install

Written to .fuel-code/env.yaml
Review and edit as needed, then run `fuel-code remote up`.
```

**Command: `fuel-code blueprint show`**

1. Read `.fuel-code/env.yaml` from the current workspace.
2. If missing: print "No blueprint found. Run `fuel-code blueprint detect` to generate one."
3. If exists: print the YAML contents with formatting.

**Command: `fuel-code blueprint validate`**

1. Read `.fuel-code/env.yaml`.
2. Parse with js-yaml.
3. Validate against the Blueprint Zod schema from `packages/shared/`.
4. If valid: print "Blueprint is valid." with a green checkmark.
5. If invalid: print each validation error with field path and message. Exit 1.

Output (validation errors):
```
Blueprint validation errors:

  resources.instance_type: Invalid instance type "t3.nano". Must be one of: t3.medium, t3.large, t3.xlarge, t3.2xlarge, m5.xlarge, m5.2xlarge
  docker.base_image: Required field missing
  setup: Expected array, received string

Fix the errors in .fuel-code/env.yaml and re-run `fuel-code blueprint validate`.
```

**Files to Create**
- `packages/cli/src/commands/blueprint.ts` (replace placeholder)
- `packages/cli/src/commands/__tests__/blueprint.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` -- register blueprint commands
- `packages/cli/package.json` -- add `js-yaml` dependency
- `packages/shared/src/schemas/` -- ensure Blueprint Zod schema is complete with validation for instance types, regions, etc.

**Tests**

`blueprint.test.ts`:
1. `detect` in a Node.js project -> generates correct env.yaml, writes to disk.
2. `detect` with existing env.yaml -> prompts for overwrite (test both yes and no).
3. `detect` in empty directory -> generates generic blueprint.
4. `detect` with `--json` -> outputs JSON instead of YAML.
5. `show` with existing env.yaml -> prints YAML.
6. `show` with no env.yaml -> prints helpful message.
7. `validate` with valid env.yaml -> prints success, exit 0.
8. `validate` with invalid env.yaml -> prints errors, exit 1.
9. `validate` with missing required fields -> lists specific missing fields.
10. `validate` with unknown instance type -> shows allowed values.

**Success Criteria**
1. `fuel-code blueprint detect` scans the current directory and generates `.fuel-code/env.yaml`.
2. Generated YAML matches the BlueprintConfig structure from CORE.md.
3. Overwrite prompt prevents accidental loss of manually-edited blueprints.
4. `fuel-code blueprint show` displays the current blueprint or a helpful message.
5. `fuel-code blueprint validate` catches all schema violations with clear error messages.
6. Blueprint commands are registered in the CLI and appear in `fuel-code --help`.
7. `.fuel-code/` directory is created if it does not exist.
8. YAML output is clean and human-readable (proper quoting, no unnecessary anchors).

---

### Task 3: Remote API Endpoints + Database Migration

**Parallel Group: A**

**Description**

Add the remote environment REST API endpoints to the server and create the database migration for the `remote_envs` and `blueprints` tables. Although the schema is defined in `infra/sql/schema.sql`, the migration must be created in the server's migration system to apply it to the running database.

**API Endpoints**: `packages/server/src/routes/remote.ts`

```
POST   /api/remote                    # Provision a new remote environment
GET    /api/remote                    # List remote environments
GET    /api/remote/:id                # Get remote environment detail
POST   /api/remote/:id/terminate      # Terminate a remote environment
GET    /api/remote/:id/ssh-key        # Download SSH private key (one-time retrieval)
POST   /api/remote/:id/ready          # Callback from EC2 when user-data completes
```

**POST /api/remote** (provision):
- Request body: `{ workspace_id: string, blueprint: BlueprintConfig, git_remote: string, git_branch: string }`
- Creates a `remote_envs` row with status=`provisioning`.
- Generates a ULID for the remote env ID.
- Does NOT do EC2 provisioning itself (that is triggered by the provisioning orchestrator in Task 6 which calls this endpoint then handles EC2). Actually, the server-side approach: the CLI calls this endpoint, the server creates the row, then the server kicks off EC2 provisioning asynchronously (generates SSH keys, launches EC2, etc.). The endpoint returns immediately with the remote env ID and status=`provisioning`.
- Response: `{ id: string, status: "provisioning" }`

**GET /api/remote** (list):
- Query params: `?status=active&workspace_id=...`
- Returns all remote envs, ordered by `provisioned_at DESC`.
- Response: `{ data: RemoteEnv[] }`

**GET /api/remote/:id** (detail):
- Returns full remote env detail.
- Response: `RemoteEnv` with all fields.
- 404 if not found.

**POST /api/remote/:id/terminate**:
- Request body: `{ reason: "manual" | "ttl" | "idle" }` (reason defaults to "manual")
- Updates status to `terminated`, sets `terminated_at` and `termination_reason`.
- Triggers EC2 instance termination (async -- the handler calls EC2 terminate and cleans up SSH keys from S3).
- Emits `remote.terminate` event.
- Response: `{ status: "terminated" }`

**GET /api/remote/:id/ssh-key**:
- Downloads the private SSH key from S3.
- Returns the key as `text/plain`.
- Optionally: mark as "retrieved" in metadata to track one-time access (not enforced -- key can be re-downloaded).
- 404 if remote env not found or key not in S3.

**POST /api/remote/:id/ready** (callback from EC2):
- Request body: `{ instance_id: string, public_ip: string, ssh_port: number, device_id: string }`
- Updates remote env: status=`ready`, sets public_ip, device_id, ready_at.
- Emits `remote.provision.ready` event.
- Broadcasts `remote.update` via WebSocket.
- Response: `{ status: "ok" }`
- This endpoint is called by the user-data script on the EC2 instance, so it needs auth (the API key is passed to the remote machine during provisioning).

**Database Migration**:

Create a migration file that creates the `remote_envs` and `blueprints` tables as defined in `infra/sql/schema.sql`. Follow the existing migration file naming convention in `packages/server/src/db/migrations/`.

**Files to Create**
- `packages/server/src/routes/remote.ts` (replace placeholder if exists)
- `packages/server/src/routes/__tests__/remote.test.ts`
- `packages/server/src/db/migrations/NNNN_create_remote_envs.sql`

**Files to Modify**
- `packages/server/src/index.ts` -- register remote routes (`app.use('/api/remote', authMiddleware, remoteRouter)`)
- `packages/cli/src/lib/api-client.ts` -- add remote environment methods:
  - `provisionRemote(params)`: POST /api/remote
  - `getRemoteEnvs(params?)`: GET /api/remote
  - `getRemoteEnv(id)`: GET /api/remote/:id
  - `terminateRemoteEnv(id, reason?)`: POST /api/remote/:id/terminate
  - `getRemoteEnvSshKey(id)`: GET /api/remote/:id/ssh-key (returns raw text)

**Tests**

`remote.test.ts` (supertest against Express app with test DB):
1. `POST /api/remote` with valid body -> creates row, returns id + status=provisioning.
2. `POST /api/remote` with invalid blueprint -> 400 with validation errors.
3. `POST /api/remote` without auth -> 401.
4. `GET /api/remote` -> returns all remote envs.
5. `GET /api/remote?status=active` -> filters by status.
6. `GET /api/remote?workspace_id=...` -> filters by workspace.
7. `GET /api/remote/:id` -> returns detail.
8. `GET /api/remote/:id` with unknown id -> 404.
9. `POST /api/remote/:id/terminate` -> sets status=terminated, terminated_at, reason.
10. `POST /api/remote/:id/terminate` on already-terminated env -> 409 or idempotent success.
11. `GET /api/remote/:id/ssh-key` -> returns key as text/plain.
12. `GET /api/remote/:id/ssh-key` for unknown id -> 404.
13. `POST /api/remote/:id/ready` -> updates status=ready, sets public_ip, device_id, ready_at.
14. `POST /api/remote/:id/ready` for non-provisioning env -> 409.
15. Migration creates both tables with correct columns and constraints.

**Success Criteria**
1. All six API endpoints work with correct request/response shapes.
2. Provisioning creates a `remote_envs` row with status=`provisioning`.
3. Ready callback transitions to `ready` and records public_ip and device_id.
4. Termination is idempotent and records reason.
5. SSH key endpoint returns the private key as plain text from S3.
6. List endpoint supports filtering by status and workspace_id.
7. All endpoints require auth.
8. Migration creates `remote_envs` and `blueprints` tables matching the schema.
9. `ApiClient` remote methods match endpoint request/response shapes.
10. WebSocket `remote.update` is broadcast on status transitions.

---

### Task 4: AWS EC2 Client + SSH Key Manager

**Parallel Group: A**

**Description**

Create the EC2 client module and SSH key management utilities. The EC2 client wraps `@aws-sdk/client-ec2` with typed methods for launching, terminating, and describing instances, plus security group management. The SSH key manager generates ephemeral ed25519 key pairs and stores/retrieves them from S3.

**EC2 Client: `packages/server/src/aws/ec2-client.ts`**

```typescript
import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';

export interface Ec2ClientOptions {
  region: string;
  profile?: string;  // AWS CLI profile for credential resolution
}

export interface LaunchInstanceParams {
  instanceType: string;
  amiId: string;           // Amazon Linux 2023 AMI ID (looked up per region)
  securityGroupId: string;
  keyName?: string;         // not used (we inject SSH key via user-data)
  userData: string;         // base64-encoded user-data script
  diskGb: number;
  tags: Record<string, string>;  // fuel-code:remote-env-id, fuel-code:workspace, etc.
}

export interface LaunchInstanceResult {
  instanceId: string;
  launchTime: Date;
}

export class FuelCodeEc2Client {
  constructor(opts: Ec2ClientOptions);

  // Launch a single EC2 instance with the given params
  // Retries on transient AWS errors (3 attempts, exponential backoff)
  async launchInstance(params: LaunchInstanceParams): Promise<LaunchInstanceResult>;

  // Terminate an EC2 instance by instance ID
  // Idempotent: does not error if instance is already terminated
  async terminateInstance(instanceId: string): Promise<void>;

  // Get instance details (state, public IP, launch time)
  async describeInstance(instanceId: string): Promise<InstanceDescription | null>;

  // Create or get the fuel-code security group
  // Returns the security group ID
  // If the group already exists, returns the existing ID
  async ensureSecurityGroup(vpcId?: string): Promise<string>;

  // Update the security group to allow SSH from a specific IP
  // Revokes previous SSH rules and adds the new one
  async updateSecurityGroupIngress(securityGroupId: string, callerIp: string): Promise<void>;

  // Look up the latest Amazon Linux 2023 AMI ID for the configured region
  async getLatestAmiId(): Promise<string>;
}
```

**AMI lookup**: Use `DescribeImages` with filters for Amazon Linux 2023, x86_64, gp3. Cache the result for the lifetime of the client instance (AMIs don't change frequently).

**Security group management**:
- Group name: `fuel-code-remote`
- Description: `SSH access for fuel-code remote dev environments`
- Inbound rules: TCP port 22 from caller's IP (`{ip}/32`)
- On `updateSecurityGroupIngress`: revoke all existing SSH rules, then authorize the new IP. This ensures only the current IP has access.
- Outbound: default allow-all (AWS default for new SGs).

**SSH Key Manager: `packages/server/src/aws/ssh-key-manager.ts`**

```typescript
export interface SshKeyPair {
  privateKey: string;    // PEM-encoded ed25519 private key
  publicKey: string;     // OpenSSH format public key
}

export class SshKeyManager {
  constructor(private s3Client: FuelCodeS3Client);

  // Generate an ephemeral ed25519 SSH key pair
  // Uses ssh-keygen via child_process (no npm crypto deps)
  async generateKeyPair(): Promise<SshKeyPair>;

  // Upload key pair to S3 at ssh-keys/{remoteEnvId}/id_ed25519[.pub]
  async uploadKeyPair(remoteEnvId: string, keyPair: SshKeyPair): Promise<string>;  // returns S3 key prefix

  // Download private key from S3
  async downloadPrivateKey(remoteEnvId: string): Promise<string>;

  // Delete key pair from S3 (called on termination)
  async deleteKeyPair(remoteEnvId: string): Promise<void>;
}
```

**Key generation**: Shell out to `ssh-keygen -t ed25519 -f <tmpfile> -N "" -q`. Read the generated files. Delete temp files. This avoids npm crypto library dependencies and produces standard OpenSSH format keys.

**Caller IP detection**: For `updateSecurityGroupIngress`, the caller's public IP is needed. Use a lightweight HTTP call to `https://checkip.amazonaws.com/` (returns plain text IP). Cache for the duration of the provisioning operation.

**Files to Create**
- `packages/server/src/aws/ec2-client.ts`
- `packages/server/src/aws/ssh-key-manager.ts`
- `packages/server/src/aws/__tests__/ec2-client.test.ts`
- `packages/server/src/aws/__tests__/ssh-key-manager.test.ts`

**Files to Modify**
- `packages/server/src/aws/index.ts` -- export new modules
- `packages/server/package.json` -- add `@aws-sdk/client-ec2` dependency

**Tests**

`ec2-client.test.ts` (mock AWS SDK):
1. `launchInstance` sends correct RunInstances command with params.
2. `launchInstance` retries on transient AWS error (RequestLimitExceeded), succeeds on retry.
3. `launchInstance` throws after 3 failed retries.
4. `terminateInstance` sends TerminateInstances command.
5. `terminateInstance` is idempotent (no error if already terminated).
6. `describeInstance` returns instance details.
7. `describeInstance` returns null for unknown instance.
8. `ensureSecurityGroup` creates group if it does not exist.
9. `ensureSecurityGroup` returns existing group ID if it already exists.
10. `updateSecurityGroupIngress` revokes old rules and authorizes new IP.
11. `getLatestAmiId` returns an AMI ID from DescribeImages.
12. Tags are applied correctly on launch.
13. User-data is base64-encoded correctly.

`ssh-key-manager.test.ts`:
1. `generateKeyPair` produces valid ed25519 key pair.
2. `uploadKeyPair` uploads both files to correct S3 paths.
3. `downloadPrivateKey` retrieves the private key from S3.
4. `deleteKeyPair` deletes both files from S3.
5. Key paths follow the pattern `ssh-keys/{remoteEnvId}/id_ed25519[.pub]`.

**Success Criteria**
1. EC2 client correctly launches instances with tags, user-data, and security groups.
2. Retry logic handles transient AWS errors with exponential backoff.
3. Security group is created once and reused across environments.
4. Security group ingress is updated to caller's current IP.
5. AMI lookup finds the latest Amazon Linux 2023 AMI.
6. SSH keys are ed25519, generated via system ssh-keygen.
7. Keys are stored in S3 at the correct paths and retrievable.
8. Key cleanup on termination deletes both private and public keys.
9. All AWS calls are logged via pino for debugging.

---

### Task 5: User-Data Script + Dockerfile.remote

**Parallel Group: A**

**Description**

Create the EC2 user-data bootstrap script and the default Docker image for remote dev environments. The user-data script runs on first boot of the EC2 instance: it installs Docker, pulls the container image, starts the container with the project cloned inside, installs fuel-code and hooks, and calls back to the server when ready. The Dockerfile provides a base image with common dev tools pre-installed.

**User-Data Script: `infra/docker/scripts/user-data.sh`**

This is a bash script template with placeholder variables that the provisioning orchestrator (Task 6) substitutes at launch time. The script runs as root on the EC2 instance.

```bash
#!/bin/bash
set -euo pipefail

# ============================================================
# fuel-code remote environment bootstrap script
# This runs on EC2 first boot via user-data
# Variables substituted at provisioning time:
#   __REMOTE_ENV_ID__     - ULID of the remote environment
#   __DOCKER_IMAGE__      - Docker base image from blueprint
#   __GIT_REMOTE__        - Git repo URL to clone
#   __GIT_BRANCH__        - Branch to checkout
#   __SETUP_COMMANDS__    - Newline-separated setup commands from blueprint
#   __ENVIRONMENT__       - Newline-separated KEY=VALUE pairs
#   __PORTS__             - Space-separated port numbers for Docker -p flags
#   __BACKEND_URL__       - fuel-code backend URL
#   __API_KEY__           - fuel-code API key for event reporting
#   __ANTHROPIC_API_KEY__ - Anthropic API key for Claude Code
#   __SSH_PUBLIC_KEY__    - Public SSH key to authorize
#   __SYSTEM_DEPS__       - Space-separated apt packages to install in container
#   __DISK_GB__           - Disk size (for reference, already set on EBS)
# ============================================================

# Step 1: Install Docker
yum update -y
yum install -y docker git
systemctl start docker
systemctl enable docker

# Step 2: Configure SSH with the ephemeral public key
mkdir -p /home/ec2-user/.ssh
echo "__SSH_PUBLIC_KEY__" >> /home/ec2-user/.ssh/authorized_keys
chmod 600 /home/ec2-user/.ssh/authorized_keys
chown -R ec2-user:ec2-user /home/ec2-user/.ssh

# Step 3: Pull Docker image
docker pull __DOCKER_IMAGE__

# Step 4: Build port mapping flags
PORT_FLAGS=""
for port in __PORTS__; do
  PORT_FLAGS="$PORT_FLAGS -p $port:$port"
done

# Step 5: Build environment variable flags
ENV_FLAGS="-e ANTHROPIC_API_KEY=__ANTHROPIC_API_KEY__"
ENV_FLAGS="$ENV_FLAGS -e FUEL_CODE_BACKEND_URL=__BACKEND_URL__"
ENV_FLAGS="$ENV_FLAGS -e FUEL_CODE_API_KEY=__API_KEY__"
ENV_FLAGS="$ENV_FLAGS -e FUEL_CODE_REMOTE_ENV_ID=__REMOTE_ENV_ID__"
# Add blueprint environment variables
__ENVIRONMENT_FLAGS__

# Step 6: Start container
docker run -d --name fuel-code-remote \
  $PORT_FLAGS \
  $ENV_FLAGS \
  -v /home/ec2-user/.ssh:/root/.ssh:ro \
  __DOCKER_IMAGE__ \
  tail -f /dev/null  # Keep container running

# Step 7: Inside container — clone repo, setup, install fuel-code
docker exec fuel-code-remote bash -c '
  set -euo pipefail

  # Install system dependencies
  apt-get update && apt-get install -y __SYSTEM_DEPS__ openssh-server curl git

  # Clone repo
  git clone __GIT_REMOTE__ /workspace
  cd /workspace
  git checkout __GIT_BRANCH__

  # Run setup commands from blueprint
  __SETUP_COMMANDS__

  # Install fuel-code CLI
  curl -fsSL https://raw.githubusercontent.com/user/fuel-code/main/install.sh | bash
  # Or: npm install -g fuel-code / bun install -g fuel-code (depending on distribution method)

  # Initialize fuel-code on this remote device
  fuel-code init --device-type remote --device-name "remote-__REMOTE_ENV_ID__" \
    --backend-url "$FUEL_CODE_BACKEND_URL" --api-key "$FUEL_CODE_API_KEY"

  # Install Claude Code
  # (This assumes Claude Code is installable via npm/bun)
  npm install -g @anthropic-ai/claude-code || true

  # Install CC hooks + git hooks
  fuel-code hooks install

  # Health check
  claude --version || echo "WARNING: Claude Code not available"
'

# Step 8: Get container IP and callback to backend
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
DEVICE_ID=$(docker exec fuel-code-remote cat /root/.fuel-code/config.yaml | grep 'id:' | head -1 | awk '{print $2}')

# Callback to backend: POST /api/remote/:id/ready
curl -s -X POST "__BACKEND_URL__/api/remote/__REMOTE_ENV_ID__/ready" \
  -H "Authorization: Bearer __API_KEY__" \
  -H "Content-Type: application/json" \
  -d "{
    \"instance_id\": \"$INSTANCE_ID\",
    \"public_ip\": \"$PUBLIC_IP\",
    \"ssh_port\": 22,
    \"device_id\": \"$DEVICE_ID\"
  }"

echo "fuel-code remote environment ready"
```

**Error handling in user-data**: If any step fails (Docker pull, git clone, etc.), the script should catch the error and call back with a failure status:

```bash
# At the top of the script, set a trap for errors
trap 'on_error' ERR

on_error() {
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "unknown")
  curl -s -X POST "__BACKEND_URL__/api/remote/__REMOTE_ENV_ID__/ready" \
    -H "Authorization: Bearer __API_KEY__" \
    -H "Content-Type: application/json" \
    -d "{\"instance_id\": \"$INSTANCE_ID\", \"public_ip\": \"$PUBLIC_IP\", \"ssh_port\": 22, \"device_id\": \"\", \"error\": \"Bootstrap failed at line $LINENO\"}" \
    || true
  exit 1
}
```

The `/api/remote/:id/ready` endpoint (Task 3) should handle the error case: if the body contains an `error` field, set status to `error` instead of `ready`.

**Dockerfile.remote: `infra/docker/Dockerfile.remote`**

This is a reference Dockerfile, not the one used directly. The actual image comes from the blueprint's `docker.base_image`. This Dockerfile shows what a "batteries-included" base image looks like for fuel-code remote:

```dockerfile
# Base image for fuel-code remote dev environments
# This is a reference/template — actual base image comes from the blueprint
FROM node:22-bookworm

# Common dev tools
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    vim \
    jq \
    openssh-server \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Working directory for cloned repos
WORKDIR /workspace

# Keep container running (overridden by user-data script)
CMD ["tail", "-f", "/dev/null"]
```

**Template rendering utility: `packages/server/src/aws/user-data-renderer.ts`**

```typescript
export interface UserDataParams {
  remoteEnvId: string;
  dockerImage: string;
  gitRemote: string;
  gitBranch: string;
  setupCommands: string[];
  environment: Record<string, string>;
  ports: number[];
  backendUrl: string;
  apiKey: string;
  anthropicApiKey: string;
  sshPublicKey: string;
  systemDeps: string[];
}

// Reads the user-data.sh template and substitutes variables
// Returns the rendered script as a string (ready for base64 encoding)
export function renderUserData(params: UserDataParams): string;
```

The renderer reads `infra/docker/scripts/user-data.sh`, replaces all `__PLACEHOLDER__` strings with actual values, and returns the result. Setup commands are joined with `\n`. Environment variables become `-e KEY=VALUE` flags. Ports become individual `-p` flags.

**Files to Create**
- `infra/docker/scripts/user-data.sh` (replace placeholder)
- `infra/docker/Dockerfile.remote` (replace placeholder)
- `packages/server/src/aws/user-data-renderer.ts`
- `packages/server/src/aws/__tests__/user-data-renderer.test.ts`

**Tests**

`user-data-renderer.test.ts`:
1. Renders template with all variables substituted.
2. Setup commands are joined with newlines and indented correctly.
3. Port flags are generated correctly for multiple ports.
4. Environment variables are rendered as Docker `-e` flags.
5. System deps are space-separated in the apt-get install command.
6. Special characters in values (quotes, backslashes) are escaped correctly.
7. Empty setup commands produce no setup section.
8. Empty ports produce no port flags.
9. Git branch with slashes (feature/my-branch) is handled correctly.
10. The rendered script is valid bash (no syntax errors from substitution).

**Success Criteria**
1. User-data script installs Docker, pulls the image, and starts the container.
2. Container has the repo cloned at `/workspace` on the correct branch.
3. Setup commands from the blueprint are executed inside the container.
4. fuel-code is installed and initialized with `device_type=remote`.
5. CC hooks and git hooks are installed on the remote.
6. The script calls back to the backend on success with instance metadata.
7. The script calls back with error details on failure (any step).
8. SSH access is configured with the ephemeral public key.
9. Template renderer correctly substitutes all variables.
10. Dockerfile.remote provides a usable reference base image.
11. Port mappings and environment variables are passed through correctly.

---

### Task 6: `fuel-code remote up` Command (Provisioning Orchestrator)

**Parallel Group: C**

**Description**

Implement the `fuel-code remote up` command -- the main user-facing command for provisioning a remote dev environment. This command orchestrates the entire provisioning flow: load/detect blueprint, call the server to create the remote env record, generate and upload SSH keys, launch EC2, and poll for readiness. It then optionally connects via SSH.

**Command Flow**:

```
$ fuel-code remote up

1. Load or detect blueprint
   ├── Check for .fuel-code/env.yaml
   ├── If missing: run blueprint detection, show result, ask to proceed
   └── Parse and validate blueprint

2. Resolve workspace
   ├── Get git remote URL from current directory
   └── Compute canonical workspace ID

3. Call POST /api/remote
   ├── Send: workspace_id, blueprint, git_remote, git_branch
   └── Receive: remote_env_id, status=provisioning

4. Server-side provisioning (triggered by POST /api/remote):
   ├── Generate SSH key pair
   ├── Upload keys to S3
   ├── Ensure security group exists
   ├── Update security group with caller's IP
   ├── Look up latest AMI
   ├── Render user-data script
   ├── Launch EC2 instance
   ├── Tag instance
   └── Emit remote.provision.start event

5. CLI polls GET /api/remote/:id every 5 seconds
   ├── Show spinner: "Provisioning... (instance launching)"
   ├── Show spinner: "Provisioning... (installing dependencies)"
   ├── On status=ready: "Environment ready!"
   ├── On status=error: "Provisioning failed: <error message>"
   └── Timeout after 10 minutes: "Provisioning timed out"

6. On ready:
   ├── Print environment details (IP, instance type, cost estimate)
   ├── Ask: "Connect now? (Y/n)"
   └── If yes: download SSH key, SSH in (same as `remote ssh`)
```

**CLI Output** (during provisioning):

```
fuel-code remote up

Blueprint: node:22 / bun / t3.xlarge / us-east-1
Workspace: fuel-code (github.com/user/fuel-code)
Branch:    main

Provisioning remote environment...
  [1/5] Creating environment record       ✓
  [2/5] Generating SSH key pair            ✓
  [3/5] Configuring security group         ✓
  [4/5] Launching EC2 instance             ✓  (i-0abc123def456)
  [5/5] Waiting for environment ready      ⠋ 45s elapsed

Remote environment ready!

  ID:        01JMF3ABC...
  Instance:  i-0abc123def456 (t3.xlarge)
  IP:        54.123.45.67
  Region:    us-east-1
  Cost:      ~$0.166/hr
  TTL:       8h (auto-terminate at 6:23 PM)
  Idle:      60m timeout

Connect now? (Y/n) _
```

**Options**:
- `--repo <url>`: Provision for a specific repo URL (instead of current directory)
- `--branch <name>`: Use a specific branch (default: current branch)
- `--instance-type <type>`: Override blueprint's instance type
- `--region <region>`: Override blueprint's region
- `--ttl <minutes>`: Override default TTL (default: 480 = 8 hours)
- `--idle-timeout <minutes>`: Override idle timeout (default: 60)
- `--no-connect`: Don't prompt to connect after provisioning
- `--json`: Output JSON instead of interactive display

**Server-side provisioning orchestration**:

The actual EC2 provisioning happens server-side (in a handler called by the POST /api/remote endpoint). This is important because:
1. The server has AWS credentials configured.
2. The server stores SSH keys in S3.
3. The server can update the remote_envs row as provisioning progresses.
4. The callback from EC2 goes to the server.

Create `packages/server/src/services/remote-provisioner.ts`:

```typescript
export class RemoteProvisioner {
  constructor(
    private ec2Client: FuelCodeEc2Client,
    private sshKeyManager: SshKeyManager,
    private s3Client: FuelCodeS3Client,
    private db: postgres.Sql,
    private userDataRenderer: typeof renderUserData,
    private config: { backendUrl: string; apiKey: string; anthropicApiKey: string },
    private broadcaster: WsBroadcaster,
  );

  // Called by POST /api/remote handler after creating the remote_envs row
  // Runs asynchronously (does not block the HTTP response)
  async provision(remoteEnvId: string, params: ProvisionParams): Promise<void>;
}
```

The `provision()` method:
1. Generate SSH key pair.
2. Upload to S3.
3. Ensure security group, update ingress with caller IP.
4. Get latest AMI.
5. Render user-data script.
6. Launch EC2 instance.
7. Update `remote_envs` row with `instance_id`.
8. Tag EC2 instance with `fuel-code:remote-env-id`, `fuel-code:workspace`, `Name`.
9. Emit `remote.provision.start` event.
10. On any error: update `remote_envs` to status=`error` with error details, emit `remote.provision.error` event.

**Caller IP detection**: The server gets the caller's IP from the HTTP request (`req.ip` or `x-forwarded-for` header). This IP is used for the security group.

**Files to Create**
- `packages/cli/src/commands/remote-up.ts` (replace placeholder)
- `packages/server/src/services/remote-provisioner.ts`
- `packages/cli/src/commands/__tests__/remote-up.test.ts`
- `packages/server/src/services/__tests__/remote-provisioner.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` -- register `remote up` command
- `packages/server/src/routes/remote.ts` -- wire provisioner into POST /api/remote handler

**Tests**

`remote-up.test.ts` (CLI):
1. With existing env.yaml: loads blueprint and proceeds.
2. Without env.yaml: runs detection, shows result, asks to proceed.
3. `--no-connect`: skips the connect prompt.
4. `--instance-type t3.medium`: overrides blueprint's instance type.
5. `--json`: outputs JSON status updates.
6. Polling shows progress spinner with elapsed time.
7. On ready status: displays environment details.
8. On error status: displays error message and exits 1.
9. On timeout (10 min): displays timeout message and exits 1.
10. Ctrl-C during provisioning: asks if user wants to terminate the environment.

`remote-provisioner.test.ts` (server, mocked AWS):
1. Full provision flow: generates keys, uploads to S3, creates SG, launches EC2.
2. Updates remote_envs row with instance_id after launch.
3. Tags EC2 instance with correct tags.
4. On EC2 launch failure: sets status=error, emits error event.
5. On S3 upload failure: sets status=error, does not launch EC2.
6. On SG creation failure: sets status=error.
7. User-data script is rendered with correct variables.
8. Caller IP is used for security group ingress.
9. Emits `remote.provision.start` event.
10. Broadcasts `remote.update` via WebSocket.

**Success Criteria**
1. `fuel-code remote up` provisions a complete remote environment from blueprint.
2. User sees step-by-step progress with spinners and elapsed time.
3. On success: environment details are displayed (ID, IP, cost, TTL).
4. On failure: clear error message with the specific step that failed.
5. Blueprint overrides (--instance-type, --region, --ttl) work correctly.
6. Server-side provisioning creates SSH keys, security group, and EC2 instance.
7. EC2 instance is tagged for identification and cleanup.
8. Remote env record is updated with instance_id on EC2 launch.
9. WebSocket broadcasts provisioning status changes.
10. The user can optionally connect immediately after provisioning.

---

### Task 7: `fuel-code remote ssh` Command

**Parallel Group: D**

**Description**

Implement the `fuel-code remote ssh` command that connects the user to an existing remote environment via SSH. The command downloads the ephemeral private key from the server, writes it to a temporary file, shells out to the system `ssh` binary, and cleans up the temp key on exit.

**Command Flow**:

```
$ fuel-code remote ssh <id>

1. Resolve remote env ID
   ├── If <id> is a full ULID: use directly
   ├── If <id> is a prefix: find matching remote env from GET /api/remote
   └── If no <id> provided and only one active remote: use that one

2. Fetch remote env detail
   ├── GET /api/remote/:id
   ├── Check status is "ready" or "active"
   └── If not ready: "Environment is not ready (status: provisioning). Wait or check `fuel-code remote ls`."

3. Download SSH key
   ├── GET /api/remote/:id/ssh-key
   ├── Write to temp file with 0600 permissions
   └── Path: /tmp/fuel-code-ssh-{remoteEnvId}

4. Connect via SSH
   ├── Spawn: ssh -i <keyfile> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ec2-user@<public_ip>
   ├── stdio: 'inherit' (user gets a full terminal)
   └── Optional: ssh -t ec2-user@<ip> "docker exec -it fuel-code-remote bash"
        (to land directly in the container)

5. Cleanup on exit
   ├── Delete temp key file
   └── Print "Disconnected from remote environment <id>"
```

**Container access**: The SSH connection lands on the EC2 host. The user's code is inside the Docker container. Two approaches:
- **Option A**: SSH into EC2, then `docker exec -it fuel-code-remote bash -c "cd /workspace && exec bash"`. This can be done as a single SSH command: `ssh ... ec2-user@ip "docker exec -it fuel-code-remote bash"`.
- **Option B**: Configure SSH inside the container (sshd in container, forwarded port). More complex but gives a true SSH session inside the container.

Go with **Option A** (simpler, no sshd in container). The SSH command becomes:
```bash
ssh -i <keyfile> -t -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    ec2-user@<public_ip> \
    "docker exec -it fuel-code-remote bash -c 'cd /workspace && exec bash -l'"
```

The `-t` flag forces pseudo-terminal allocation so `docker exec -it` works correctly.

**ID resolution shorthand**: If there's only one active remote environment (status in [ready, active, idle]), `fuel-code remote ssh` (no argument) connects to it. If there are multiple, list them and ask the user to specify.

**Options**:
- `--port <port>`: Forward a port (`-L <port>:localhost:<port>`)
- `--command <cmd>`: Run a command instead of interactive shell

**Files to Create**
- `packages/cli/src/commands/remote-ssh.ts` (replace placeholder)
- `packages/cli/src/commands/__tests__/remote-ssh.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` -- register `remote ssh` command

**Tests**

`remote-ssh.test.ts`:
1. With valid remote env ID: downloads key, spawns SSH with correct args.
2. SSH command includes `-t`, `StrictHostKeyChecking=no`, correct user and IP.
3. SSH command execs into Docker container with `cd /workspace`.
4. Temp key file is created with 0600 permissions.
5. Temp key file is deleted after SSH exits (both success and error).
6. No argument with one active remote: auto-selects it.
7. No argument with multiple actives: lists them and exits with error.
8. No argument with zero actives: prints "No active remote environments".
9. Remote env not ready (status=provisioning): prints status message.
10. Remote env terminated: prints "Environment has been terminated".
11. SSH key download failure: clear error message.
12. `--port 3000`: adds `-L 3000:localhost:3000` to SSH command.
13. `--command "ls"`: runs command instead of interactive bash.
14. ID prefix matching: `fuel-code remote ssh 01JM` matches full ID.

**Success Criteria**
1. `fuel-code remote ssh <id>` connects to the remote environment's Docker container.
2. User lands in `/workspace` inside the container with a bash shell.
3. The SSH key is downloaded, used, and cleaned up securely.
4. Temp key file has 0600 permissions (not world-readable).
5. ID resolution supports full IDs, prefixes, and auto-selection.
6. Clear error messages for non-ready, terminated, and unknown environments.
7. Port forwarding works with `--port` flag.
8. The SSH session inherits the terminal (full interactive use).
9. Cleanup runs even if SSH exits with an error.

---

### Task 8: `fuel-code remote ls` + `fuel-code remote down` Commands

**Parallel Group: D**

**Description**

Implement two related commands: `fuel-code remote ls` (list all remote environments) and `fuel-code remote down` (terminate one or all remote environments).

**Command: `fuel-code remote ls`**

```
$ fuel-code remote ls

ID               WORKSPACE      STATUS    INSTANCE       IP              UPTIME    COST     IDLE
01JMF3ABC...     fuel-code      ready     i-0abc123...   54.123.45.67    2h15m     $0.37    12m
01JMF4DEF...     api-service    active    i-0def456...   54.234.56.78    45m       $0.12    0m (live session)

2 remote environments ($0.49 total)
```

- Calls `GET /api/remote` via ApiClient.
- Shows all non-terminated environments by default.
- `--all` flag includes terminated environments.
- `--json` outputs JSON.
- Columns: ID (truncated), workspace name (resolved from workspace_id), status, instance ID (truncated), public IP, uptime (since provisioned_at), estimated cost (uptime * cost_per_hour), idle time (since last event from that device).
- Color coding: `ready` = green, `active` = bright green, `idle` = yellow, `provisioning` = dim, `error` = red, `terminated` = dim strikethrough.
- Footer: count of environments and total cost.

**Command: `fuel-code remote down <id>`**

```
$ fuel-code remote down 01JMF3ABC

Terminating remote environment 01JMF3ABC... (fuel-code)
  Instance: i-0abc123def456 (t3.xlarge, us-east-1)
  Uptime:   2h15m
  Cost:     ~$0.37

Are you sure? (y/N) y

Terminated. EC2 instance shutting down.
SSH keys deleted.
```

- Calls `POST /api/remote/:id/terminate` via ApiClient.
- Shows environment details and asks for confirmation before terminating.
- `--force` flag skips confirmation.
- `--all` flag terminates ALL active environments (with confirmation: "Terminate all 3 remote environments? (y/N)").

**Command: `fuel-code remote status <id>`**

A convenience alias that shows detailed status for a single environment. Essentially `fuel-code remote ls` filtered to one ID with more detail.

```
$ fuel-code remote status 01JMF3ABC

Remote Environment: 01JMF3ABC...
  Workspace: fuel-code (github.com/user/fuel-code)
  Status:    ready (since 2h15m ago)
  Instance:  i-0abc123def456 (t3.xlarge)
  Region:    us-east-1
  IP:        54.123.45.67
  Cost:      ~$0.37 ($0.166/hr)
  TTL:       8h (auto-terminate at 6:23 PM)
  Idle:      12m (timeout at 60m)

  Blueprint: node:22 / bun / 50GB
  Branch:    main

  Sessions on this device: 3
    ✓ DONE   45m  $0.42  "Implemented pagination"
    ✓ DONE   1h2m $0.87  "Refactored query layer"
    ● LIVE   12m  $0.18  "Fixing edge case in..."
```

**Files to Create**
- `packages/cli/src/commands/remote-ls.ts` (replace placeholder)
- `packages/cli/src/commands/remote-down.ts` (replace placeholder)
- `packages/cli/src/commands/__tests__/remote-ls.test.ts`
- `packages/cli/src/commands/__tests__/remote-down.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` -- register `remote ls`, `remote down`, `remote status` commands

**Tests**

`remote-ls.test.ts`:
1. Lists all non-terminated environments in table format.
2. `--all` includes terminated environments.
3. `--json` outputs JSON array.
4. Empty list: "No remote environments found."
5. Status colors: ready=green, active=bright green, idle=yellow, error=red.
6. Uptime calculated correctly from provisioned_at.
7. Cost calculated as uptime_hours * cost_per_hour.
8. Footer shows count and total cost.
9. `remote status <id>` shows detailed single-environment view.

`remote-down.test.ts`:
1. With valid ID: shows details, asks confirmation, terminates on "y".
2. Confirmation declined ("n"): does not terminate, exits 0.
3. `--force`: skips confirmation.
4. `--all`: terminates all active environments (with confirmation).
5. `--all --force`: terminates all without confirmation.
6. Unknown ID: prints "Remote environment not found."
7. Already terminated: prints "Environment already terminated."
8. Termination failure: prints error from server.
9. ID prefix matching works.

**Success Criteria**
1. `fuel-code remote ls` lists all active remote environments with accurate stats.
2. Table includes workspace name, status, IP, uptime, cost, and idle time.
3. Status is color-coded for quick visual scanning.
4. `fuel-code remote down <id>` terminates with confirmation prompt.
5. `--force` skips confirmation for scripting use.
6. `--all` terminates all environments (with safety confirmation).
7. `fuel-code remote status <id>` shows detailed environment info including session history.
8. ID prefix matching provides convenience for long ULIDs.
9. Error cases (not found, already terminated) have clear messages.

---

### Task 9: Remote Event Handlers + Idle/TTL Auto-Termination

**Parallel Group: D**

**Description**

Add event handlers for the four remote event types (`remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, `remote.terminate`) to the server's event processor handler registry. Also implement the server-side idle timeout and TTL auto-termination checker that periodically scans for environments that should be terminated.

**Remote Event Handlers**: `packages/server/src/pipeline/handlers/remote.ts`

Register four handlers in the handler registry:

1. **`remote.provision.start`**: When this event is processed:
   - Update `remote_envs` row: set metadata with provisioning start details.
   - Broadcast `remote.update` via WebSocket with status=`provisioning`.
   - No other side effects (the row already exists from POST /api/remote).

2. **`remote.provision.ready`**: When the ready callback fires and this event is processed:
   - Update `remote_envs`: status=`ready`, ready_at=now.
   - Update the associated `devices` row: status=`online`.
   - Create `workspace_devices` entry linking the remote device to the workspace.
   - Broadcast `remote.update` via WebSocket with status=`ready` and public_ip.

3. **`remote.provision.error`**: When provisioning fails:
   - Update `remote_envs`: status=`error`, metadata with error details.
   - Broadcast `remote.update` via WebSocket with status=`error`.

4. **`remote.terminate`**: When a remote is terminated:
   - Update `remote_envs`: status=`terminated`, terminated_at=now, termination_reason.
   - Update associated `devices` row: status=`terminated`.
   - Compute and store `total_cost_usd` based on uptime and cost_per_hour.
   - Delete SSH keys from S3.
   - Broadcast `remote.update` via WebSocket with status=`terminated`.

**Idle/TTL Auto-Termination**: `packages/server/src/services/remote-idle-checker.ts`

```typescript
export class RemoteIdleChecker {
  private intervalId: Timer | null = null;

  constructor(
    private db: postgres.Sql,
    private ec2Client: FuelCodeEc2Client,
    private sshKeyManager: SshKeyManager,
    private broadcaster: WsBroadcaster,
    private checkIntervalMs: number = 5 * 60 * 1000,  // 5 minutes
  );

  // Start the periodic check
  start(): void;

  // Stop the periodic check
  stop(): void;

  // Run one check cycle (public for testing)
  async checkAndTerminate(): Promise<{ terminated: string[] }>;
}
```

The `checkAndTerminate()` method:
1. Query: `SELECT * FROM remote_envs WHERE status IN ('ready', 'active', 'idle')`.
2. For each environment:
   a. **TTL check**: If `NOW() > provisioned_at + interval '1 minute' * ttl_minutes`, terminate with reason=`ttl`.
   b. **Idle check**: Query last event from the remote device: `SELECT MAX(timestamp) FROM events WHERE device_id = $1`. If no events in `idle_timeout_minutes`, and status is not already `idle`:
      - First: transition to `idle` status, broadcast `remote.update`.
      - Second (on next check, still idle): terminate with reason=`idle`.
   c. **Termination**: Call `ec2Client.terminateInstance()`, update `remote_envs` row, delete SSH keys, emit `remote.terminate` event.

The two-step idle process (idle -> terminate) gives the user a warning period. The TUI shows `idle 12m` in yellow. If they start a session, the device becomes `active` again (the `session.start` handler updates the device status).

**Session-Device status correlation**: When a `session.start` event arrives from a remote device, update the remote_env status to `active`. When the last active session on a device ends (`session.end`), transition back to `ready` (or `idle` if the idle checker hasn't run yet).

Add this logic to the existing `session.start` and `session.end` handlers:
```typescript
// In session.start handler, after creating session:
if (device.type === 'remote') {
  await sql`UPDATE remote_envs SET status = 'active' WHERE device_id = ${device.id} AND status IN ('ready', 'idle')`;
  // broadcast remote.update
}

// In session.end handler, after updating session:
if (device.type === 'remote') {
  const activeSessions = await sql`SELECT COUNT(*) FROM sessions WHERE device_id = ${device.id} AND lifecycle = 'capturing'`;
  if (activeSessions[0].count === 0) {
    await sql`UPDATE remote_envs SET status = 'ready' WHERE device_id = ${device.id} AND status = 'active'`;
    // broadcast remote.update
  }
}
```

**Files to Create**
- `packages/server/src/pipeline/handlers/remote.ts`
- `packages/server/src/services/remote-idle-checker.ts`
- `packages/server/src/pipeline/handlers/__tests__/remote.test.ts`
- `packages/server/src/services/__tests__/remote-idle-checker.test.ts`

**Files to Modify**
- `packages/server/src/pipeline/consumer.ts` (or handler registry) -- register remote event handlers
- `packages/server/src/pipeline/handlers/session.ts` (or equivalent) -- add remote device status updates to session.start and session.end handlers
- `packages/server/src/index.ts` -- start the idle checker on server boot

**Tests**

`remote.test.ts` (handler tests):
1. `remote.provision.start` handler updates remote_envs metadata.
2. `remote.provision.ready` handler sets status=ready, records public_ip and device_id.
3. `remote.provision.ready` creates workspace_devices entry.
4. `remote.provision.error` handler sets status=error.
5. `remote.terminate` handler sets status=terminated, computes total_cost, deletes SSH keys.
6. All handlers broadcast `remote.update` via WebSocket.
7. Session.start from remote device transitions remote_env to `active`.
8. Session.end (last session) from remote device transitions remote_env back to `ready`.

`remote-idle-checker.test.ts`:
1. TTL exceeded: environment is terminated with reason=ttl.
2. Idle timeout exceeded (no events): environment transitions to idle, then terminated on next check.
3. Active environment (recent events): not terminated.
4. Environment within TTL: not terminated.
5. Multiple environments: each checked independently.
6. EC2 termination is called with correct instance ID.
7. SSH keys are deleted on termination.
8. `remote.terminate` event is emitted.
9. WebSocket broadcast sent on status transitions.
10. Checker start/stop works correctly (interval is created/cleared).
11. Already-terminated environments are skipped.

**Success Criteria**
1. All four remote event types have handlers registered in the handler registry.
2. `remote.provision.ready` correctly transitions status and creates device associations.
3. `remote.terminate` handler computes cost, deletes keys, and updates status.
4. Idle checker runs every 5 minutes and terminates stale environments.
5. TTL auto-termination works correctly (default 8 hours).
6. Idle detection uses a two-step process (idle -> terminate) for user warning.
7. Session start/end on remote devices correctly updates remote_env status.
8. All status transitions broadcast `remote.update` via WebSocket.
9. The idle checker is started on server boot and can be stopped for graceful shutdown.
10. Cost calculation is accurate (uptime_hours * cost_per_hour).

---

### Task 10: TUI Remote Panel + WebSocket remote.update

**Parallel Group: E**

**Description**

Add a "REMOTES" section to the TUI dashboard sidebar showing active remote environments, and wire up WebSocket `remote.update` events for live status changes. Also add the `remote.update` handling to the WsClient so the TUI and live mode reflect remote environment state changes in real-time.

**TUI Dashboard Changes**: `packages/cli/src/tui/Dashboard.tsx`

Add a "REMOTES" section below the workspace list in the left sidebar:

```
REMOTES
───────
● fuel-code
  t3.xl $0.42
  idle 12m

● api-service
  t3.xl $0.12
  active (live session)
```

Each remote entry shows:
- Status indicator: green dot for ready/active, yellow dot for idle, dim dot for provisioning, red dot for error.
- Workspace name.
- Instance type (abbreviated) and running cost.
- Status detail: "idle 12m", "active (live session)", "provisioning...", "error: <msg>".

**TUI Component: `packages/cli/src/tui/components/RemotePanel.tsx`**

```tsx
interface RemotePanelProps {
  remotes: RemoteEnv[];
  onSelect?: (id: string) => void;  // future: drill into remote detail
}

// Renders the REMOTES sidebar section
// Updates in real-time via WsClient remote.update events
```

**WebSocket Integration**:

The WsClient (from Phase 4) already defines the `remote.update` event type in its protocol. Wire it up:

1. In `WsClient`: handle incoming `{ type: "remote.update", ... }` messages, emit as `remote.update` events.
2. In `Dashboard.tsx`: listen for `remote.update` events and update the remotes list:
   - On status change to `ready`: add to list (or update existing).
   - On status change to `terminated`: remove from list (or gray out).
   - On status change to `active`/`idle`: update status display.
3. Initial data: fetch remotes via `GET /api/remote?status=ready,active,idle,provisioning` on dashboard mount.

**API Client Extension**:

The `getRemoteEnvs()` method on `ApiClient` (added in Task 3) is used here to fetch initial data. No new API methods needed.

**Files to Create**
- `packages/cli/src/tui/components/RemotePanel.tsx`
- `packages/cli/src/tui/components/__tests__/RemotePanel.test.tsx`

**Files to Modify**
- `packages/cli/src/tui/Dashboard.tsx` -- add RemotePanel to sidebar, fetch remotes on mount, handle remote.update events
- `packages/cli/src/lib/ws-client.ts` -- ensure `remote.update` events are emitted (may already be handled if generic event handling exists)

**Tests**

`RemotePanel.test.tsx` (ink-testing-library):
1. Renders list of remote environments with status indicators.
2. Ready remote: green dot, workspace name, cost.
3. Active remote (live session): bright green, "active" label.
4. Idle remote: yellow dot, idle duration.
5. Provisioning remote: dim, "provisioning..." spinner.
6. Error remote: red dot, error message.
7. Empty list: section hidden or "No remote environments".
8. WebSocket `remote.update` adds new remote to list.
9. WebSocket `remote.update` removes terminated remote.
10. WebSocket `remote.update` changes status (ready -> active).

**Success Criteria**
1. TUI dashboard sidebar shows a REMOTES section below workspaces.
2. Active/ready/idle remote environments are listed with status indicators.
3. Status changes via WebSocket are reflected in real-time (no manual refresh needed).
4. Provisioning remotes show a spinner or progress indication.
5. Terminated remotes are removed from the list.
6. The REMOTES section is hidden when no remote environments exist.
7. Remote panel does not interfere with workspace list navigation.
8. Cost and uptime are displayed accurately.

---

### Task 11: Phase 5 E2E Integration Tests

**Parallel Group: F**

**Description**

End-to-end tests verifying the complete Phase 5 user experience. These tests validate the full flow from blueprint detection through provisioning, SSH, listing, termination, and auto-cleanup. Due to the nature of EC2 provisioning, some tests use mocked AWS clients while the "happy path" test exercises the full flow with mocked AWS responses.

**Test Strategy**:

- **Unit tests** (already covered in individual tasks): Test each component in isolation.
- **Integration tests** (this task): Test the full stack with a real server, real database, and mocked AWS.
- **AWS mocking**: Use a mock EC2 client that simulates instance launch/terminate/describe. Use a mock S3 client (or real S3 with a test bucket). The mock EC2 client returns fake instance IDs and simulates the ready callback after a short delay.

**Test File**: `packages/cli/src/__tests__/e2e-phase5.test.ts`

**Blueprint E2E**:
1. `fuel-code blueprint detect` in a Node.js project -> generates correct env.yaml.
2. `fuel-code blueprint detect` in a Python project -> correct detection.
3. `fuel-code blueprint show` -> displays the generated env.yaml.
4. `fuel-code blueprint validate` with valid env.yaml -> exit 0.
5. `fuel-code blueprint validate` with invalid env.yaml -> exit 1, shows errors.

**Provisioning E2E** (mocked AWS):
6. `fuel-code remote up` with valid blueprint -> creates remote_envs row, triggers provisioning, mock EC2 returns instance ID, mock ready callback fires, CLI shows "ready".
7. Remote env row has correct fields: workspace_id, blueprint JSONB, instance_type, region.
8. SSH keys are generated and uploaded to (mock) S3.
9. Security group is created/reused.
10. EC2 instance is tagged with fuel-code metadata.
11. `remote.provision.start` event is recorded in events table.
12. `remote.provision.ready` event is recorded after callback.

**SSH E2E**:
13. `fuel-code remote ssh <id>` for ready env -> downloads key, constructs correct SSH command args.
14. SSH command targets correct IP and uses correct key path.
15. Key file is cleaned up after SSH exits.

**List/Down E2E**:
16. `fuel-code remote ls` -> lists the provisioned environment with correct status.
17. `fuel-code remote ls --json` -> valid JSON output.
18. `fuel-code remote down <id> --force` -> terminates, status=terminated.
19. `fuel-code remote down <id>` on terminated env -> clear error message.
20. `remote.terminate` event is recorded in events table.

**Idle/TTL E2E** (with time manipulation):
21. Create remote env with `ttl_minutes=1`, wait or simulate time passage -> auto-terminated.
22. Create remote env with `idle_timeout_minutes=1`, no events -> transitions to idle, then terminated.
23. Active remote (has recent event) -> not terminated by idle checker.

**Event Pipeline E2E**:
24. Events emitted from a "remote device" (simulated) flow through the same pipeline as local events.
25. Session started on remote device -> remote_envs status transitions to `active`.
26. All sessions ended on remote device -> remote_envs status transitions back to `ready`.

**WebSocket E2E**:
27. WS client receives `remote.update` when environment status changes.
28. WS client receives `remote.update` on provisioning ready.
29. WS client receives `remote.update` on termination.

**Error Cases**:
30. EC2 launch fails -> remote_envs status=error, `remote.provision.error` event emitted.
31. Ready callback with error field -> remote_envs status=error.
32. SSH key download fails -> clear CLI error.
33. `remote up` in directory with no git remote -> clear error about workspace resolution.

**Files to Create**
- `packages/cli/src/__tests__/e2e-phase5.test.ts`
- `packages/cli/src/__tests__/fixtures/seed-phase5.ts` -- test data seeding + mock AWS setup
- `packages/server/src/__tests__/fixtures/mock-ec2-client.ts` -- mock EC2 client for testing

**Files to Modify**
- None (test infrastructure from prior phases should be reusable)

**Success Criteria**
1. All blueprint commands produce correct output for Node.js and Python projects.
2. Full provisioning flow works end-to-end with mocked AWS (create -> provision -> ready -> SSH -> terminate).
3. Event pipeline handles remote events correctly (events table, remote_envs updates, WebSocket broadcasts).
4. Idle and TTL auto-termination work with time simulation.
5. Error cases produce clear, actionable messages.
6. Tests are isolated (each test seeds its own data).
7. Tests run in < 90 seconds total (mocked AWS avoids real API calls).
8. The mock EC2 client is reusable for development/testing.
9. All status transitions (provisioning -> ready -> active -> idle -> terminated) are tested.
10. SSH command construction is verified without actually SSH-ing.

---

## Dependencies Added in Phase 5

```bash
# Server
cd packages/server && bun add @aws-sdk/client-ec2

# CLI
cd packages/cli && bun add js-yaml
cd packages/cli && bun add -d @types/js-yaml
```

Note: `@aws-sdk/client-s3` is already installed in the server package. `js-yaml` may already be installed if used elsewhere. Check before adding.

## Summary Statistics

- **Total tasks**: 11
- **Parallel groups**: 6 (A through F)
- **Critical path length**: 6 stages (Tasks 1 -> 2 -> 6 -> 8 -> 10 -> 11)
- **Group A (foundation)**: 4 tasks (blueprint detector, API endpoints, EC2 client, user-data script)
- **Group B (blueprint CLI)**: 1 task
- **Group C (provisioning)**: 1 task (the big orchestrator)
- **Group D (remaining CLI + server)**: 3 tasks (SSH, list/down, event handlers)
- **Group E (TUI)**: 1 task
- **Group F (verification)**: 1 task
- **New files created**: ~25
- **Existing files modified**: ~10
- **New npm dependencies**: 2 (@aws-sdk/client-ec2, js-yaml)
