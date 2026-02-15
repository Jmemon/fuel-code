# Phase 5: Remote Dev Environments -- Task Dependency DAG (Draft A: Infrastructure-First)

## Overview

Phase 5 adds disposable remote dev environments to fuel-code. Users provision EC2 instances running Docker containers via `fuel-code remote up`, SSH into them via `fuel-code remote ssh`, list them via `fuel-code remote ls`, and tear them down via `fuel-code remote down`. Environments are auto-detected from repo contents (Blueprint), provisioned with user-data scripts, and self-register as Devices in the event pipeline. The infrastructure-first approach structures the work so that the AWS foundation (EC2 SDK wrapper, SSH key management, security groups) is solid before CLI commands or API routes are layered on top. The provisioning pipeline is treated as a sequence of clear stages: detect blueprint, generate infra resources, launch instance, wait for ready callback, connect.

After Phase 5, the user can:
- Auto-detect a project's environment requirements and generate `.fuel-code/env.yaml`
- Provision an EC2 instance with Docker running the project's environment
- SSH into the remote environment and run Claude Code sessions
- Have remote events flow through the same pipeline as local events
- List active remote environments and terminate them manually or via idle/TTL auto-termination
- Inspect and validate blueprints

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Blueprint Detector: Auto-Detect Project Environment | A | -- |
| 2 | Blueprint Schema, Validation, and env.yaml I/O | A | -- |
| 3 | AWS EC2 Client Wrapper (Launch, Describe, Terminate, Tags) | A | -- |
| 4 | SSH Key Pair Generation + S3 Storage | A | -- |
| 5 | Security Group Management (Create, Lookup, Authorize Ingress) | B | 3 |
| 6 | User-Data Script + Dockerfile.remote | B | 2 |
| 7 | Server: Remote Env API Endpoints + DB Queries | B | -- |
| 8 | Server: Remote Event Handlers (provision.start/ready/error, terminate) | C | 7 |
| 9 | Server: Idle Timeout + TTL Auto-Termination (Reaper) | C | 3, 7 |
| 10 | CLI: `fuel-code blueprint` Commands (detect, show, validate) | C | 1, 2 |
| 11 | EC2 Provisioning Orchestrator (Full Pipeline) | D | 3, 4, 5, 6, 7 |
| 12 | CLI: `fuel-code remote up` Command | E | 10, 11 |
| 13 | CLI: `fuel-code remote ssh` Command | E | 7 |
| 14 | CLI: `fuel-code remote ls` + `fuel-code remote down` Commands | E | 7, 9 |
| 15 | Phase 5 E2E Integration Tests | F | 8, 10, 12, 13, 14 |

## Dependency Graph

```
Group A ─── Task 1: Blueprint    Task 2: Blueprint    Task 3: AWS EC2     Task 4: SSH key
            detector             schema + YAML I/O    client wrapper      gen + S3
               │                    │                    │    │               │
               │                    │                    │    │               │
               │                    ▼                    ▼    │               │
               │               Task 6: User-data     Task 5: Security      │
               │               script + Dockerfile   group mgmt            │
               │                    │                    │                   │
               │                    │                    │                   │
               │                    └──────┬─────────────┘                  │
               │                           │                                │
               ▼                           │         ┌──────────────────────┘
Group B ───────────────────────────────────│─────────│───── Task 7: Remote API
               │                           │         │     endpoints + DB
               │                           │         │        │         │
               ▼                           │         │        │         │
Group C ─── Task 10: blueprint             │         │     Task 8      Task 9
            CLI commands                   │         │     event       reaper
               │                           │         │     handlers   (idle/TTL)
               │                           ▼         ▼        │         │
               │                      Task 11: EC2 provisioning         │
               │                      orchestrator (full pipeline)      │
               │                           │                            │
               ▼                           ▼                            │
Group E ─── Task 12: remote up    Task 13: remote ssh    Task 14: remote ls + down
               │                      │                         │
               └──────────────────────┼─────────────────────────┘
                                      │
                                      ▼
Group F ─── Task 15: Phase 5 E2E Integration Tests
```

## Parallel Groups

- **A**: Tasks 1, 2, 3, 4 (fully independent: blueprint detection logic, blueprint schema/YAML, AWS EC2 SDK wrapper, SSH key generation). These are the four foundational building blocks that everything else composes.
- **B**: Tasks 5, 6, 7 (security group needs EC2 client; user-data needs blueprint schema; remote API endpoints are independent of AWS). Task 7 is in this group by timing -- it can start in parallel with 5 and 6 since it has no AWS dependencies.
- **C**: Tasks 8, 9, 10 (event handlers need API endpoints; reaper needs EC2 client + API; blueprint CLI needs detector + schema). These can all proceed in parallel.
- **D**: Task 11 (the provisioning orchestrator composes Tasks 3, 4, 5, 6, 7 into a single pipeline). This is the integration point.
- **E**: Tasks 12, 13, 14 (independent CLI commands: `remote up` needs orchestrator + blueprint CLI; `remote ssh` needs API; `remote ls`/`down` need API + reaper).
- **F**: Task 15 (final E2E verification).

## Critical Path

Task 3 -> Task 5 -> Task 11 -> Task 12 -> Task 15

(5 sequential stages. The AWS infrastructure chain is the bottleneck: EC2 client must exist before security groups, security groups before orchestrator, orchestrator before `remote up`, then E2E tests.)

Secondary critical path: Task 2 -> Task 6 -> Task 11 (blueprint schema feeds user-data script which feeds orchestrator).

## Dependency Edges (precise)

- Task 1 -> Task 10 (detector logic needed by `blueprint detect` command)
- Task 2 -> Tasks 6, 10 (blueprint schema needed by user-data script template and blueprint CLI)
- Task 3 -> Tasks 5, 9, 11 (EC2 client needed by security group mgmt, reaper termination, orchestrator)
- Task 4 -> Task 11 (SSH key generation needed by orchestrator)
- Task 5 -> Task 11 (security group needed by orchestrator before launch)
- Task 6 -> Task 11 (user-data script template needed by orchestrator)
- Task 7 -> Tasks 8, 9, 11, 13, 14 (API endpoints/DB needed by handlers, reaper, orchestrator ready callback, SSH command, ls/down commands)
- Task 8 -> Task 15 (event handlers needed for E2E to verify events flow)
- Task 9 -> Task 14 (reaper logic shared with `remote down`)
- Task 10 -> Task 12 (`remote up` calls blueprint detect/load before provisioning)
- Task 11 -> Task 12 (`remote up` invokes the orchestrator)
- Tasks 12, 13, 14 -> Task 15 (E2E tests exercise all CLI commands)

## Key Design Decisions

### 1. EC2 Client as Thin Wrapper Over AWS SDK v3

The EC2 client (`packages/server/src/aws/ec2-client.ts`) wraps `@aws-sdk/client-ec2` with typed methods for our specific operations: `launchInstance`, `describeInstance`, `terminateInstance`, `getPublicIp`, `createSecurityGroup`, `authorizeIngress`, `createTags`. Each method handles retries, error mapping to `FuelCodeError` subclasses, and structured logging. The wrapper exists so the orchestrator and reaper deal with clean interfaces, not raw SDK commands. The `@aws-sdk/client-ec2` package is added to `packages/server` since provisioning is a server-side concern (even though `remote up` triggers it from the CLI, the actual AWS calls happen via the API).

### 2. Provisioning is Server-Side, Not CLI-Side

`fuel-code remote up` calls `POST /api/remote` with the frozen blueprint. The server performs all AWS operations. This is critical because:
- The server has AWS credentials (IAM role on Railway or env vars). The CLI does not need AWS credentials.
- The server can receive the `POST /api/remote/:id/ready` callback from the EC2 instance.
- The reaper (idle/TTL termination) runs server-side and needs the same EC2 client.
- If the CLI crashes mid-provision, the server still tracks the instance.

The CLI polls `GET /api/remote/:id` to show provisioning progress, and receives status updates via WebSocket.

### 3. User-Data Script is a Template, Not Static

The user-data script (`infra/docker/scripts/user-data.sh`) is a bash template with placeholder variables filled in by the orchestrator at launch time. Variables include: `DOCKER_IMAGE`, `REPO_URL`, `REPO_BRANCH`, `SETUP_COMMANDS`, `PORT_MAPPINGS`, `ENV_VARS`, `FUEL_CODE_BACKEND_URL`, `FUEL_CODE_API_KEY`, `REMOTE_ENV_ID`, `ANTHROPIC_API_KEY`, `DISK_GB`. The template is read, variables substituted, and passed as EC2 UserData (base64-encoded). This avoids maintaining multiple scripts or a complex configuration system.

### 4. SSH Key Lifecycle: Generate -> S3 -> Download Once -> Delete on Terminate

SSH keys are ephemeral, per-environment:
1. Server generates ed25519 key pair using `ssh-keygen` (shelled out via bun).
2. Both keys uploaded to S3 at `ssh-keys/{remote_env_id}/id_ed25519` and `.pub`.
3. Public key injected into user-data script (written to `/root/.ssh/authorized_keys` on EC2).
4. Private key downloaded by CLI exactly once via `GET /api/remote/:id/ssh-key` (the endpoint marks it as downloaded and subsequent calls return 410 Gone).
5. Private key stored locally at `~/.fuel-code/ssh-keys/{remote_env_id}/id_ed25519` with `chmod 600`.
6. On termination: S3 keys deleted, local key deleted (best-effort).

### 5. Security Group: Per-User, Reused Across Environments

A single security group named `fuel-code-remote-{user-hash}` is created once and reused. On each `remote up`, the caller's public IP is authorized for SSH ingress (port 22). On `remote down`, the IP rule is removed. This avoids creating/deleting security groups on every provision. The group is tagged with `fuel-code:managed=true` for cleanup identification.

### 6. Blueprint Detection is Heuristic, Not Exhaustive

The blueprint detector scans the repo for well-known files and applies simple heuristics:
- `package.json` -> Node runtime, check `engines.node` for version, detect package manager from lockfile
- `requirements.txt` / `pyproject.toml` / `Pipfile` -> Python runtime
- `go.mod` -> Go runtime
- `Cargo.toml` -> Rust runtime
- `Gemfile` -> Ruby runtime

It does NOT try to be comprehensive. The auto-detected blueprint is a starting point. The user reviews and edits `.fuel-code/env.yaml`. The `validate` command catches obvious errors (invalid instance type, missing required fields).

### 7. Reaper Runs on a Cron Interval, Not Per-Instance Timers

The idle/TTL reaper is a server-side interval (every 60 seconds) that queries all non-terminated remote environments and checks:
- If `last_event_timestamp` is older than `idle_timeout_minutes` -> terminate
- If `provisioned_at` is older than `ttl_minutes` -> terminate

This is simpler and more reliable than per-instance timers. If the server restarts, the interval resumes and catches everything. The "last event timestamp" is derived from the events table (most recent event from that device), not a separate heartbeat mechanism.

### 8. Dockerfile.remote is Minimal

The `Dockerfile.remote` is NOT used directly by the provisioning flow. The user-data script pulls a public Docker image (e.g., `node:22-bookworm`) specified in the blueprint. The `Dockerfile.remote` exists as a reference/fallback for users who want to build custom images. The provisioning flow uses `docker run` with the blueprint's `base_image` directly.

### 9. Remote Device Registers Itself

When the user-data script runs `fuel-code init --device-type remote --remote-env-id <id>` inside the Docker container, the CLI:
1. Generates a new device_id (ULID)
2. Emits a `system.device.register` event with `device_type=remote`
3. The server associates this device_id with the remote_env record

This maintains the symmetry principle: the remote machine initializes itself the same way a local machine does.

## What Already Exists (from Phases 1-4)

### Server (packages/server/)
- Express app with auth middleware, error handling, pino logging
- Full event pipeline: POST /api/events/ingest -> Redis Stream -> Event processor -> Postgres
- Session CRUD endpoints, transcript parsing, summary generation
- Timeline endpoint
- Workspace + Device REST endpoints (GET /api/workspaces, GET /api/devices)
- WebSocket server with subscriptions and broadcast (already broadcasts `remote.update` message type)
- S3 client (`@aws-sdk/client-s3`) for transcript storage -- can be extended for SSH key storage
- Postgres pool, migrations runner
- Handler registry for event types (session.start, session.end, git.*)
- `packages/server/src/aws/` directory with S3 client
- `packages/server/src/routes/remote.ts` -- placeholder file, likely empty or stub

### CLI (packages/cli/)
- Commander entry point with all Phase 1-4 commands
- `ApiClient` class for all HTTP calls (`packages/cli/src/lib/api-client.ts`)
- `WsClient` for WebSocket live updates (`packages/cli/src/lib/ws-client.ts`)
- Output formatting utilities (`packages/cli/src/lib/format.ts`)
- Config management (`~/.fuel-code/config.yaml`) -- includes `aws.region`, `aws.profile`, `remote.*` defaults
- Local event queue with drainer
- Ink-based TUI dashboard with live updates
- Error hierarchy (FuelCodeError subclasses)

### Shared (packages/shared/)
- All types: Event, Session, Workspace, Device, Blueprint, RemoteEnv
- All Zod schemas for event payloads including `remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, `remote.terminate`
- ULID generation, canonical ID normalization
- Blueprint type + env.yaml schema definition (`packages/shared/src/types/blueprint.ts`)
- RemoteEnv type (`packages/shared/src/types/remote.ts`)

### Core (packages/core/)
- Event processor, transcript parser, summary generator
- Workspace resolver, session manager, git correlator
- `blueprint-detector.ts` -- placeholder file, likely empty or has skeleton

### Infrastructure
- `infra/docker/Dockerfile.remote` -- placeholder
- `infra/docker/scripts/user-data.sh` -- placeholder
- `infra/sql/schema.sql` -- includes `remote_envs` and `blueprints` tables

### Database
- `remote_envs` table exists (provisioning/ready/active/idle/terminated/error statuses, instance_id, public_ip, ssh_key_s3_key, blueprint JSONB, ttl, idle_timeout, cost fields)
- `blueprints` table exists (workspace_id, name, source, detected_from, config JSONB)
- Migrations infrastructure exists

### NOT yet built (this phase creates them)
- Blueprint detection logic (`packages/core/src/blueprint-detector.ts` -- implementation)
- Blueprint YAML I/O and validation (read/write `.fuel-code/env.yaml`)
- EC2 client wrapper (`packages/server/src/aws/ec2-client.ts`)
- SSH key generation + S3 storage
- Security group management
- User-data script implementation (`infra/docker/scripts/user-data.sh`)
- Remote API endpoints implementation (`packages/server/src/routes/remote.ts`)
- Remote event handlers (provision.start, provision.ready, provision.error, terminate)
- Idle timeout + TTL reaper
- EC2 provisioning orchestrator
- All `fuel-code blueprint` CLI commands
- All `fuel-code remote` CLI commands (up, ssh, ls, down)

---

# Task Details

---

## Task 1: Blueprint Detector -- Auto-Detect Project Environment

### Parallel Group: A
### Dependencies: None

### Description

Implement the blueprint auto-detection engine in `packages/core/src/blueprint-detector.ts`. This module scans a local repository directory and produces a `BlueprintConfig` object by analyzing well-known files (package.json, requirements.txt, go.mod, Cargo.toml, etc.). It determines runtime, version, package manager, system dependencies, Docker base image, and reasonable resource defaults. The detector is a pure function: given a directory path, it returns a detected blueprint. It does NOT write files or call the network.

The detection strategy is a pipeline of scanners, each responsible for one concern:
1. **Runtime scanner**: Check for language-specific manifest files. First match wins (priority order: package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, Gemfile).
2. **Version scanner**: Extract version constraints from manifest (e.g., `engines.node` in package.json, `python_requires` in pyproject.toml, `go` directive in go.mod).
3. **Package manager scanner**: Detect from lockfile presence (bun.lockb -> bun, yarn.lock -> yarn, package-lock.json -> npm, pnpm-lock.yaml -> pnpm, uv.lock -> uv, poetry.lock -> poetry, Pipfile.lock -> pipenv).
4. **System deps scanner**: Look for docker-compose.yml service names (postgres, redis, mysql) to infer system dependency needs. Check for common patterns in scripts/CI configs.
5. **Docker image resolver**: Map runtime + version to a Docker base image (node:22-bookworm, python:3.12-bookworm, golang:1.22-bookworm, rust:1.77-bookworm, ruby:3.3-bookworm).
6. **Resource defaults**: Map runtime to sensible instance type defaults (Node/Python -> t3.large, Rust/Go -> t3.xlarge for compile performance).
7. **Setup commands**: Infer from package manager (bun install, npm install, pip install -r requirements.txt, go mod download, cargo build, bundle install).
8. **Port scanner**: Check for common port references in config files, docker-compose, or scripts.

Each scanner returns partial results. The detector merges them into a complete `BlueprintConfig` with sensible defaults for any gaps.

### Relevant Files
- `packages/core/src/blueprint-detector.ts` (implement -- likely replacing placeholder)
- `packages/core/src/__tests__/blueprint-detector.test.ts` (create)

### Success Criteria
1. Given a directory with `package.json` + `bun.lockb`, detects Node runtime with bun package manager and generates correct `docker.base_image`.
2. Given a directory with `pyproject.toml` + `uv.lock`, detects Python runtime with uv package manager.
3. Given a directory with `go.mod`, detects Go runtime with correct version from go directive.
4. Handles directories with no recognizable manifest gracefully (returns a generic Ubuntu blueprint with a warning).
5. Extracts node version from `engines.node` field in package.json.
6. Detects system deps from docker-compose service names (e.g., postgres service -> postgresql-client).
7. Infers setup commands from package manager (e.g., bun -> `bun install`).
8. Returns a valid `BlueprintConfig` that passes Zod validation for every test case.
9. Unit tests cover at least: Node/bun, Node/npm, Python/uv, Python/pip, Go, Rust, Ruby, no-manifest, and mixed-signals cases.
10. Pure function -- no filesystem writes, no network calls, no side effects beyond reading the directory.

---

## Task 2: Blueprint Schema, Validation, and env.yaml I/O

### Parallel Group: A
### Dependencies: None

### Description

Implement the YAML I/O layer for `.fuel-code/env.yaml` and validation logic for blueprint configurations. This module handles reading, writing, and validating blueprint files. It uses the existing `BlueprintConfig` type from `packages/shared/src/types/blueprint.ts` and the `js-yaml` package for YAML parsing/serialization.

Three core functions:
1. **`readBlueprint(dir: string): Promise<BlueprintConfig | null>`** -- Reads `.fuel-code/env.yaml` from the given directory. Returns null if the file does not exist. Throws `ValidationError` if the file exists but is invalid YAML or fails schema validation.
2. **`writeBlueprint(dir: string, config: BlueprintConfig): Promise<void>`** -- Writes a `BlueprintConfig` to `.fuel-code/env.yaml`, creating the `.fuel-code/` directory if needed. Includes a header comment explaining the file's purpose and that it was auto-generated.
3. **`validateBlueprint(config: BlueprintConfig): ValidationResult`** -- Validates a blueprint config against the Zod schema and performs semantic checks beyond what Zod can express:
   - Instance type is a valid AWS instance type pattern (t3.*, m5.*, c5.*, g4dn.*, etc.)
   - Region is a valid AWS region
   - Docker base image is a non-empty string
   - Disk size is between 8 and 1000 GB
   - Ports are valid (1-65535)
   - Setup commands are non-empty strings
   - Runtime + version combination makes sense (e.g., node version is >= 16)

Also implement **`freezeBlueprint(config: BlueprintConfig): FrozenBlueprint`** -- Takes a mutable config and produces an immutable JSON snapshot stored in the `remote_envs.blueprint` column. The frozen blueprint includes a SHA-256 hash of its contents for integrity verification.

### Relevant Files
- `packages/core/src/blueprint-io.ts` (create)
- `packages/core/src/__tests__/blueprint-io.test.ts` (create)
- `packages/shared/src/types/blueprint.ts` (may need to verify/extend existing types)

### Success Criteria
1. `readBlueprint` returns null for nonexistent `.fuel-code/env.yaml`.
2. `readBlueprint` parses valid YAML into a `BlueprintConfig` that passes Zod validation.
3. `readBlueprint` throws `ValidationError` with descriptive message for invalid YAML.
4. `writeBlueprint` creates `.fuel-code/` directory if it does not exist.
5. `writeBlueprint` produces valid YAML that round-trips: write then read returns identical config.
6. Written YAML includes header comment with auto-generation notice.
7. `validateBlueprint` catches invalid instance types, invalid regions, out-of-range ports, and out-of-range disk sizes.
8. `validateBlueprint` returns structured `{ valid: boolean, errors: string[] }` with human-readable error messages.
9. `freezeBlueprint` produces deterministic JSON with a SHA-256 hash that changes if any field changes.
10. `js-yaml` added as dependency to `packages/core`.

---

## Task 3: AWS EC2 Client Wrapper (Launch, Describe, Terminate, Tags)

### Parallel Group: A
### Dependencies: None

### Description

Build a typed EC2 client wrapper at `packages/server/src/aws/ec2-client.ts` that provides clean methods for the specific EC2 operations needed by the provisioning orchestrator and reaper. This wraps `@aws-sdk/client-ec2` v3, which must be added as a dependency to `packages/server`. The existing S3 client pattern in `packages/server/src/aws/` should be followed for consistency (constructor takes config, methods return typed results, errors mapped to `FuelCodeError` subclasses).

Methods to implement:

1. **`launchInstance(params: LaunchParams): Promise<LaunchResult>`** -- Calls `RunInstances` with: AMI ID (Amazon Linux 2023), instance type, key name (injected public key), user-data (base64), security group ID, block device mapping (EBS gp3 with specified disk size), tags, and `InstanceInitiatedShutdownBehavior: 'terminate'`. Returns instance ID and initial state.

2. **`describeInstance(instanceId: string): Promise<InstanceInfo>`** -- Calls `DescribeInstances` filtering by instance ID. Returns typed info: instance ID, state (pending/running/stopping/terminated), public IP, launch time, instance type.

3. **`terminateInstance(instanceId: string): Promise<void>`** -- Calls `TerminateInstances`. Idempotent -- does not throw if instance is already terminated.

4. **`waitForRunning(instanceId: string, timeoutMs?: number): Promise<InstanceInfo>`** -- Polls `describeInstance` every 5 seconds until instance state is `running` or timeout (default 120s). Returns instance info with public IP.

5. **`createTags(resourceId: string, tags: Record<string, string>): Promise<void>`** -- Calls `CreateTags`. Used to tag instances and security groups with fuel-code metadata.

6. **`getLatestAmiId(region: string): Promise<string>`** -- Calls `DescribeImages` to find the latest Amazon Linux 2023 AMI for the given region (owner: amazon, name pattern: `al2023-ami-*-x86_64`). Caches result for 24 hours.

Constructor takes `{ region: string, credentials?: AWS credentials }`. If no credentials provided, uses default credential chain (environment variables, IAM role, AWS profile).

All methods include structured pino logging (debug level for API calls, info level for results, error level for failures). All AWS errors are caught and re-thrown as `AwsError extends FuelCodeError` with the original error as `cause`.

### Relevant Files
- `packages/server/src/aws/ec2-client.ts` (create)
- `packages/server/src/aws/__tests__/ec2-client.test.ts` (create)
- `packages/server/package.json` (add `@aws-sdk/client-ec2`)

### Success Criteria
1. `@aws-sdk/client-ec2` added to `packages/server/package.json` via `bun add`.
2. `launchInstance` sends correct RunInstances params including user-data, security group, tags, and EBS config.
3. `describeInstance` returns typed `InstanceInfo` with all fields populated.
4. `terminateInstance` is idempotent (no error on already-terminated).
5. `waitForRunning` polls with 5-second interval and throws on timeout.
6. `getLatestAmiId` returns a valid AMI ID and caches the result.
7. `createTags` applies tags to any resource ID.
8. All methods log with pino at appropriate levels.
9. All AWS SDK errors are wrapped in `AwsError` with original error as cause.
10. Unit tests mock AWS SDK commands and verify correct parameters are sent.

---

## Task 4: SSH Key Pair Generation + S3 Storage

### Parallel Group: A
### Dependencies: None

### Description

Build the SSH key lifecycle manager at `packages/server/src/aws/ssh-keys.ts`. This module handles generation of ephemeral ed25519 key pairs, uploading them to S3, downloading them for CLI delivery, and cleaning them up on termination. SSH keys are generated by shelling out to the system `ssh-keygen` binary (per locked-in decision: no ssh2 npm package).

Functions to implement:

1. **`generateKeyPair(remoteEnvId: string): Promise<KeyPair>`** -- Generates an ed25519 key pair using `ssh-keygen -t ed25519 -f <tmp_path> -N "" -C "fuel-code-{remoteEnvId}"`. Uses a temporary directory (`os.tmpdir()`). Reads both files into memory. Cleans up temp files. Returns `{ publicKey: string, privateKey: string }`.

2. **`uploadKeyPair(remoteEnvId: string, keyPair: KeyPair): Promise<{ publicKeyS3Key: string, privateKeyS3Key: string }>`** -- Uploads both keys to S3 at `ssh-keys/{remoteEnvId}/id_ed25519` and `ssh-keys/{remoteEnvId}/id_ed25519.pub`. Uses the existing S3 client. Sets appropriate content type (`text/plain`) and SSE (server-side encryption with S3-managed keys).

3. **`downloadPrivateKey(remoteEnvId: string): Promise<string>`** -- Downloads the private key from S3. Returns the key contents as a string. This is called by the SSH key download endpoint.

4. **`deleteKeyPair(remoteEnvId: string): Promise<void>`** -- Deletes both keys from S3. Called on environment termination. Idempotent -- does not throw if keys are already deleted.

The S3 paths follow the layout specified in CORE.md: `ssh-keys/{remote_env_id}/id_ed25519` and `ssh-keys/{remote_env_id}/id_ed25519.pub`.

### Relevant Files
- `packages/server/src/aws/ssh-keys.ts` (create)
- `packages/server/src/aws/__tests__/ssh-keys.test.ts` (create)

### Success Criteria
1. `generateKeyPair` produces valid ed25519 keys by shelling out to `ssh-keygen`.
2. Generated keys are cleaned up from the temp directory after reading.
3. `uploadKeyPair` stores keys at the correct S3 paths with encryption enabled.
4. `downloadPrivateKey` returns the raw private key string.
5. `deleteKeyPair` removes both keys from S3 and does not throw on missing keys.
6. Unit tests mock Bun.spawn (for ssh-keygen) and S3 client calls.
7. Key comment includes the remote env ID for identification.
8. Temporary files use unique names to avoid conflicts with concurrent key generation.

---

## Task 5: Security Group Management (Create, Lookup, Authorize Ingress)

### Parallel Group: B
### Dependencies: Task 3

### Description

Build security group management at `packages/server/src/aws/security-groups.ts`. This module manages a single fuel-code security group per region that is reused across all remote environments. On each provisioning, the caller's IP is added as an authorized SSH ingress source. On termination, the IP rule can be revoked.

Functions to implement:

1. **`ensureSecurityGroup(ec2Client: Ec2Client, vpcId?: string): Promise<string>`** -- Looks up a security group named `fuel-code-remote` in the default VPC (or specified VPC). If it exists, returns its ID. If not, creates it with description "fuel-code remote dev environment SSH access", tags it with `fuel-code:managed=true`, and returns the new ID. Also ensures an egress rule allowing all outbound traffic exists (default for new SGs).

2. **`authorizeSSHIngress(ec2Client: Ec2Client, sgId: string, callerIp: string): Promise<void>`** -- Adds an ingress rule: TCP port 22 from `{callerIp}/32`. Uses `AuthorizeSecurityGroupIngress`. Idempotent -- catches `InvalidPermission.Duplicate` error and ignores it.

3. **`revokeSSHIngress(ec2Client: Ec2Client, sgId: string, callerIp: string): Promise<void>`** -- Removes the ingress rule. Idempotent -- catches `InvalidPermission.NotFound` and ignores it.

4. **`getCallerPublicIp(): Promise<string>`** -- Determines the caller's public IP by making a request to `https://checkip.amazonaws.com` (returns plain text IP). This is called server-side during provisioning. The server's public IP (Railway's egress IP) is used, not the CLI user's IP. **Note**: This means SSH is restricted to the server's IP. For `remote ssh` from the CLI, the CLI must also call this function and add its own IP via the API. The API needs an endpoint `POST /api/remote/:id/authorize-ip` that adds the CLI user's IP to the security group.

### Relevant Files
- `packages/server/src/aws/security-groups.ts` (create)
- `packages/server/src/aws/__tests__/security-groups.test.ts` (create)

### Success Criteria
1. `ensureSecurityGroup` creates the security group if it does not exist and returns its ID.
2. `ensureSecurityGroup` returns existing group ID on subsequent calls (idempotent).
3. Security group is tagged with `fuel-code:managed=true`.
4. `authorizeSSHIngress` adds a /32 CIDR rule for TCP port 22.
5. `authorizeSSHIngress` does not throw on duplicate rule.
6. `revokeSSHIngress` removes the rule and does not throw if rule is missing.
7. `getCallerPublicIp` returns a valid IPv4 address.
8. Unit tests mock EC2 client and verify correct API parameters.
9. The security group is created in the default VPC (no custom VPC needed).

---

## Task 6: User-Data Script + Dockerfile.remote

### Parallel Group: B
### Dependencies: Task 2

### Description

Implement the EC2 user-data bootstrap script and the reference Dockerfile. The user-data script is a bash template that the provisioning orchestrator fills in with blueprint-specific values at launch time. It runs on the EC2 instance at first boot and sets up everything needed: Docker, the project environment, fuel-code CLI, Claude Code, and hooks.

**User-data script** (`infra/docker/scripts/user-data.sh`):

The script is a bash template with `%%VARIABLE%%` placeholders (not shell variables, to avoid conflicts with the shell). The orchestrator reads this file, replaces placeholders, and passes the result as EC2 UserData.

Script stages:
1. **System setup**: Update packages, install Docker (`yum install -y docker && systemctl enable --now docker`). Amazon Linux 2023 has Docker available in repos.
2. **Pull Docker image**: `docker pull %%DOCKER_IMAGE%%`
3. **Start container**: `docker run -d --name fuel-code-env` with:
   - Port mappings from `%%PORT_MAPPINGS%%` (e.g., `-p 3000:3000 -p 5432:5432`)
   - Environment variables from `%%ENV_VARS%%` (e.g., `-e NODE_ENV=development -e ANTHROPIC_API_KEY=%%ANTHROPIC_API_KEY%%`)
   - Volume mount for SSH keys: `-v /root/.ssh:/root/.ssh:ro`
   - `%%DOCKER_IMAGE%%`
4. **Inside container** (via `docker exec`):
   - Install git: `apt-get update && apt-get install -y git %%SYSTEM_DEPS%%`
   - Clone repo: `git clone %%REPO_URL%% /workspace && cd /workspace && git checkout %%REPO_BRANCH%%`
   - Install bun: `curl -fsSL https://bun.sh/install | bash`
   - Run setup commands: `%%SETUP_COMMANDS%%` (one per line, each run as a separate `docker exec`)
   - Install fuel-code CLI: `bun install -g fuel-code` (or copy from a known URL)
   - Run `fuel-code init --device-type remote --remote-env-id %%REMOTE_ENV_ID%% --backend-url %%FUEL_CODE_BACKEND_URL%% --api-key %%FUEL_CODE_API_KEY%%`
   - Install Claude Code: `bun install -g @anthropic-ai/claude-code` (or npm)
   - Copy CC config (settings, hooks) -- the config is passed as a base64-encoded env var `%%CC_CONFIG_B64%%` and decoded into `~/.claude/`
   - Install hooks: `fuel-code hooks install`
   - Health check: `claude --version`
5. **Callback**: `curl -X POST %%FUEL_CODE_BACKEND_URL%%/api/remote/%%REMOTE_ENV_ID%%/ready -H "Authorization: Bearer %%FUEL_CODE_API_KEY%%" -H "Content-Type: application/json" -d '{"instance_id":"$(curl -s http://169.254.169.254/latest/meta-data/instance-id)","public_ip":"$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)","ssh_port":22}'`
6. **Error handling**: If any step fails, call `POST /api/remote/%%REMOTE_ENV_ID%%/error` with the failure details instead.

**Template rendering** (`packages/server/src/aws/user-data.ts`):

```typescript
function renderUserData(params: UserDataParams): string
```

This function reads the template file, replaces all `%%VARIABLE%%` placeholders, validates no unreplaced placeholders remain, and returns the script string. The orchestrator base64-encodes it for EC2.

**Dockerfile.remote** (`infra/docker/Dockerfile.remote`):

A reference Dockerfile that users can optionally build and push to a registry for faster provisioning. It pre-installs common tools (git, curl, bun, fuel-code CLI). This is NOT used by the default provisioning flow -- it exists as documentation and for advanced users.

### Relevant Files
- `infra/docker/scripts/user-data.sh` (implement -- replacing placeholder)
- `infra/docker/Dockerfile.remote` (implement -- replacing placeholder)
- `packages/server/src/aws/user-data.ts` (create -- template rendering)
- `packages/server/src/aws/__tests__/user-data.test.ts` (create)

### Success Criteria
1. User-data script installs Docker, pulls the image, starts container, clones repo, runs setup, installs fuel-code + Claude Code, and calls ready callback.
2. All placeholder variables are documented in the template header comment.
3. `renderUserData` replaces all placeholders and throws if any `%%VAR%%` remains unreplaced.
4. `renderUserData` correctly handles multi-line setup commands (joined with `&&` or as separate `docker exec` calls).
5. Error handling in the script calls the error callback endpoint with failure details.
6. Script uses IMDSv2 token for metadata access (security best practice).
7. Dockerfile.remote includes git, curl, bun, and fuel-code CLI pre-installed.
8. Unit tests verify template rendering with various blueprint configs (Node, Python, Go).
9. Port mappings are correctly formatted for `docker run -p` flag.
10. Environment variables are correctly escaped for shell injection safety.

---

## Task 7: Server -- Remote Env API Endpoints + DB Queries

### Parallel Group: B
### Dependencies: None

### Description

Implement the Remote Environment REST API endpoints at `packages/server/src/routes/remote.ts`. These endpoints handle CRUD operations for remote environments, the SSH key download, the ready callback from EC2, and IP authorization for SSH access. All endpoints use the existing auth middleware.

Endpoints to implement:

1. **`POST /api/remote`** -- Provision a new remote environment.
   - Body: `{ workspace_id: string, blueprint: FrozenBlueprint, repo_url: string, repo_branch: string }`
   - Creates a `remote_envs` record with status `provisioning`.
   - Saves the frozen blueprint snapshot.
   - Returns `{ id: string, status: "provisioning" }` with 202 Accepted.
   - The actual provisioning (EC2 launch) is triggered asynchronously after the response. (Task 11 wires this up.)

2. **`GET /api/remote`** -- List remote environments.
   - Query params: `status` (filter), `workspace_id` (filter), `limit`, `cursor`
   - Default: exclude `terminated` and `error` unless `?include_terminated=true`
   - Response: `{ remote_envs: RemoteEnv[], next_cursor, has_more }`

3. **`GET /api/remote/:id`** -- Remote environment detail.
   - Returns full remote env record including blueprint, status, IP, timestamps, cost.
   - Includes associated device info if available.
   - 404 if not found.

4. **`POST /api/remote/:id/terminate`** -- Request termination.
   - Body: `{ reason?: string }` (default "manual")
   - Updates status to `terminated`, sets `terminated_at` and `termination_reason`.
   - The actual EC2 termination is triggered asynchronously. (Task 9/11 wire this up.)
   - Returns 200 with updated record.

5. **`GET /api/remote/:id/ssh-key`** -- Download ephemeral SSH private key.
   - Returns the private key as `text/plain`.
   - Tracks download count in metadata. After first download, subsequent calls return 410 Gone (key already delivered).
   - This is a security measure: the key is only downloadable once.

6. **`POST /api/remote/:id/ready`** -- Callback from EC2 when provisioning completes.
   - Body: `{ instance_id: string, public_ip: string, ssh_port: number, device_id?: string }`
   - Updates status to `ready`, sets `public_ip`, `ready_at`.
   - Broadcasts `remote.update` via WebSocket.
   - Returns 200.

7. **`POST /api/remote/:id/error`** -- Callback from EC2 when provisioning fails.
   - Body: `{ error: string, stage: string }`
   - Updates status to `error`, stores error in metadata.
   - Returns 200.

8. **`POST /api/remote/:id/authorize-ip`** -- Authorize an additional IP for SSH access.
   - Body: `{ ip: string }`
   - Called by the CLI before `remote ssh` to add the user's IP to the security group.
   - Returns 200.

DB query helpers in `packages/server/src/db/remote-queries.ts`:
- `insertRemoteEnv(sql, params)`: INSERT with all fields.
- `getRemoteEnv(sql, id)`: SELECT by ID with device join.
- `listRemoteEnvs(sql, filters)`: SELECT with status/workspace filters and cursor pagination.
- `updateRemoteEnvStatus(sql, id, status, extra)`: UPDATE status and associated fields.
- `markSSHKeyDownloaded(sql, id)`: UPDATE metadata to record key download.

### Relevant Files
- `packages/server/src/routes/remote.ts` (implement -- replacing placeholder/stub)
- `packages/server/src/db/remote-queries.ts` (create)
- `packages/server/src/routes/__tests__/remote.test.ts` (create)
- `packages/server/src/app.ts` (modify -- mount remote router if not already)

### Success Criteria
1. `POST /api/remote` creates a remote_envs record and returns 202 with the new ID.
2. `GET /api/remote` lists non-terminated envs by default, supports status and workspace filters.
3. `GET /api/remote/:id` returns full detail with device info, or 404.
4. `POST /api/remote/:id/terminate` updates status and returns updated record.
5. `GET /api/remote/:id/ssh-key` returns private key on first call, 410 on subsequent calls.
6. `POST /api/remote/:id/ready` updates status to ready with IP and timestamp.
7. `POST /api/remote/:id/error` updates status to error with details.
8. `POST /api/remote/:id/authorize-ip` stores the IP for security group update.
9. All endpoints enforce auth middleware.
10. Cursor pagination works correctly on list endpoint.
11. WebSocket broadcast fires on status changes (ready, terminated, error).
12. Unit tests cover all endpoints including error cases (404, 410, duplicate terminate).

---

## Task 8: Server -- Remote Event Handlers (provision.start/ready/error, terminate)

### Parallel Group: C
### Dependencies: Task 7

### Description

Register event handlers in the existing handler registry for the four remote event types: `remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, and `remote.terminate`. These handlers are invoked by the event processor when remote events flow through the Redis Stream pipeline. They update the `remote_envs` table and broadcast WebSocket updates.

Handlers to implement (in `packages/server/src/pipeline/handlers/remote.ts`):

1. **`remote.provision.start`** handler:
   - Validates event data against existing Zod schema.
   - Updates remote_env status to `provisioning` (may already be, this is idempotent).
   - Logs provisioning start.

2. **`remote.provision.ready`** handler:
   - Validates event data: `{ instance_id, public_ip, ssh_port, device_id }`.
   - Updates remote_env: status -> `ready`, sets `public_ip`, `ready_at`, `device_id`.
   - Associates the device_id with the remote_env record.
   - Broadcasts `remote.update` WebSocket message with status and IP.

3. **`remote.provision.error`** handler:
   - Validates event data: `{ error, stage }`.
   - Updates remote_env: status -> `error`, stores error details in metadata.
   - Broadcasts `remote.update` with error status.

4. **`remote.terminate`** handler:
   - Validates event data: `{ instance_id, reason, uptime_seconds, total_cost_usd }`.
   - Updates remote_env: status -> `terminated`, sets `terminated_at`, `termination_reason`, `total_cost_usd`.
   - Updates associated device status to `terminated`.
   - Broadcasts `remote.update` with terminated status.

Register all four handlers in the handler registry at server startup (in the same file where session.start, session.end, git.* handlers are registered).

### Relevant Files
- `packages/server/src/pipeline/handlers/remote.ts` (create)
- `packages/server/src/pipeline/handlers/index.ts` (modify -- register remote handlers)
- `packages/server/src/pipeline/handlers/__tests__/remote.test.ts` (create)

### Success Criteria
1. All four event types are registered in the handler registry.
2. `remote.provision.ready` updates the remote_env with IP, device_id, and ready_at timestamp.
3. `remote.terminate` updates both remote_env and device status.
4. WebSocket broadcasts fire for ready, error, and terminate events.
5. Handlers are idempotent -- processing the same event twice does not cause errors.
6. Event data is validated against the existing Zod schemas from `packages/shared`.
7. Unit tests mock the database and WebSocket broadcaster, verifying correct DB updates and broadcasts for each event type.
8. Handlers log at info level with remote_env_id and instance_id for traceability.

---

## Task 9: Server -- Idle Timeout + TTL Auto-Termination (Reaper)

### Parallel Group: C
### Dependencies: Tasks 3, 7

### Description

Implement the reaper process that runs on a server-side interval and automatically terminates remote environments that have exceeded their TTL or idle timeout. The reaper queries for all non-terminated remote environments, checks their timestamps against configured limits, and terminates stale ones via the EC2 client.

Implementation at `packages/server/src/aws/reaper.ts`:

**`createReaper(deps: ReaperDeps): Reaper`**

```typescript
interface ReaperDeps {
  sql: postgres.Sql;
  ec2Client: Ec2Client;
  sshKeys: SshKeyManager;
  logger: pino.Logger;
  intervalMs?: number;  // default: 60_000 (1 minute)
}

interface Reaper {
  start(): void;
  stop(): void;
  runOnce(): Promise<ReaperResult>;  // for testing
}

interface ReaperResult {
  checked: number;
  terminated: { id: string; reason: 'idle' | 'ttl' }[];
  errors: { id: string; error: string }[];
}
```

The reaper loop:
1. Query all remote_envs with status IN ('ready', 'active', 'idle').
2. For each environment:
   a. **TTL check**: If `now() - provisioned_at > ttl_minutes`, terminate with reason `ttl`.
   b. **Idle check**: Query `SELECT MAX(timestamp) FROM events WHERE device_id = remote_env.device_id`. If `now() - last_event > idle_timeout_minutes`, terminate with reason `idle`. If the device has never sent an event and `now() - ready_at > idle_timeout_minutes`, also terminate.
3. For each termination:
   a. Call `ec2Client.terminateInstance(instance_id)`.
   b. Call `sshKeys.deleteKeyPair(remote_env_id)`.
   c. Update remote_env: status -> `terminated`, terminated_at -> now(), termination_reason -> reason.
   d. Emit a `remote.terminate` event into the pipeline.
   e. Update device status to `terminated`.
4. Log results: how many checked, how many terminated, any errors.

Error handling: If termination of one env fails, log the error and continue to the next. Never let one failure block the entire reaper cycle.

The reaper is started in the server's main startup sequence (after the event processor and before listening for requests).

### Relevant Files
- `packages/server/src/aws/reaper.ts` (create)
- `packages/server/src/aws/__tests__/reaper.test.ts` (create)
- `packages/server/src/index.ts` (modify -- start reaper on server startup)

### Success Criteria
1. Reaper runs on configurable interval (default 60 seconds).
2. TTL termination: environments older than `ttl_minutes` from provisioning are terminated.
3. Idle termination: environments with no events for `idle_timeout_minutes` are terminated.
4. Termination calls EC2 terminateInstance, deletes SSH keys from S3, updates DB, emits event.
5. Reaper is resilient: one failed termination does not block others.
6. `runOnce()` method enables deterministic testing without timers.
7. Reaper does not process environments in `provisioning` status (they may still be booting).
8. Reaper logs a summary after each cycle (checked N, terminated M, errors K).
9. Unit tests verify TTL termination, idle termination, resilience to errors, and correct cleanup steps.
10. Reaper start/stop lifecycle is clean -- `stop()` cancels the interval and any in-flight operations.

---

## Task 10: CLI -- `fuel-code blueprint` Commands (detect, show, validate)

### Parallel Group: C
### Dependencies: Tasks 1, 2

### Description

Implement the three blueprint CLI commands using Commander. These commands use the blueprint detector (Task 1) and blueprint I/O (Task 2) from `packages/core`.

**`fuel-code blueprint detect`**:
1. Determine the current workspace directory (CWD or `--repo <path>`).
2. Call `detectBlueprint(dir)` from `packages/core/src/blueprint-detector.ts`.
3. Display the detected configuration in YAML format with annotations explaining each detected value and its source (e.g., "runtime: node  # detected from package.json").
4. Prompt: "Save to .fuel-code/env.yaml? [Y/n]" (auto-yes with `--yes` flag).
5. If yes, call `writeBlueprint(dir, config)`.
6. If `.fuel-code/env.yaml` already exists, show a diff and prompt "Overwrite? [y/N]" (auto-no for safety).
7. `--json` flag outputs the detected config as JSON without prompts.
8. `--dry-run` flag shows what would be detected without writing.

**`fuel-code blueprint show`**:
1. Read `.fuel-code/env.yaml` from the current workspace.
2. Display it formatted with syntax highlighting (use picocolors for YAML key highlighting).
3. If file does not exist, print "No blueprint found. Run `fuel-code blueprint detect` to generate one." and exit 1.
4. `--json` flag outputs as JSON.

**`fuel-code blueprint validate`**:
1. Read `.fuel-code/env.yaml` from the current workspace.
2. Call `validateBlueprint(config)`.
3. Display validation results: green checkmarks for valid fields, red X's for errors.
4. Exit 0 if valid, exit 1 if invalid.
5. If file does not exist, print error and exit 1.

### Relevant Files
- `packages/cli/src/commands/blueprint.ts` (create)
- `packages/cli/src/index.ts` (modify -- register blueprint commands)
- `packages/cli/src/commands/__tests__/blueprint.test.ts` (create)

### Success Criteria
1. `fuel-code blueprint detect` auto-detects and displays blueprint for current directory.
2. `fuel-code blueprint detect --yes` writes without prompting.
3. `fuel-code blueprint detect --dry-run` shows detection without writing.
4. `fuel-code blueprint detect` warns and prompts before overwriting existing env.yaml.
5. `fuel-code blueprint show` displays current env.yaml with formatting.
6. `fuel-code blueprint show --json` outputs JSON.
7. `fuel-code blueprint validate` shows validation results with pass/fail indicators.
8. `fuel-code blueprint validate` exits 1 on invalid blueprint.
9. All commands handle missing env.yaml gracefully with clear error messages.
10. Commands registered in Commander entry point under `blueprint` subcommand group.
11. `--json` flag works on all three subcommands.

---

## Task 11: EC2 Provisioning Orchestrator (Full Pipeline)

### Parallel Group: D
### Dependencies: Tasks 3, 4, 5, 6, 7

### Description

Build the provisioning orchestrator that composes all infrastructure pieces into a single pipeline. The orchestrator is called when `POST /api/remote` creates a new remote_env record. It runs asynchronously (not blocking the API response) and coordinates the full provisioning sequence: generate SSH keys, ensure security group, render user-data, launch EC2 instance, wait for running state, tag instance, and update the remote_env record.

Implementation at `packages/server/src/aws/provisioner.ts`:

```typescript
interface ProvisionerDeps {
  ec2Client: Ec2Client;
  sshKeys: SshKeyManager;
  securityGroups: SecurityGroupManager;
  userData: UserDataRenderer;
  sql: postgres.Sql;
  s3Client: S3Client;
  logger: pino.Logger;
  config: {
    backendUrl: string;
    apiKey: string;
    anthropicApiKey: string;
  };
}

async function provisionRemoteEnv(
  deps: ProvisionerDeps,
  remoteEnvId: string,
  params: ProvisionParams
): Promise<void>
```

Provisioning sequence:
1. **Update status**: Set remote_env status to `provisioning`, emit `remote.provision.start` event.
2. **Generate SSH key pair**: Call `sshKeys.generateKeyPair(remoteEnvId)`.
3. **Upload SSH keys to S3**: Call `sshKeys.uploadKeyPair(remoteEnvId, keyPair)`. Store S3 key in remote_env record.
4. **Ensure security group**: Call `securityGroups.ensureSecurityGroup(ec2Client)`. Get group ID.
5. **Authorize server IP for SSH**: Call `securityGroups.authorizeSSHIngress(ec2Client, sgId, serverIp)`.
6. **Render user-data script**: Call `userData.renderUserData({ ... })` with all blueprint values, backend URL, API key, Anthropic key, remote env ID, repo URL, branch, SSH public key.
7. **Get latest AMI**: Call `ec2Client.getLatestAmiId(region)`.
8. **Launch EC2 instance**: Call `ec2Client.launchInstance({ amiId, instanceType, userData, securityGroupId, diskGb, keyPair: publicKey })`.
9. **Tag instance**: Call `ec2Client.createTags(instanceId, { 'fuel-code:remote-env-id': remoteEnvId, 'fuel-code:workspace': workspaceId, 'Name': 'fuel-code-remote-{remoteEnvId}' })`.
10. **Update remote_env**: Set `instance_id` on the record.
11. **Wait for running**: Call `ec2Client.waitForRunning(instanceId, 120_000)`.
12. **Update remote_env**: Set `public_ip` from running instance info.
13. **Log completion**: The instance is now running. The user-data script will call POST /api/remote/:id/ready when Docker + fuel-code setup is complete.

**Error handling**: If any step fails:
- Log the error with full context (step number, remote_env_id, instance_id if available).
- Update remote_env status to `error` with error details in metadata.
- Emit `remote.provision.error` event.
- If an instance was launched, attempt to terminate it (best-effort cleanup).
- If SSH keys were uploaded, attempt to delete them (best-effort cleanup).

The orchestrator is wired into the `POST /api/remote` handler: after creating the DB record and responding 202, the handler calls `provisionRemoteEnv` without awaiting it (fire-and-forget with error logging).

### Relevant Files
- `packages/server/src/aws/provisioner.ts` (create)
- `packages/server/src/aws/__tests__/provisioner.test.ts` (create)
- `packages/server/src/routes/remote.ts` (modify -- wire orchestrator into POST handler)

### Success Criteria
1. Orchestrator executes all 13 steps in sequence when called.
2. On success, remote_env record has instance_id, public_ip, ssh_key_s3_key populated.
3. On failure at any step, remote_env status is set to `error` with descriptive error message.
4. On failure after EC2 launch, best-effort cleanup terminates the instance.
5. On failure after SSH key upload, best-effort cleanup deletes the keys.
6. `remote.provision.start` event is emitted at the beginning.
7. `remote.provision.error` event is emitted on failure.
8. Instance is tagged with fuel-code metadata for orphan detection.
9. User-data script contains all required variables filled in.
10. Orchestrator does not block the API response (runs asynchronously).
11. Unit tests mock all dependencies and verify the sequence, error handling, and cleanup.
12. Logging covers each step with timing information.

---

## Task 12: CLI -- `fuel-code remote up` Command

### Parallel Group: E
### Dependencies: Tasks 10, 11

### Description

Implement the `fuel-code remote up` command. This is the main user-facing command for provisioning a remote dev environment. It orchestrates the CLI-side flow: detect/load blueprint, resolve workspace, call the provisioning API, poll for status, and display progress.

Command flow:
1. **Resolve workspace**: Determine workspace from CWD (using existing workspace resolution logic).
2. **Load or detect blueprint**:
   - If `.fuel-code/env.yaml` exists, load it. Validate. Show summary.
   - If not, run auto-detection (same as `blueprint detect`). Show results. Prompt to proceed.
   - `--blueprint <path>` flag overrides to use a specific file.
3. **Confirm**: Show cost estimate (instance_type -> hourly cost lookup table), TTL, idle timeout. Prompt "Provision? [Y/n]" (auto-yes with `--yes`).
4. **Freeze blueprint**: Call `freezeBlueprint(config)`.
5. **Call API**: `POST /api/remote` with `{ workspace_id, blueprint, repo_url, repo_branch }`.
6. **Show progress**: Display a progress spinner/status line. Poll `GET /api/remote/:id` every 3 seconds. Show stage transitions:
   - "Provisioning EC2 instance..." (provisioning)
   - "Instance running. Setting up environment..." (instance running but user-data still executing)
   - "Environment ready!" (ready)
   - "Error: ..." (error -- show details and exit 1)
7. **On ready**: Display connection info:
   ```
   Remote environment ready!
   ID:        01JMF3...
   Instance:  i-0abc123...
   IP:        54.123.45.67
   Region:    us-east-1

   Connect:   fuel-code remote ssh 01JMF3...
   Terminate: fuel-code remote down 01JMF3...
   ```
8. **Auto-connect**: If `--ssh` flag is passed, automatically run `fuel-code remote ssh <id>` after ready.

Also support `--repo <url>` flag to provision for a remote repo (clones it, runs detection, provisions).

The command uses the existing `ApiClient` for all HTTP calls and `WsClient` for real-time status updates (if WebSocket is connected, use it instead of polling).

### Relevant Files
- `packages/cli/src/commands/remote-up.ts` (create)
- `packages/cli/src/index.ts` (modify -- register remote commands)
- `packages/cli/src/commands/__tests__/remote-up.test.ts` (create)

### Success Criteria
1. `fuel-code remote up` loads existing blueprint or auto-detects.
2. Shows cost estimate and confirmation prompt before provisioning.
3. `--yes` flag skips confirmation.
4. Calls `POST /api/remote` and shows progress spinner during provisioning.
5. Displays connection info on success.
6. Shows descriptive error message on provisioning failure.
7. `--ssh` flag auto-connects after provisioning.
8. `--blueprint <path>` flag uses a specific env.yaml file.
9. Progress updates use WebSocket when available, polling as fallback.
10. `--json` flag outputs structured result without interactive elements.
11. Exit code 0 on success, 1 on failure.

---

## Task 13: CLI -- `fuel-code remote ssh` Command

### Parallel Group: E
### Dependencies: Task 7

### Description

Implement the `fuel-code remote ssh` command. This command downloads the ephemeral SSH key (if not already cached), authorizes the user's IP on the security group, and opens an SSH session to the remote environment by shelling out to the system `ssh` binary.

Command flow:
1. **Resolve remote env**: Look up by ID (full ULID or prefix match). Call `GET /api/remote/:id`.
2. **Check status**: Must be `ready` or `active`. Error if `provisioning` ("Still provisioning, try again in a moment"), `terminated` ("Environment has been terminated"), `error` ("Environment failed to provision").
3. **Download SSH key** (first time):
   - Call `GET /api/remote/:id/ssh-key`.
   - Save to `~/.fuel-code/ssh-keys/{remote_env_id}/id_ed25519`.
   - `chmod 600` the key file.
   - If 410 Gone (already downloaded), check for local cached key. If local key exists, use it. If not, error: "SSH key already downloaded and not cached locally."
4. **Authorize IP**:
   - Determine user's public IP (call `https://checkip.amazonaws.com`).
   - Call `POST /api/remote/:id/authorize-ip` with `{ ip }`.
5. **SSH command**:
   - Build: `ssh -i ~/.fuel-code/ssh-keys/{id}/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22 root@{public_ip}`
   - The `-o StrictHostKeyChecking=no` is acceptable because keys are ephemeral and instances are disposable.
   - If the environment runs Docker, the SSH command should exec into the container: `ssh ... root@{ip} "docker exec -it fuel-code-env /bin/bash"` OR SSH directly connects to the container if SSH is set up inside it.
   - Shell out using `Bun.spawn` with `stdio: 'inherit'` so the user gets an interactive terminal.
6. **After disconnect**: Print "Disconnected from remote environment {id}."

Prefix matching for env ID: If the user provides a prefix (e.g., `01JMF`), match against all non-terminated environments. If exactly one matches, use it. If multiple match, show them and ask.

### Relevant Files
- `packages/cli/src/commands/remote-ssh.ts` (create)
- `packages/cli/src/index.ts` (modify -- register ssh command under remote)
- `packages/cli/src/commands/__tests__/remote-ssh.test.ts` (create)

### Success Criteria
1. `fuel-code remote ssh <id>` connects to a ready remote environment via SSH.
2. SSH key is downloaded on first use and cached locally.
3. Cached key is reused on subsequent SSH connections to the same environment.
4. User's public IP is authorized on the security group before connecting.
5. SSH command shells out with `stdio: 'inherit'` for interactive terminal.
6. Prefix matching works for environment IDs.
7. Clear error messages for invalid states (provisioning, terminated, error).
8. Handles 410 Gone (key already downloaded) by falling back to cached key.
9. SSH key file is created with 600 permissions.
10. `StrictHostKeyChecking=no` and `UserKnownHostsFile=/dev/null` used for ephemeral instances.

---

## Task 14: CLI -- `fuel-code remote ls` + `fuel-code remote down` Commands

### Parallel Group: E
### Dependencies: Tasks 7, 9

### Description

Implement the list and terminate commands for remote environments.

**`fuel-code remote ls`**:
1. Call `GET /api/remote` (default: exclude terminated).
2. Display as table with columns: ID (short prefix), Workspace, Status, Instance Type, IP, Region, Uptime, Cost.
3. `--all` flag includes terminated/error environments.
4. `--json` flag outputs raw JSON.
5. If no active environments, print "No active remote environments." and exit 0.

Table format:
```
ID        Workspace    Status  Type       IP             Region      Uptime   Cost
01JMF3..  fuel-code    ready   t3.xlarge  54.123.45.67   us-east-1   2h 15m   $0.42
01JMF4..  api-service  active  t3.large   54.123.45.68   us-east-1   45m      $0.12
```

**`fuel-code remote down <id>`**:
1. Resolve remote env by ID (prefix match like `remote ssh`).
2. Show env details and prompt: "Terminate remote environment {id}? [y/N]" (auto-yes with `--yes`).
3. Call `POST /api/remote/:id/terminate` with `{ reason: "manual" }`.
4. Show "Terminating environment {id}..." and poll until status is `terminated`.
5. Print "Environment {id} terminated."
6. Clean up local SSH key if cached: delete `~/.fuel-code/ssh-keys/{id}/`.

**`fuel-code remote down --all`**:
1. List all non-terminated environments.
2. Show them in a table.
3. Prompt: "Terminate all N environments? [y/N]" (auto-yes with `--yes`).
4. Terminate each sequentially, showing progress.
5. Clean up all local SSH keys.

**`fuel-code remote status <id>`** (bonus, lightweight):
1. Call `GET /api/remote/:id`.
2. Display detailed status: all fields including blueprint summary, timestamps, device info.
3. This is essentially `remote ls` but for a single environment with verbose output.

### Relevant Files
- `packages/cli/src/commands/remote-ls.ts` (create)
- `packages/cli/src/commands/remote-down.ts` (create)
- `packages/cli/src/index.ts` (modify -- register ls, down, status commands under remote)
- `packages/cli/src/commands/__tests__/remote-ls.test.ts` (create)
- `packages/cli/src/commands/__tests__/remote-down.test.ts` (create)

### Success Criteria
1. `fuel-code remote ls` displays a formatted table of active remote environments.
2. `fuel-code remote ls --all` includes terminated and error environments.
3. `fuel-code remote ls --json` outputs raw JSON.
4. `fuel-code remote ls` shows "No active remote environments." when none exist.
5. `fuel-code remote down <id>` terminates the environment after confirmation.
6. `fuel-code remote down --yes <id>` skips confirmation.
7. `fuel-code remote down --all` terminates all environments after confirmation.
8. Local SSH keys are cleaned up on termination.
9. Prefix matching works for IDs on both `down` and `status`.
10. `fuel-code remote status <id>` shows verbose detail for a single environment.
11. Uptime calculation is correct (from provisioned_at to now or terminated_at).
12. Cost display uses remote_env cost fields.

---

## Task 15: Phase 5 E2E Integration Tests

### Parallel Group: F
### Dependencies: Tasks 8, 10, 12, 13, 14

### Description

Build end-to-end integration tests that verify the complete Phase 5 flow works from blueprint detection through provisioning, connection, event flow, and termination. These tests exercise the full stack: CLI commands, API endpoints, database operations, event handlers, and (with mocking) AWS operations.

Since actual EC2 provisioning is expensive and slow, the E2E tests use a **mock AWS layer**: the EC2 client, SSH key manager, and security group manager are replaced with in-memory mocks that simulate the provisioning timeline. The mock EC2 client returns fake instance IDs and IPs, and the mock transitions through states (pending -> running) on a timer.

Test scenarios:

1. **Blueprint detection E2E**:
   - Create a temp directory with a `package.json` and `bun.lockb`.
   - Run `fuel-code blueprint detect --yes` in that directory.
   - Verify `.fuel-code/env.yaml` is created with correct runtime, version, package_manager.
   - Run `fuel-code blueprint show --json` and verify output.
   - Run `fuel-code blueprint validate` and verify exit code 0.

2. **Full provisioning lifecycle (mocked AWS)**:
   - Start the server with mock AWS clients.
   - Call `POST /api/remote` with a test blueprint.
   - Verify remote_env record created with status `provisioning`.
   - Mock EC2 transitions: pending -> running.
   - Simulate user-data callback: `POST /api/remote/:id/ready` with mock IP.
   - Verify remote_env status is `ready`.
   - Verify `remote.provision.start` and `remote.provision.ready` events in events table.
   - Call `GET /api/remote` and verify it appears in the list.
   - Call `GET /api/remote/:id` and verify all fields.
   - Call `GET /api/remote/:id/ssh-key` and verify key is returned.
   - Call `GET /api/remote/:id/ssh-key` again and verify 410 Gone.

3. **Termination lifecycle (mocked AWS)**:
   - Continue from test 2.
   - Call `POST /api/remote/:id/terminate`.
   - Verify remote_env status is `terminated`.
   - Verify `remote.terminate` event in events table.
   - Verify SSH keys deleted from S3 (mock).
   - Verify EC2 instance terminated (mock).
   - Call `GET /api/remote` (default) and verify terminated env is excluded.
   - Call `GET /api/remote?include_terminated=true` and verify it appears.

4. **Reaper idle timeout (mocked AWS)**:
   - Create a remote_env with status `ready` and `provisioned_at` recent.
   - Set `idle_timeout_minutes` to 1.
   - Run reaper once. Verify no termination (instance just started, within idle window assuming no events check is based on ready_at for new envs).
   - Wait or mock time: set last event timestamp to 2 minutes ago.
   - Run reaper again. Verify environment terminated with reason `idle`.

5. **Reaper TTL timeout (mocked AWS)**:
   - Create a remote_env with status `ready` and `ttl_minutes` set to 1.
   - Set `provisioned_at` to 2 minutes ago.
   - Run reaper once. Verify environment terminated with reason `ttl`.

6. **Provisioning error handling (mocked AWS)**:
   - Start provisioning with mock EC2 client configured to fail on `launchInstance`.
   - Verify remote_env status is `error` with error details.
   - Verify `remote.provision.error` event in events table.
   - Verify cleanup was attempted (no orphaned SSH keys in S3).

7. **CLI `remote ls` output**:
   - Seed database with 3 remote envs (1 ready, 1 active, 1 terminated).
   - Run `fuel-code remote ls --json`.
   - Verify output contains 2 environments (excludes terminated).
   - Run `fuel-code remote ls --all --json`.
   - Verify output contains 3 environments.

8. **WebSocket remote.update broadcasts**:
   - Connect a WebSocket client subscribed to "all".
   - Trigger a provisioning ready callback.
   - Verify the client receives a `remote.update` message with status `ready` and public IP.

### Relevant Files
- `packages/server/src/__tests__/phase5-e2e.test.ts` (create)
- `packages/server/src/aws/__mocks__/ec2-client.ts` (create -- mock EC2 client)
- `packages/server/src/aws/__mocks__/ssh-keys.ts` (create -- mock SSH key manager)
- `packages/server/src/aws/__mocks__/security-groups.ts` (create -- mock security group manager)

### Success Criteria
1. All 8 test scenarios pass.
2. Tests use mock AWS layer -- no actual EC2 instances launched.
3. Tests exercise the full stack: API -> DB -> event pipeline -> handlers -> WebSocket.
4. Blueprint detection E2E creates and validates a real env.yaml file.
5. Provisioning lifecycle verifies all status transitions and events.
6. Termination lifecycle verifies cleanup (SSH keys, EC2 instance, DB status).
7. Reaper tests verify both idle and TTL termination paths.
8. Error handling test verifies cleanup on provisioning failure.
9. CLI output tests verify formatted output matches expected structure.
10. WebSocket test verifies real-time broadcast of remote status updates.
11. Tests are isolated -- each test creates its own data and cleans up.
12. Tests complete in under 30 seconds (no real AWS calls, no real timeouts).

---

## Dependencies Added in Phase 5

```bash
# Server -- EC2 SDK for provisioning
cd packages/server && bun add @aws-sdk/client-ec2

# Core -- YAML parser for blueprint I/O
cd packages/core && bun add js-yaml
cd packages/core && bun add -d @types/js-yaml
```

No other new dependencies are needed. The existing `@aws-sdk/client-s3` in `packages/server` handles SSH key storage. The existing `picocolors` in `packages/cli` handles CLI output formatting. The existing `commander` handles new command registration. The existing `ws` handles WebSocket communication.
