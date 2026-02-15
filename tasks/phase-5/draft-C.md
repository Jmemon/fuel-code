# Phase 5: Remote Dev Environments — Task Dependency DAG (Draft C: Testing-and-Safety-First)

## Overview

Phase 5 adds disposable remote dev environments — EC2 instances running Docker containers provisioned via the CLI. After Phase 5, users can auto-detect a project's environment requirements, generate a `.fuel-code/env.yaml` blueprint, provision an EC2 instance with Docker, SSH into it, and have events flow back through the same pipeline as local events. Environments auto-terminate on idle timeout or TTL expiry.

**Design philosophy (Draft C)**: Every risky operation has validation and cleanup. The DAG is structured so that lifecycle management (idle timeout, TTL enforcement, orphan cleanup, graceful abort) is not an afterthought bolted on at the end, but woven into the core provisioning flow from the start. AWS operations are fully testable via a mock EC2 client injected at the service boundary. SSH key security is enforced by design: one-time download, S3 deletion on termination, ephemeral per-environment. The critical question this draft answers is not "can we provision an instance?" but "what happens when provisioning fails, the user hits Ctrl-C, the instance goes idle, or the process crashes mid-provision?"

**What Phase 5 delivers**:
- `fuel-code blueprint detect` — auto-detect runtime, deps, Docker image from repo contents
- `fuel-code blueprint show` / `fuel-code blueprint validate` — inspect and validate `.fuel-code/env.yaml`
- `fuel-code remote up` — provision EC2 + Docker from blueprint, with progress TUI and graceful Ctrl-C abort
- `fuel-code remote ssh <id>` — SSH into a running remote environment
- `fuel-code remote ls` — list active remote environments with status, uptime, cost
- `fuel-code remote down <id>` / `fuel-code remote down --all` — terminate environments
- Server-side lifecycle management: idle timeout (60 min default), TTL (8 hour default), orphan detection
- `POST /api/remote`, `GET /api/remote`, `GET /api/remote/:id`, `POST /api/remote/:id/terminate`, `GET /api/remote/:id/ssh-key`, `POST /api/remote/:id/ready` endpoints
- Remote event handlers (`remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, `remote.terminate`)
- User-data script that bootstraps Docker, clones repo, installs fuel-code + Claude Code, and callbacks

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | AWS EC2 Client Wrapper with Mock Boundary | A | -- |
| 2 | SSH Key Lifecycle Manager (Generate, Store, Download, Revoke) | A | -- |
| 3 | Blueprint Detector + env.yaml Schema and Validation | A | -- |
| 4 | Remote Env Database Operations + Migration | A | -- |
| 5 | Remote API Endpoints (CRUD + Ready Callback + SSH Key Download) | B | 1, 2, 4 |
| 6 | Remote Event Handlers (provision.start, provision.ready, provision.error, terminate) | B | 4 |
| 7 | User-Data Script + Dockerfile.remote | B | -- |
| 8 | Provisioning Orchestrator (EC2 Launch + Security Group + Tagging) | C | 1, 2, 4, 5, 7 |
| 9 | Lifecycle Enforcer: Idle Timeout + TTL Auto-Termination | C | 1, 4, 5 |
| 10 | Orphan Detection + Cleanup Sweep | C | 1, 4 |
| 11 | Graceful Abort Handler (Ctrl-C During Provisioning) | D | 1, 8 |
| 12 | Blueprint CLI Commands (detect, show, validate) | D | 3 |
| 13 | `fuel-code remote up` Command (Provision + Progress TUI) | E | 3, 5, 8, 11, 12 |
| 14 | `fuel-code remote ssh` Command | E | 2, 5 |
| 15 | `fuel-code remote ls` + `fuel-code remote down` Commands | E | 5 |
| 16 | WebSocket Broadcast for Remote Status Updates | E | 5, 6 |
| 17 | Phase 5 E2E Integration Tests | F | 9, 10, 13, 14, 15, 16 |

## Dependency Graph

```
Group A ─── Task 1: AWS EC2     Task 2: SSH Key     Task 3: Blueprint     Task 4: Remote DB
            client wrapper      lifecycle mgr       detector + schema     ops + migration
               │   │   │           │   │                │                    │  │  │  │
               │   │   │           │   │                │                    │  │  │  │
        ┌──────┘   │   │     ┌─────┘   │                │               ┌───┘  │  │  └──────┐
        │          │   │     │         │                │               │      │  │          │
        ▼          │   │     ▼         │                │               ▼      │  │          ▼
Group B ─── Task 5: Remote API ◄───────┘                │         Task 6:     │  │    Task 7:
            endpoints (CRUD,                            │         Remote      │  │    user-data
            ready callback,                             │         event       │  │    script +
            SSH key download)                           │         handlers    │  │    Dockerfile
               │  │  │  │  │                            │            │        │  │       │
               │  │  │  │  └────────────────────────┐   │            │        │  │       │
               │  │  │  └───────────┐               │   │            │        │  │       │
               │  │  └──────┐       │               │   │            │        │  │       │
        ┌──────┘  │         │       │               │   │            │        │  │       │
        │         │         │       │               │   │            │        │  │       │
        ▼         │         ▼       ▼               ▼   │            │        │  │       │
Group C ─── Task 8: Prov.   │  Task 9: Lifecycle   Task 10: ◄───────┘  ◄─────┘  │       │
            orchestrator  ◄─┼─ enforcer (idle +    Orphan detection              │       │
            (EC2 launch,    │  TTL auto-term.)     + cleanup sweep               │       │
             SG, tagging) ◄─┼──────────────────────────────────────────────────────       │
               │        ◄───┼─────────────────────────────────────────────────────────────┘
               │            │
        ┌──────┘            │
        │                   │
        ▼                   │
Group D ─── Task 11:        │              Task 12: Blueprint CLI
            Graceful abort  │              (detect, show, validate)
            (Ctrl-C)        │                        │
               │            │                        │
               │    ┌───────┘                        │
               │    │       │                        │
               ▼    ▼       ▼                        ▼
Group E ─── Task 13: remote up    Task 14:     Task 15: remote   Task 16: WS
            (provision + TUI)     remote ssh   ls + remote down  broadcast for
               │                     │              │             remote status
               │                     │              │                │
               └─────────────────────┴──────────────┴────────────────┘
                                     │
                                     ▼
Group F ─── Task 17: Phase 5 E2E Integration Tests
```

## Parallel Groups

- **A**: Tasks 1, 2, 3, 4 (fully independent foundation: AWS wrapper, SSH key manager, blueprint detector, database layer)
- **B**: Tasks 5, 6, 7 (partially independent: API endpoints need Tasks 1+2+4; event handlers need Task 4; user-data script is standalone)
- **C**: Tasks 8, 9, 10 (partially independent: orchestrator needs 1+2+4+5+7; lifecycle enforcer needs 1+4+5; orphan detection needs 1+4)
- **D**: Tasks 11, 12 (independent: abort handler needs 1+8; blueprint CLI needs only 3)
- **E**: Tasks 13, 14, 15, 16 (CLI commands + WS broadcast; all need API endpoints from Task 5; `remote up` also needs orchestrator + abort + blueprint CLI)
- **F**: Task 17 (final verification)

## Critical Path

Task 1 --> Task 5 --> Task 8 --> Task 11 --> Task 13 --> Task 17

(6 sequential stages. The critical path runs through the AWS client, API endpoints, provisioning orchestrator, abort handler, and the `remote up` CLI command. Parallel path Task 3 --> Task 12 --> Task 13 merges at the `remote up` command.)

## Dependency Edges (precise)

- Task 1 --> Tasks 5, 8, 9, 10, 11 (EC2 client wrapper used for all AWS operations)
- Task 2 --> Tasks 5, 8, 14 (SSH key manager used by API endpoints, orchestrator, and SSH command)
- Task 3 --> Task 12 (blueprint detector needed by blueprint CLI commands)
- Task 4 --> Tasks 5, 6, 8, 9, 10 (DB operations needed by API, event handlers, orchestrator, lifecycle, orphan detection)
- Task 5 --> Tasks 8, 9, 13, 14, 15, 16 (API endpoints consumed by orchestrator, enforcer, all CLI commands, WS broadcast)
- Task 6 --> Task 16 (event handlers produce events that WS broadcast reacts to)
- Task 7 --> Task 8 (user-data script is encoded into EC2 launch by orchestrator)
- Task 8 --> Tasks 11, 13 (orchestrator is wrapped by abort handler and called by `remote up`)
- Task 9 --> Task 17 (lifecycle enforcer verified in E2E)
- Task 10 --> Task 17 (orphan detection verified in E2E)
- Task 11 --> Task 13 (`remote up` uses abort handler to wrap provisioning)
- Task 12 --> Task 13 (`remote up` calls blueprint detect if no env.yaml)
- Tasks 9, 10, 13, 14, 15, 16 --> Task 17 (E2E tests verify everything)

## Key Design Decisions

### 1. Mock Boundary at the AWS SDK Level

The `Ec2Client` wrapper (`packages/server/src/aws/ec2-client.ts`) defines a clean interface that both the real `@aws-sdk/client-ec2` implementation and a mock implementation satisfy. All server code depends on the interface, never on the AWS SDK directly. This means:
- Unit tests inject a `MockEc2Client` that records calls and returns canned responses
- Integration tests can use the mock to simulate provisioning flows end-to-end without touching AWS
- The mock can simulate failure modes: `RunInstances` timeout, `TerminateInstances` failure, instance stuck in `pending` state

```typescript
// packages/server/src/aws/ec2-client.ts
export interface Ec2Operations {
  launchInstance(params: LaunchParams): Promise<LaunchResult>;
  terminateInstance(instanceId: string): Promise<void>;
  describeInstance(instanceId: string): Promise<InstanceDescription | null>;
  createSecurityGroup(params: SecurityGroupParams): Promise<string>;  // returns SG ID
  deleteSecurityGroup(sgId: string): Promise<void>;
  authorizeIngress(sgId: string, ip: string, port: number): Promise<void>;
  getCallerIp(): Promise<string>;  // via checkip.amazonaws.com or similar
  describeInstancesByTag(tagKey: string, tagValue: string): Promise<InstanceDescription[]>;
}
```

### 2. SSH Key Security: Ephemeral, One-Time, Cleaned Up

SSH keys are the highest-risk artifact in the system. The design enforces multiple layers of protection:
- Keys are generated fresh for each remote environment (never reused)
- Private key is stored in S3 at `ssh-keys/{remote_env_id}/id_ed25519` with server-side encryption
- The `GET /api/remote/:id/ssh-key` endpoint returns the private key exactly once, then deletes the `ssh_key_downloaded` flag (actually: sets a `ssh_key_downloaded_at` timestamp; subsequent requests return 410 Gone)
- On environment termination, SSH keys are deleted from S3 immediately
- The local copy (written to a temp file for the SSH command) is deleted after the SSH process exits
- S3 lifecycle rule recommended for `ssh-keys/` prefix: auto-delete after 24 hours as a safety net

### 3. Lifecycle Enforcer as a Periodic Server-Side Job

The lifecycle enforcer is a setInterval-based job running inside the Express server process (not a separate worker). Every 60 seconds it:
1. Queries `remote_envs` for environments where `status NOT IN ('terminated', 'error')`
2. For each environment, checks:
   - **TTL**: `provisioned_at + ttl_minutes * 60 * 1000 < now()` --> terminate
   - **Idle timeout**: queries the `events` table for the most recent event from that device. If `last_event_timestamp + idle_timeout_minutes * 60 * 1000 < now()` --> terminate
3. Terminates via the same `terminateRemoteEnv()` function used by the manual `/terminate` endpoint

This is server-side, not daemon-on-remote, per CORE.md's locked-in decision. The server already knows the last event timestamp for every device because events flow through the pipeline.

### 4. Orphan Detection Scans AWS, Not Just the Database

An orphaned instance is one that exists in AWS but has no corresponding `remote_envs` record (or has one marked `terminated` while the instance is still running). This can happen if:
- The server crashes after calling `RunInstances` but before writing to the DB
- A terminate call succeeds in the DB but fails at AWS
- A user manually terminates via AWS console, leaving the DB stale

The orphan detection sweep (also periodic, every 5 minutes):
1. Calls `describeInstancesByTag("fuel-code:managed", "true")` to find all fuel-code-managed EC2 instances
2. Cross-references with `remote_envs` table
3. Instances in AWS with no DB record, or DB status = `terminated` but AWS status != `terminated`: forcibly terminate via AWS API
4. DB records with status != `terminated` but instance not found in AWS: update DB status to `terminated` with reason `orphan-cleanup`
5. Logs every action at `warn` level

### 5. Graceful Ctrl-C During Provisioning

When a user runs `fuel-code remote up` and hits Ctrl-C, the system must not leave an orphaned EC2 instance. The abort handler:
1. Registers a SIGINT handler before provisioning begins
2. If SIGINT fires during provisioning, it sets an `aborting` flag
3. The provisioning orchestrator checks the flag after each step (launch, wait for ready, etc.)
4. On abort: calls `terminateInstance()` if an instance ID exists, deletes the security group, deletes SSH keys from S3, updates the DB record to `terminated` with reason `user-abort`
5. Prints a clear message: "Cleaning up... terminated instance i-xxxxx"
6. If cleanup itself fails, logs the instance ID and tells the user to run `fuel-code remote down <id>` manually

The CLI also registers a `beforeExit` handler as a belt-and-suspenders measure.

### 6. User-Data Script as a Template, Not a Static File

The user-data script (`infra/docker/scripts/user-data.sh`) is a bash template with placeholders replaced at provisioning time:
- `{{DOCKER_IMAGE}}` — from blueprint `docker.base_image`
- `{{REPO_URL}}` — git clone URL
- `{{REPO_BRANCH}}` — git branch to checkout
- `{{SETUP_COMMANDS}}` — from blueprint `setup` array
- `{{ENV_VARS}}` — from blueprint `environment` map
- `{{PORT_MAPPINGS}}` — from blueprint `ports` array
- `{{BACKEND_URL}}` — fuel-code backend URL
- `{{API_KEY}}` — fuel-code API key
- `{{REMOTE_ENV_ID}}` — for the ready callback
- `{{ANTHROPIC_API_KEY}}` — for Claude Code
- `{{SYSTEM_DEPS}}` — from blueprint `system_deps` array

The orchestrator renders the template by replacing these placeholders, then base64-encodes it for the EC2 `UserData` parameter.

### 7. Provisioning Orchestrator as a State Machine

The provisioning flow has multiple steps that can fail independently. The orchestrator tracks its progress through named stages so that cleanup knows exactly what to roll back:

```
INIT --> KEYS_GENERATED --> SG_CREATED --> INSTANCE_LAUNCHED --> WAITING_READY --> DONE
```

On failure at any stage, the orchestrator rolls back everything created so far:
- `INSTANCE_LAUNCHED` but ready callback never arrived: terminate instance, delete SG, delete keys
- `SG_CREATED` but launch failed: delete SG, delete keys
- `KEYS_GENERATED` but SG creation failed: delete keys
- `INIT` failure: nothing to clean up

### 8. Blueprint Detection Uses File-System Scanning, Not Execution

The blueprint detector scans the repository's file structure to infer the runtime environment. It does NOT execute any code (no `npm install`, no `pip install`, no `cargo build`). Detection heuristics:
- `package.json` + `bun.lockb` --> runtime: node, package_manager: bun
- `package.json` + `package-lock.json` --> runtime: node, package_manager: npm
- `package.json` + `yarn.lock` --> runtime: node, package_manager: yarn
- `pyproject.toml` or `requirements.txt` --> runtime: python
- `Cargo.toml` --> runtime: rust
- `go.mod` --> runtime: go
- `Dockerfile` --> use as base, extract FROM image
- Node version from `.nvmrc`, `.node-version`, `package.json engines.node`
- Python version from `pyproject.toml [project] requires-python`, `.python-version`

### 9. Ready Callback is Authenticated and Idempotent

The `POST /api/remote/:id/ready` endpoint is called by the user-data script running on the EC2 instance. It:
- Validates the API key (same auth as all other endpoints)
- Is idempotent: calling it twice for the same remote env is harmless (second call is a no-op if already `ready`)
- Updates `remote_envs.status` from `provisioning` to `ready`, sets `ready_at`, stores `public_ip`
- Emits a `remote.provision.ready` event through the normal pipeline
- Has a timeout: if the callback doesn't arrive within 10 minutes of instance launch, the lifecycle enforcer marks the environment as `error` and terminates it

### 10. Testing Strategy

Every AWS-touching operation is tested through the mock boundary:
- **Unit tests**: Mock `Ec2Operations` interface. Test the orchestrator state machine with simulated failures at each stage. Test cleanup logic. Test lifecycle enforcer with fake timestamps. Test orphan detection with mismatched AWS/DB states.
- **Integration tests**: Mock EC2 client + real Postgres. Test full provisioning flow from API call to DB state transitions. Test ready callback endpoint. Test SSH key download + 410 on second attempt.
- **E2E tests** (Task 17): Mock EC2 client + real server + real CLI commands. Test `remote up` + `remote ls` + `remote ssh` (mocked SSH subprocess) + `remote down`. Test Ctrl-C abort. Test idle timeout termination. Test orphan cleanup.

No tests in this phase actually touch AWS. The mock is comprehensive enough to validate all orchestration logic.

## What Already Exists (from Phases 1-4)

### Server (packages/server/)
- Express app with auth middleware, error handling, pino logging
- Full event pipeline: POST /api/events/ingest --> Redis Stream --> Event processor --> Postgres
- Session CRUD endpoints, timeline, workspace, device endpoints
- WebSocket server for real-time updates (broadcasts events, session updates)
- S3 client (`@aws-sdk/client-s3`) for transcript storage
- Postgres pool (postgres.js), migrations runner
- Handler registry for event types (session.start, session.end, git.*)
- `packages/server/src/aws/` directory may exist for S3 client

### CLI (packages/cli/)
- Commander entry point with all Phase 1-4 commands
- `ApiClient` class (`packages/cli/src/lib/api-client.ts`) for HTTP calls to backend
- `WsClient` class (`packages/cli/src/lib/ws-client.ts`) for WebSocket
- Config management (`~/.fuel-code/config.yaml`) including `aws.region`, `aws.profile`, `remote.*` defaults
- Local event queue with drainer
- Ink-based TUI dashboard with live updates
- Output formatting utilities (`packages/cli/src/lib/format.ts`)
- Error hierarchy (FuelCodeError subclasses), pino logger

### Shared (packages/shared/)
- All types: Event, Session, Workspace, Device, Blueprint, RemoteEnv
- All Zod schemas for event payloads (including `remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, `remote.terminate`)
- Blueprint type and env.yaml schema (may be a placeholder)
- ULID generation, canonical ID normalization

### Core (packages/core/)
- Event processor, transcript parser, summary generator
- Workspace resolver, session manager, git correlator
- `blueprint-detector.ts` may exist as a placeholder

### Infrastructure
- `infra/docker/Dockerfile.remote` -- placeholder
- `infra/docker/scripts/user-data.sh` -- placeholder
- `infra/sql/schema.sql` -- includes `remote_envs` and `blueprints` tables

### Database
- `remote_envs` table exists in schema (provisioning, ready, active, idle, terminated, error statuses)
- `blueprints` table exists in schema
- All indexes for remote_envs already defined

### NOT yet built (Phase 5 creates)
- `packages/server/src/aws/ec2-client.ts` -- EC2 client wrapper with mock interface
- `packages/server/src/aws/ssh-keys.ts` -- SSH key lifecycle manager
- `packages/server/src/routes/remote.ts` -- remote env API endpoints
- `packages/server/src/pipeline/handlers/remote-*.ts` -- remote event handlers
- `packages/server/src/services/provisioner.ts` -- provisioning orchestrator
- `packages/server/src/services/lifecycle-enforcer.ts` -- idle timeout + TTL enforcement
- `packages/server/src/services/orphan-detector.ts` -- orphaned instance cleanup
- `packages/core/src/blueprint-detector.ts` -- actual implementation (not placeholder)
- `packages/cli/src/commands/blueprint.ts` -- blueprint CLI commands
- `packages/cli/src/commands/remote-up.ts` -- remote up command
- `packages/cli/src/commands/remote-ssh.ts` -- remote ssh command
- `packages/cli/src/commands/remote-ls.ts` -- remote ls command
- `packages/cli/src/commands/remote-down.ts` -- remote down command
- `infra/docker/Dockerfile.remote` -- actual implementation
- `infra/docker/scripts/user-data.sh` -- actual implementation

---

# Task Details

---

## Task 1: AWS EC2 Client Wrapper with Mock Boundary

### Parallel Group: A

### Dependencies: None

### Description

Create an EC2 client wrapper that defines a clean `Ec2Operations` interface and provides both a real AWS SDK implementation and a mock implementation for testing. All server-side code that touches EC2 depends on this interface, never on the AWS SDK directly. This is the foundation that makes every subsequent task testable without AWS credentials.

The real implementation wraps `@aws-sdk/client-ec2` v3 commands. The mock implementation records all calls in an array and returns configurable responses, including the ability to simulate failures at specific operations for testing cleanup logic.

The wrapper also includes retry logic with exponential backoff for transient AWS errors (throttling, temporary unavailability) and a caller-IP detection utility (needed for security group ingress rules).

**Relevant Files**:
- Create: `packages/server/src/aws/ec2-client.ts` (interface + real implementation)
- Create: `packages/server/src/aws/__tests__/ec2-client.test.ts`
- Create: `packages/server/src/aws/ec2-mock.ts` (mock implementation for tests)

### Success Criteria
- `Ec2Operations` interface defined with all methods: `launchInstance`, `terminateInstance`, `describeInstance`, `createSecurityGroup`, `deleteSecurityGroup`, `authorizeIngress`, `getCallerIp`, `describeInstancesByTag`
- Real implementation wraps `@aws-sdk/client-ec2` v3 with proper error handling and retry logic
- Mock implementation records all calls, supports configurable responses and injectable failures
- `getCallerIp()` implemented (calls external service or uses AWS metadata)
- Retry logic covers `ThrottlingException`, `RequestLimitExceeded`, `InternalError` with exponential backoff (3 retries, 1s/2s/4s)
- Unit tests verify mock behavior, retry logic (using mock that fails then succeeds), and error mapping
- EC2 tag constants defined: `fuel-code:managed = true`, `fuel-code:remote-env-id = <id>`, `fuel-code:workspace = <canonical_id>`

---

## Task 2: SSH Key Lifecycle Manager (Generate, Store, Download, Revoke)

### Parallel Group: A

### Dependencies: None

### Description

Implement the full SSH key lifecycle: generate an ed25519 key pair, upload both keys to S3, download the private key (one-time), and delete keys on termination. This module enforces the security invariant that private keys are downloadable exactly once and are cleaned up when the environment is destroyed.

Key generation shells out to `ssh-keygen` (system binary, consistent with the locked-in decision to use system `ssh`). S3 storage uses the existing `@aws-sdk/client-s3` client already in the server package.

**Relevant Files**:
- Create: `packages/server/src/aws/ssh-keys.ts`
- Create: `packages/server/src/aws/__tests__/ssh-keys.test.ts`

### Success Criteria
- `generateKeyPair(remoteEnvId: string)` generates ed25519 key pair via `ssh-keygen -t ed25519 -f <tmpdir>/id_ed25519 -N "" -C "fuel-code-<remoteEnvId>"`
- `uploadKeys(remoteEnvId: string, publicKey: string, privateKey: string)` uploads both to S3 at `ssh-keys/{remoteEnvId}/id_ed25519` and `ssh-keys/{remoteEnvId}/id_ed25519.pub` with AES256 server-side encryption
- `downloadPrivateKey(remoteEnvId: string)` retrieves private key from S3, returns it as a string
- `deleteKeys(remoteEnvId: string)` deletes both keys from S3
- Temporary files are created in a unique temp directory and cleaned up after upload (even on error, via try/finally)
- Unit tests verify key generation (checking that ssh-keygen is called with correct args), S3 upload paths, and cleanup of temp files
- S3 operations use the existing S3 client pattern from the server package

---

## Task 3: Blueprint Detector + env.yaml Schema and Validation

### Parallel Group: A

### Dependencies: None

### Description

Implement the blueprint auto-detection engine that scans a repository's file system to infer runtime, version, package manager, system dependencies, Docker base image, and setup commands. Also implement the Zod schema for `.fuel-code/env.yaml` and validation logic. The detector does NOT execute any code in the repository -- it only reads files.

This lives in `packages/core/` because it is pure domain logic with no HTTP or UI knowledge. It receives a directory path and returns a Blueprint configuration object.

**Relevant Files**:
- Create or replace: `packages/core/src/blueprint-detector.ts`
- Create: `packages/core/src/__tests__/blueprint-detector.test.ts`
- Modify: `packages/shared/src/types/blueprint.ts` (ensure Zod schema for env.yaml is complete)

### Success Criteria
- `detectBlueprint(repoPath: string): Promise<BlueprintConfig>` scans the given directory
- Detection heuristics implemented for: Node.js (package.json + lockfile detection for npm/yarn/bun/pnpm), Python (pyproject.toml, requirements.txt, Pipfile), Rust (Cargo.toml), Go (go.mod)
- Version detection from `.nvmrc`, `.node-version`, `package.json engines.node`, `pyproject.toml requires-python`, `.python-version`
- Docker base image selection based on detected runtime and version (e.g., `node:22-bookworm`, `python:3.12-bookworm`, `rust:1.80-bookworm`)
- Setup commands inferred (e.g., `bun install` for bun projects, `pip install -e .` for Python)
- System deps detection from common patterns (Postgres client if DB-related deps found, etc.)
- `BlueprintConfigSchema` Zod schema validates the full env.yaml structure with defaults for optional fields (instance_type defaults to `t3.xlarge`, region to `us-east-1`, disk_gb to 50, etc.)
- `validateBlueprint(config: unknown): BlueprintConfig` parses and validates, returns typed config or throws with specific validation errors
- Unit tests cover each runtime detection, version extraction, edge cases (missing lockfile, multiple runtimes, empty repo), and schema validation (valid configs, missing required fields, invalid values)

---

## Task 4: Remote Env Database Operations + Migration

### Parallel Group: A

### Dependencies: None

### Description

Implement the database access layer for `remote_envs` and `blueprints` tables. The tables already exist in `infra/sql/schema.sql` but may need a migration to add them to the running database. This task creates the CRUD functions, status transition logic, and any needed migration file.

The status transition logic enforces valid transitions:
- `provisioning` --> `ready`, `error`, `terminated`
- `ready` --> `active`, `idle`, `error`, `terminated`
- `active` --> `idle`, `error`, `terminated`
- `idle` --> `active`, `error`, `terminated`
- `error` --> `terminated`
- `terminated` --> (terminal, no transitions)

**Relevant Files**:
- Create: `packages/server/src/db/remote-envs.ts`
- Create: `packages/server/src/db/__tests__/remote-envs.test.ts`
- Create: `packages/server/src/db/migrations/XXXX_add_remote_envs.sql` (if not already migrated)

### Success Criteria
- `createRemoteEnv(params)` inserts a new record with status `provisioning`, returns the created row
- `getRemoteEnv(id)` returns a single remote env by ID, or null
- `listRemoteEnvs(filters?)` lists remote envs with optional filters (workspace_id, status, active-only)
- `updateRemoteEnvStatus(id, newStatus, metadata?)` validates the transition is legal, updates status and relevant timestamps (ready_at, terminated_at), throws on invalid transition
- `updateRemoteEnvInstance(id, instanceId, publicIp)` sets the EC2 instance details after launch
- `setRemoteEnvReady(id, publicIp, deviceId)` transitions to ready, sets ready_at and public_ip and device_id
- `getActiveRemoteEnvs()` returns all envs with status NOT IN ('terminated', 'error') for lifecycle enforcement
- `getRemoteEnvByInstanceId(instanceId)` for orphan detection lookups
- `saveBlueprintConfig(params)` inserts into blueprints table
- Status transition validation enforced at the DB layer (invalid transitions throw `InvalidStatusTransitionError`)
- Unit tests use a real Postgres test database (or mock sql object) to verify CRUD, status transitions (valid and invalid), and filter queries
- Migration file created if the remote_envs/blueprints tables are not yet in the migration sequence

---

## Task 5: Remote API Endpoints (CRUD + Ready Callback + SSH Key Download)

### Parallel Group: B

### Dependencies: 1, 2, 4

### Description

Implement all 6 remote environment API endpoints defined in CORE.md. These endpoints are the server-side interface for provisioning, querying, terminating, and managing SSH key access for remote environments. The ready callback endpoint is called by the EC2 user-data script when provisioning completes.

The SSH key download endpoint enforces one-time access: the first GET returns the private key, subsequent GETs return 410 Gone. This prevents the key from being exfiltrated later if the API key is compromised.

**Relevant Files**:
- Create: `packages/server/src/routes/remote.ts`
- Create: `packages/server/src/routes/__tests__/remote.test.ts`
- Modify: `packages/server/src/index.ts` (mount the new router)

### Success Criteria
- `POST /api/remote` -- accepts `{ workspace_id, blueprint, branch? }`, creates a remote_envs record with status `provisioning`, returns `{ id, status }`. Does NOT start provisioning (that is Task 8's job; the endpoint just creates the record).
- `GET /api/remote` -- lists remote envs, filterable by `?status=active&workspace_id=...`, returns `{ remote_envs: RemoteEnv[] }`
- `GET /api/remote/:id` -- returns full remote env detail including blueprint config, cost estimate, uptime
- `POST /api/remote/:id/terminate` -- calls terminate logic (Task 8's terminate function), returns `{ status: 'terminated' }`
- `GET /api/remote/:id/ssh-key` -- returns `{ private_key: string }` on first call, sets `ssh_key_downloaded_at` in DB. Returns 410 Gone with `{ error: 'SSH key already downloaded' }` on subsequent calls. Returns 404 if env not found, 409 if env not in `ready`/`active`/`idle` status.
- `POST /api/remote/:id/ready` -- called by EC2 user-data script. Accepts `{ public_ip, device_id, ssh_port? }`. Transitions status to `ready`, sets `ready_at`. Idempotent (second call is no-op if already ready). Emits `remote.provision.ready` event.
- All endpoints require auth (existing middleware)
- Request body validation via Zod schemas
- Unit/integration tests cover all endpoints, status codes, edge cases (terminate already-terminated env, download key twice, ready callback for unknown ID)

---

## Task 6: Remote Event Handlers (provision.start, provision.ready, provision.error, terminate)

### Parallel Group: B

### Dependencies: 4

### Description

Register handlers in the event processor for the four remote event types. These handlers update the `remote_envs` and `devices` tables when remote lifecycle events flow through the pipeline. They follow the same pattern as existing session and git event handlers.

**Relevant Files**:
- Create: `packages/server/src/pipeline/handlers/remote-provision-start.ts`
- Create: `packages/server/src/pipeline/handlers/remote-provision-ready.ts`
- Create: `packages/server/src/pipeline/handlers/remote-provision-error.ts`
- Create: `packages/server/src/pipeline/handlers/remote-terminate.ts`
- Modify: handler registry to register the new handlers
- Create: `packages/server/src/pipeline/handlers/__tests__/remote-handlers.test.ts`

### Success Criteria
- `remote.provision.start` handler: creates/updates remote_envs record, creates device record with type `remote` and status `provisioning`
- `remote.provision.ready` handler: updates remote_envs status to `ready`, updates device status to `online`, stores public_ip
- `remote.provision.error` handler: updates remote_envs status to `error`, stores error message in metadata, updates device status to `offline`
- `remote.terminate` handler: updates remote_envs status to `terminated`, sets terminated_at and termination_reason, updates device status to `terminated`, records uptime and cost
- All handlers registered in the handler registry with correct event type keys
- Handlers are idempotent (processing the same event twice produces the same result)
- Unit tests verify each handler's DB mutations and edge cases (event for unknown remote env, duplicate events)

---

## Task 7: User-Data Script + Dockerfile.remote

### Parallel Group: B

### Dependencies: None

### Description

Implement the EC2 user-data bootstrap script and the default Docker image for remote dev environments. The user-data script is a bash template with placeholders that the provisioning orchestrator fills in at launch time. It installs Docker, pulls the container image, starts the container, and runs setup inside it. The Dockerfile.remote provides a base image with common dev tools pre-installed.

**Relevant Files**:
- Replace: `infra/docker/Dockerfile.remote`
- Replace: `infra/docker/scripts/user-data.sh`
- Create: `infra/docker/scripts/__tests__/user-data.test.ts` (template rendering tests)

### Success Criteria
- `user-data.sh` is a valid bash script with placeholders: `{{DOCKER_IMAGE}}`, `{{REPO_URL}}`, `{{REPO_BRANCH}}`, `{{SETUP_COMMANDS}}`, `{{ENV_VARS}}`, `{{PORT_MAPPINGS}}`, `{{BACKEND_URL}}`, `{{API_KEY}}`, `{{REMOTE_ENV_ID}}`, `{{ANTHROPIC_API_KEY}}`, `{{SYSTEM_DEPS}}`, `{{DISK_GB}}`
- Script installs Docker CE on Amazon Linux 2023 (`dnf install docker -y && systemctl start docker`)
- Script pulls the Docker image specified by the blueprint
- Script starts the container with: env vars, port mappings, volume mounts for repo data, `--restart unless-stopped`
- Inside the container (via `docker exec`): clones the repo, checks out the specified branch, runs setup commands, installs fuel-code CLI (via `bun install -g fuel-code`), runs `fuel-code init --device-type remote --name remote-<REMOTE_ENV_ID>`, installs CC hooks + git hooks, installs Claude Code, health-checks with `claude --version`
- On success: calls `curl -X POST {{BACKEND_URL}}/api/remote/{{REMOTE_ENV_ID}}/ready -H "Authorization: Bearer {{API_KEY}}" -d '{"public_ip": "$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)", "device_id": "$(cat ~/.fuel-code/device.json | jq -r .id)"}'`
- On failure at any step: calls the backend with an error event (or the lifecycle enforcer handles the timeout)
- `Dockerfile.remote` is based on `ubuntu:22.04` (or `bookworm`), installs: git, curl, jq, ssh, bun, common build tools (gcc, make)
- A `renderUserData(params: UserDataParams): string` function in TypeScript renders the template with actual values
- Tests verify template rendering produces valid bash (all placeholders replaced, no `{{...}}` remain), and that the rendered script has correct structure

---

## Task 8: Provisioning Orchestrator (EC2 Launch + Security Group + Tagging)

### Parallel Group: C

### Dependencies: 1, 2, 4, 5, 7

### Description

The provisioning orchestrator is the core state machine that coordinates the multi-step provisioning flow: generate SSH keys, create security group, launch EC2 instance with user-data, wait for the ready callback, and transition to `ready`. It tracks progress through named stages for precise rollback on failure.

This is a server-side service, NOT a CLI module. It is called by the `POST /api/remote` endpoint (or a background job triggered by it). It uses the EC2 client wrapper (Task 1), SSH key manager (Task 2), DB operations (Task 4), and user-data template (Task 7).

**Relevant Files**:
- Create: `packages/server/src/services/provisioner.ts`
- Create: `packages/server/src/services/__tests__/provisioner.test.ts`

### Success Criteria
- `provisionRemoteEnv(params: ProvisionParams): Promise<RemoteEnv>` orchestrates the full flow
- Stage tracking: `INIT` --> `KEYS_GENERATED` --> `SG_CREATED` --> `INSTANCE_LAUNCHED` --> `WAITING_READY` --> `DONE`
- Step 1: Generate SSH key pair via Task 2's `generateKeyPair()`, upload to S3
- Step 2: Create security group `fuel-code-<remote_env_id>`, authorize SSH (port 22) ingress from caller's IP only
- Step 3: Render user-data template from Task 7 with blueprint + config values
- Step 4: Launch EC2 instance with: AMI (Amazon Linux 2023), instance type from blueprint, key pair (public key injected via user-data), user-data script, security group, tags (`fuel-code:managed=true`, `fuel-code:remote-env-id=<id>`, `fuel-code:workspace=<canonical_id>`)
- Step 5: Update DB with instance_id, public_ip
- Step 6: Emit `remote.provision.start` event
- Step 7: Return immediately (ready callback from EC2 will trigger status transition later)
- On failure at any stage, rollback cleans up everything created in previous stages: terminate instance (if launched), delete security group (if created), delete SSH keys (if generated), update DB status to `error`
- Rollback logic is in a `finally`/`catch` block that inspects which stage was reached
- `terminateRemoteEnv(id: string, reason: string)` handles full teardown: terminate EC2 instance, delete security group, delete SSH keys from S3, update DB, emit `remote.terminate` event
- Unit tests with mock EC2 client verify: successful provisioning flow, failure at each stage triggers correct rollback, `terminateRemoteEnv` cleans up all resources
- Tests simulate: launch failure (verify SG + keys cleaned up), SG creation failure (verify keys cleaned up), ready callback timeout (verify instance terminated)

---

## Task 9: Lifecycle Enforcer: Idle Timeout + TTL Auto-Termination

### Parallel Group: C

### Dependencies: 1, 4, 5

### Description

Implement a periodic server-side job that checks all active remote environments for TTL expiry and idle timeout, and automatically terminates environments that exceed either threshold. This runs as a `setInterval` inside the Express server process.

**Relevant Files**:
- Create: `packages/server/src/services/lifecycle-enforcer.ts`
- Create: `packages/server/src/services/__tests__/lifecycle-enforcer.test.ts`
- Modify: `packages/server/src/index.ts` (start the enforcer on server boot)

### Success Criteria
- `startLifecycleEnforcer(deps: { ec2: Ec2Operations, db: RemoteEnvDb, logger: Logger }): { stop: () => void }` starts the interval, returns a handle to stop it (for graceful shutdown)
- Runs every 60 seconds (configurable)
- TTL check: for each active env, if `Date.now() - provisioned_at > ttl_minutes * 60_000`, terminate with reason `ttl`
- Idle check: queries the `events` table for the most recent event from the env's `device_id`. If `Date.now() - last_event_timestamp > idle_timeout_minutes * 60_000`, terminate with reason `idle`. If NO events exist for the device and the env has been `ready` for longer than `idle_timeout_minutes`, also terminate (handles the case where the user never actually used the environment).
- Provisioning timeout: if status is `provisioning` and `Date.now() - provisioned_at > 10 * 60_000` (10 minutes), mark as `error` and terminate with reason `provision-timeout`
- Uses `terminateRemoteEnv()` from Task 8 for actual teardown
- Each check iteration logs at `debug` level (how many envs checked, how many terminated). Terminations log at `info` level with env ID, reason, and uptime.
- `stop()` clears the interval cleanly (for server shutdown and tests)
- Unit tests use mock EC2 client and fake timestamps (inject a `now()` function) to verify: TTL expiry triggers termination, idle timeout triggers termination, provisioning timeout triggers error+termination, environments within limits are not touched, `stop()` halts the interval

---

## Task 10: Orphan Detection + Cleanup Sweep

### Parallel Group: C

### Dependencies: 1, 4

### Description

Implement a periodic sweep that cross-references AWS EC2 instances tagged with `fuel-code:managed=true` against the `remote_envs` database table, and cleans up any discrepancies. This catches instances orphaned by crashes, partial failures, or manual AWS console actions.

**Relevant Files**:
- Create: `packages/server/src/services/orphan-detector.ts`
- Create: `packages/server/src/services/__tests__/orphan-detector.test.ts`
- Modify: `packages/server/src/index.ts` (start the detector on server boot)

### Success Criteria
- `startOrphanDetector(deps: { ec2: Ec2Operations, db: RemoteEnvDb, logger: Logger }): { stop: () => void }` starts the sweep interval, returns a stop handle
- Runs every 5 minutes (configurable)
- Case 1: Instance exists in AWS, no matching DB record --> terminate instance via AWS, log at `warn`
- Case 2: Instance exists in AWS (running/pending), DB record says `terminated` or `error` --> terminate instance via AWS, log at `warn`
- Case 3: DB record says `provisioning`/`ready`/`active`/`idle`, instance does NOT exist in AWS (or is `terminated`/`shutting-down`) --> update DB to `terminated` with reason `orphan-cleanup`, log at `warn`
- Case 4: Both agree (running instance, non-terminated DB record) --> no action
- Case 5: Both say terminated --> no action
- Each sweep logs a summary: `"Orphan sweep: checked N instances, found M orphans, cleaned up K"`
- Unit tests with mock EC2 client verify all 5 cases, including mixed scenarios (some orphaned, some healthy)
- Sweep is resilient to AWS API failures (catches and logs errors, does not crash the server process)

---

## Task 11: Graceful Abort Handler (Ctrl-C During Provisioning)

### Parallel Group: D

### Dependencies: 1, 8

### Description

Implement the CLI-side abort handler that ensures Ctrl-C during `fuel-code remote up` does not leave orphaned EC2 resources. The handler intercepts SIGINT, sets an aborting flag, and calls the server-side terminate endpoint to clean up.

This is a CLI-side concern because the provisioning orchestrator (Task 8) runs server-side, but the user's terminal is CLI-side. The CLI needs to translate SIGINT into a terminate API call.

**Relevant Files**:
- Create: `packages/cli/src/lib/abort-handler.ts`
- Create: `packages/cli/src/lib/__tests__/abort-handler.test.ts`

### Success Criteria
- `withAbortHandler<T>(remoteEnvId: string, apiClient: ApiClient, fn: (signal: AbortSignal) => Promise<T>): Promise<T>` wraps an async operation with SIGINT handling
- On SIGINT: prints "Aborting... cleaning up remote environment <id>", calls `POST /api/remote/:id/terminate`, prints "Cleaned up." and exits with code 130 (standard SIGINT exit code)
- If the terminate call fails, prints "Warning: cleanup failed. Run `fuel-code remote down <id>` to clean up manually." and exits with code 1
- The wrapped function receives an `AbortSignal` it can check periodically (or pass to fetch calls) to bail out early
- Restores the original SIGINT handler after the operation completes (whether success or abort)
- Handles double Ctrl-C: second SIGINT during cleanup forces immediate exit with a warning
- Unit tests verify: normal completion (handler removed cleanly), SIGINT triggers terminate call, failed terminate shows manual cleanup message, double SIGINT forces exit

---

## Task 12: Blueprint CLI Commands (detect, show, validate)

### Parallel Group: D

### Dependencies: 3

### Description

Implement the three blueprint-related CLI commands: `fuel-code blueprint detect` (auto-detect and generate env.yaml), `fuel-code blueprint show` (display current env.yaml), and `fuel-code blueprint validate` (validate env.yaml against schema). These commands use the blueprint detector from Task 3.

**Relevant Files**:
- Create: `packages/cli/src/commands/blueprint.ts`
- Create: `packages/cli/src/commands/__tests__/blueprint.test.ts`
- Modify: `packages/cli/src/index.ts` (register blueprint subcommands)

### Success Criteria
- `fuel-code blueprint detect` scans the current working directory, generates a `BlueprintConfig`, writes `.fuel-code/env.yaml` (creating the `.fuel-code/` directory if needed), and prints the generated config to stdout with a "Review and edit as needed" message
- If `.fuel-code/env.yaml` already exists, prompts "Overwrite existing env.yaml? [y/N]" (skips prompt with `--force` flag)
- `fuel-code blueprint show` reads `.fuel-code/env.yaml` from the current workspace, parses it with js-yaml, and prints it formatted to stdout. If file does not exist, prints error and suggests `fuel-code blueprint detect`
- `fuel-code blueprint validate` reads `.fuel-code/env.yaml`, validates against the Zod schema, prints "Valid" on success or detailed validation errors on failure (field-by-field)
- All three commands support `--json` for machine-readable output
- Error handling: file not found, invalid YAML syntax, schema validation failures
- Commands registered as `blueprint` subcommand group on the commander entry point
- Unit tests verify: detect generates correct YAML for a test repo, show reads and prints existing file, validate catches invalid configs, `--force` skips overwrite prompt

---

## Task 13: `fuel-code remote up` Command (Provision + Progress TUI)

### Parallel Group: E

### Dependencies: 3, 5, 8, 11, 12

### Description

Implement the main provisioning command that ties everything together. This command loads or detects a blueprint, calls the server to create a remote env record and trigger provisioning, shows a progress display while waiting for the ready callback, handles Ctrl-C gracefully, and prints the SSH connection command on success.

**Relevant Files**:
- Create: `packages/cli/src/commands/remote-up.ts`
- Create: `packages/cli/src/commands/__tests__/remote-up.test.ts`
- Modify: `packages/cli/src/index.ts` (register `remote up` subcommand)

### Success Criteria
- `fuel-code remote up` (no args): loads `.fuel-code/env.yaml` from CWD. If missing, runs blueprint detection (Task 3), writes env.yaml, asks user to confirm
- `fuel-code remote up --repo <url>`: provisions for a specific repo URL (clones to temp dir for detection)
- Flow: validate blueprint --> POST /api/remote (create record) --> wait for provisioning --> display progress --> on ready: print SSH command
- Progress display shows a spinner/progress bar with stages: "Generating SSH keys...", "Creating security group...", "Launching EC2 instance...", "Waiting for instance to boot...", "Setting up Docker container...", "Ready!"
- Progress is driven by polling `GET /api/remote/:id` every 5 seconds (or WebSocket updates if available)
- Wrapped in `withAbortHandler` from Task 11 so Ctrl-C triggers cleanup
- On success: prints `fuel-code remote ssh <id>` command, instance type, region, estimated cost/hour
- On failure: prints error message, suggests `fuel-code remote ls` to check status
- `--branch <branch>` flag to specify git branch (defaults to current branch)
- `--instance-type <type>` flag to override blueprint's instance type
- `--ttl <minutes>` and `--idle-timeout <minutes>` flags to override defaults
- Unit tests mock the API client to verify: normal flow, abort handling, blueprint-not-found flow, provisioning failure flow

---

## Task 14: `fuel-code remote ssh` Command

### Parallel Group: E

### Dependencies: 2, 5

### Description

Implement the command that downloads the SSH key and opens an SSH connection to a running remote environment. The private key is downloaded from the server (one-time), written to a temporary file with 600 permissions, and used to SSH into the EC2 instance. After the SSH session exits, the temp file is deleted.

**Relevant Files**:
- Create: `packages/cli/src/commands/remote-ssh.ts`
- Create: `packages/cli/src/commands/__tests__/remote-ssh.test.ts`
- Modify: `packages/cli/src/index.ts` (register `remote ssh` subcommand)

### Success Criteria
- `fuel-code remote ssh <id>` connects to the specified remote environment
- Fetches remote env details via `GET /api/remote/:id` to get public_ip and status
- Validates status is `ready`, `active`, or `idle` (rejects `provisioning`, `terminated`, `error`)
- Downloads SSH private key via `GET /api/remote/:id/ssh-key`
- If key already downloaded (410 response): checks for cached key at `~/.fuel-code/ssh-keys/<id>/id_ed25519`, uses it if present. If not present, prints error: "SSH key was already downloaded and is not cached locally. Terminate and re-provision."
- Writes key to `~/.fuel-code/ssh-keys/<id>/id_ed25519` with mode 0600
- Spawns `ssh -i <key_path> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22 ec2-user@<public_ip>` as a child process with inherited stdio (user gets an interactive terminal)
- After SSH process exits: prints "Disconnected from remote environment <id>"
- `--command <cmd>` flag to run a single command instead of interactive session (e.g., `fuel-code remote ssh <id> --command "claude --version"`)
- If no `<id>` provided and exactly one active remote env exists, uses that one. If multiple, lists them and asks user to specify.
- Unit tests verify: key download and caching, SSH command construction, 410 handling, status validation

---

## Task 15: `fuel-code remote ls` + `fuel-code remote down` Commands

### Parallel Group: E

### Dependencies: 5

### Description

Implement the commands for listing and terminating remote environments.

**Relevant Files**:
- Create: `packages/cli/src/commands/remote-ls.ts`
- Create: `packages/cli/src/commands/remote-down.ts`
- Create: `packages/cli/src/commands/__tests__/remote-ls.test.ts`
- Create: `packages/cli/src/commands/__tests__/remote-down.test.ts`
- Modify: `packages/cli/src/index.ts` (register subcommands)

### Success Criteria
- `fuel-code remote ls` lists all non-terminated remote envs in a table: ID (short), workspace, status, instance type, region, uptime, estimated cost so far, public IP
- `fuel-code remote ls --all` includes terminated envs
- `fuel-code remote ls --json` outputs JSON
- `fuel-code remote status <id>` shows detailed info for one env: all fields, blueprint summary, events count, last event timestamp, SSH connection command (if ready/active/idle)
- `fuel-code remote down <id>` terminates the specified env via `POST /api/remote/:id/terminate`, prints confirmation
- `fuel-code remote down --all` terminates all active envs with confirmation prompt: "Terminate N active remote environments? [y/N]" (skips prompt with `--force`)
- Terminating an already-terminated env prints "Already terminated" (not an error)
- Unit tests verify: table formatting, JSON output, terminate flow, `--all` with confirmation, already-terminated handling

---

## Task 16: WebSocket Broadcast for Remote Status Updates

### Parallel Group: E

### Dependencies: 5, 6

### Description

Integrate remote environment status changes into the existing WebSocket broadcast system from Phase 4. When a remote env transitions status (provisioning --> ready, ready --> idle, etc.), the server broadcasts a `remote.update` message to subscribed WebSocket clients. This enables the TUI dashboard to show live provisioning progress and status changes.

**Relevant Files**:
- Modify: `packages/server/src/ws/broadcaster.ts` (add `broadcastRemoteUpdate` method)
- Modify: remote event handlers from Task 6 (call broadcaster after status transitions)
- Modify: `packages/server/src/services/provisioner.ts` (call broadcaster on status changes)
- Create: `packages/server/src/ws/__tests__/remote-broadcast.test.ts`

### Success Criteria
- `broadcastRemoteUpdate(remoteEnvId: string, status: string, publicIp?: string)` sends `{ type: "remote.update", remote_env_id, status, public_ip? }` to all WebSocket clients subscribed to `all` or the relevant `workspace_id`
- Remote event handlers call broadcaster after updating DB
- Provisioning orchestrator calls broadcaster at each stage transition
- Lifecycle enforcer and orphan detector call broadcaster when terminating envs
- Clients subscribed to a workspace receive updates for remote envs in that workspace
- Unit tests verify broadcast is called with correct payload on status transitions

---

## Task 17: Phase 5 E2E Integration Tests

### Parallel Group: F

### Dependencies: 9, 10, 13, 14, 15, 16

### Description

End-to-end tests that verify the complete remote dev environment lifecycle using a mock EC2 client. These tests exercise the full stack: CLI commands --> API endpoints --> provisioning orchestrator --> DB --> event handlers --> WebSocket broadcasts. No actual AWS resources are used.

**Relevant Files**:
- Create: `packages/server/src/__tests__/e2e/remote-lifecycle.test.ts`
- Create: `packages/cli/src/__tests__/e2e/remote-commands.test.ts`

### Success Criteria

**Lifecycle test (server-side)**:
1. Create remote env via `POST /api/remote` --> verify status = `provisioning`, DB record exists
2. Simulate ready callback via `POST /api/remote/:id/ready` --> verify status = `ready`, `remote.provision.ready` event emitted
3. Download SSH key via `GET /api/remote/:id/ssh-key` --> verify key returned
4. Download SSH key again --> verify 410 Gone
5. Simulate some events from the remote device --> verify events ingested, remote env transitions to `active`
6. Advance time past idle timeout --> run lifecycle enforcer tick --> verify env transitions to `terminated`, instance terminated via mock EC2
7. Verify `remote.terminate` event emitted with reason `idle`

**TTL test (server-side)**:
1. Create and ready a remote env with TTL = 1 minute
2. Advance time 2 minutes
3. Run lifecycle enforcer tick
4. Verify env terminated with reason `ttl`

**Orphan detection test (server-side)**:
1. Insert a mock EC2 instance tagged as fuel-code-managed that has no DB record
2. Run orphan detector sweep
3. Verify instance terminated via mock EC2

**Abort test (CLI-side, mocked)**:
1. Start `fuel-code remote up` with mock API that delays provisioning
2. Simulate SIGINT
3. Verify terminate endpoint called, cleanup message printed

**CLI command tests**:
1. `fuel-code remote ls` with mock API returning sample envs --> verify table output
2. `fuel-code remote down <id>` with mock API --> verify terminate called
3. `fuel-code blueprint detect` on a sample Node.js project directory --> verify env.yaml generated with correct values
4. `fuel-code blueprint validate` on valid/invalid configs --> verify output

**WebSocket test**:
1. Connect WS client, subscribe to workspace
2. Trigger remote status update
3. Verify `remote.update` message received

---

## Dependencies Added in Phase 5

```bash
# Server
cd packages/server && bun add @aws-sdk/client-ec2

# No new CLI dependencies -- ssh is system binary, js-yaml and other deps already present
# If js-yaml is not already installed:
cd packages/cli && bun add js-yaml
cd packages/cli && bun add -d @types/js-yaml

# Core (if js-yaml needed for blueprint detector)
cd packages/core && bun add js-yaml
cd packages/core && bun add -d @types/js-yaml
```

Note: `@aws-sdk/client-s3` is already a dependency from earlier phases. `js-yaml` may already be installed (used for config management in the CLI). Verify before adding duplicates.
