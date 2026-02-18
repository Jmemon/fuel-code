# Task 6: Remote API Endpoints + DB Queries + Migration

## Parallel Group: B

## Dependencies: Tasks 3, 4

## Description

Implement the Remote Environment REST API endpoints, database query helpers, and migration. These endpoints handle CRUD operations for remote environments, the SSH key download, the ready callback from EC2, IP authorization for SSH access, and the error callback. All endpoints use the existing auth middleware. The database layer enforces valid status transitions.

### API Endpoints: `packages/server/src/routes/remote.ts`

```typescript
function createRemoteRouter(deps: {
  sql: postgres.Sql;
  ec2Client: Ec2Operations;
  sshKeyManager: SshKeyManager;
  logger: pino.Logger;
  broadcaster: WsBroadcaster;
}): Router
```

---

**`POST /api/remote`** — Provision a new remote environment.

Request body:
```typescript
const provisionBodySchema = z.object({
  workspace_id: z.string().ulid(),
  blueprint: blueprintConfigSchema,  // from shared
  repo_url: z.string().url(),
  repo_branch: z.string().default('main'),
  ttl_minutes: z.number().int().min(30).max(1440).default(480),  // 8 hours
  idle_timeout_minutes: z.number().int().min(10).max(480).default(60),
});
```

- Creates a `remote_envs` record with status `provisioning`.
- Saves the frozen blueprint snapshot in the `blueprint` JSONB column.
- Does NOT trigger EC2 provisioning itself — that is wired in Task 8 (the handler calls `provisionRemoteEnv` asynchronously after responding).
- Returns 202 Accepted: `{ id: string, status: "provisioning" }`.

---

**`GET /api/remote`** — List remote environments.

Query params: `status` (filter), `workspace_id` (filter), `include_terminated` (boolean, default false), `limit` (default 50), `cursor`.

- Default: exclude `terminated` and `error` statuses unless `include_terminated=true`.
- Response: `{ remote_envs: RemoteEnv[], next_cursor: string | null, has_more: boolean }`.
- Ordered by `provisioned_at DESC`.

---

**`GET /api/remote/:id`** — Remote environment detail.

- Returns full remote_env record including blueprint, status, timestamps, cost, associated device info.
- Includes computed fields: `uptime_ms` (from provisioned_at to now or terminated_at), `estimated_cost_usd` (uptime_hours * cost_per_hour_usd).
- 404 if not found.

---

**`POST /api/remote/:id/terminate`** — Request termination.

Request body: `{ reason?: string }` (default "manual").

- Validates status transition is legal (can't terminate an already-terminated env — returns 409).
- Updates status to `terminated`, sets `terminated_at` and `termination_reason`.
- Triggers actual EC2 termination + SSH key cleanup asynchronously (Task 8's `terminateRemoteEnv` function, called without awaiting).
- Broadcasts `remote.update` via WebSocket.
- Returns 200 with updated record.

---

**`GET /api/remote/:id/ssh-key`** — Download ephemeral SSH private key.

- Validates status is `ready`, `active`, or `idle`. Returns 409 for other statuses.
- Checks `metadata.ssh_key_downloaded_at` — if set, returns 410 Gone: `{ error: "SSH key already downloaded" }`.
- Downloads private key from S3 via `sshKeyManager.downloadPrivateKey(id)`.
- Sets `metadata.ssh_key_downloaded_at` to now.
- Returns the key as `text/plain` with `Content-Type: text/plain`.

---

**`POST /api/remote/:id/ready`** — Callback from EC2 when user-data completes.

Request body:
```typescript
const readyBodySchema = z.object({
  instance_id: z.string(),
  public_ip: z.string().ip(),
  ssh_port: z.number().int().default(22),
  device_id: z.string().optional(),
});
```

- Validates status is `provisioning`. Returns 409 if already `ready` (idempotent — not an error, just a no-op).
- Updates status to `ready`, sets `public_ip`, `ready_at`, `device_id`.
- Broadcasts `remote.update` via WebSocket.
- Returns 200: `{ status: "ok" }`.

---

**`POST /api/remote/:id/error`** — Callback from EC2 when user-data fails.

Request body: `{ error: string, stage: string }`.

- Updates status to `error`, stores error + stage in metadata.
- Broadcasts `remote.update` via WebSocket.
- Returns 200.

---

**`POST /api/remote/:id/authorize-ip`** — Authorize an additional IP for SSH access.

Request body: `{ ip: string }`.

- Called by the CLI before `remote ssh` to add the user's IP to the security group.
- Calls `ec2Client.authorizeIngress(sgId, ip)` (the security group ID is stored in the remote_env record or looked up via `ensureSecurityGroup`).
- Returns 200.

### DB Query Helpers: `packages/server/src/db/remote-queries.ts`

```typescript
// Insert a new remote_env record with status 'provisioning'
export async function insertRemoteEnv(sql: postgres.Sql, params: InsertRemoteEnvParams): Promise<RemoteEnv>;

// Get a single remote_env by ID, with optional device join
export async function getRemoteEnv(sql: postgres.Sql, id: string): Promise<RemoteEnv | null>;

// List remote_envs with filters and cursor pagination
export async function listRemoteEnvs(sql: postgres.Sql, filters: RemoteEnvFilters): Promise<{
  remote_envs: RemoteEnv[];
  next_cursor: string | null;
  has_more: boolean;
}>;

// Update status with transition validation. Throws InvalidStatusTransitionError on illegal transition.
export async function updateRemoteEnvStatus(
  sql: postgres.Sql,
  id: string,
  newStatus: RemoteEnvStatus,
  extra?: Partial<RemoteEnvRow>,
): Promise<RemoteEnv>;

// Set instance details after EC2 launch
export async function updateRemoteEnvInstance(
  sql: postgres.Sql,
  id: string,
  instanceId: string,
  publicIp?: string,
): Promise<void>;

// Mark SSH key as downloaded (sets metadata.ssh_key_downloaded_at)
export async function markSshKeyDownloaded(sql: postgres.Sql, id: string): Promise<void>;

// Get all active remote_envs (for lifecycle enforcer)
export async function getActiveRemoteEnvs(sql: postgres.Sql): Promise<RemoteEnv[]>;

// Get remote_env by EC2 instance ID (for orphan detection)
export async function getRemoteEnvByInstanceId(sql: postgres.Sql, instanceId: string): Promise<RemoteEnv | null>;
```

### Status Transition Validation

Legal transitions (enforced by `updateRemoteEnvStatus`):
- `provisioning` → `ready`, `error`, `terminated`
- `ready` → `active`, `idle`, `error`, `terminated`
- `active` → `ready`, `idle`, `error`, `terminated`
- `idle` → `active`, `ready`, `error`, `terminated`
- `error` → `terminated`
- `terminated` → (terminal, no transitions out)

Illegal transitions throw `InvalidStatusTransitionError extends FuelCodeError`.

### Migration

Create `packages/server/src/db/migrations/NNNN_create_remote_envs.sql` following existing naming convention. This migration creates the `remote_envs` and `blueprints` tables from scratch (they do NOT exist in any prior migration). Include indexes on `remote_envs(status)`, `remote_envs(workspace_id)`, `remote_envs(device_id)`, and `remote_envs(instance_id)`.

> **IMPORTANT (Phase 1 Correction):** Phase 1's `sessions` table already has a `remote_env_id TEXT` column but with NO foreign key constraint. The Phase 1 schema comment reads: `"FK to remote_envs added in Phase 5 migration"`. This migration MUST include:
> ```sql
> ALTER TABLE sessions ADD CONSTRAINT fk_sessions_remote_env
>   FOREIGN KEY (remote_env_id) REFERENCES remote_envs(id);
> ```
> This must come AFTER the `CREATE TABLE remote_envs` statement.

> **NOTE:** There is no `infra/sql/schema.sql` file to reference. Define the complete table schema directly in the migration file based on the column specifications in the Phase 5 DAG.

### ApiClient Extension

Add remote methods to `packages/cli/src/lib/api-client.ts`:

```typescript
// In ApiClient class:
async provisionRemote(params: ProvisionParams): Promise<{ id: string; status: string }>;
async getRemoteEnvs(params?: RemoteEnvListParams): Promise<RemoteEnvListResponse>;
async getRemoteEnv(id: string): Promise<RemoteEnv>;
async terminateRemoteEnv(id: string, reason?: string): Promise<RemoteEnv>;
async getRemoteEnvSshKey(id: string): Promise<string>;  // returns raw key text
async authorizeRemoteIp(id: string, ip: string): Promise<void>;
```

### Relevant Files

**Create:**
- `packages/server/src/routes/remote.ts` (replace placeholder if exists)
- `packages/server/src/db/remote-queries.ts`
- `packages/server/src/routes/__tests__/remote.test.ts`
- `packages/server/src/db/__tests__/remote-queries.test.ts`
- `packages/server/src/db/migrations/NNNN_create_remote_envs.sql`

**Modify:**
- `packages/server/src/index.ts` — mount remote router: `app.use('/api/remote', authMiddleware, remoteRouter)`
- `packages/cli/src/lib/api-client.ts` — add remote environment methods

### Tests

`remote.test.ts` (bun:test, supertest against Express app with test DB):

1. `POST /api/remote` with valid body → 202, creates record with status=provisioning, returns id.
2. `POST /api/remote` with invalid blueprint → 400 with Zod validation errors.
3. `POST /api/remote` without auth → 401.
4. `GET /api/remote` → returns non-terminated remote envs.
5. `GET /api/remote?status=active` → filters by status.
6. `GET /api/remote?workspace_id=...` → filters by workspace.
7. `GET /api/remote?include_terminated=true` → includes terminated envs.
8. `GET /api/remote/:id` → returns full detail with computed fields.
9. `GET /api/remote/:id` with unknown id → 404.
10. `POST /api/remote/:id/terminate` → sets status=terminated, terminated_at, reason.
11. `POST /api/remote/:id/terminate` on already-terminated → 409.
12. `GET /api/remote/:id/ssh-key` → returns key as text/plain on first call.
13. `GET /api/remote/:id/ssh-key` second call → 410 Gone.
14. `GET /api/remote/:id/ssh-key` for provisioning env → 409.
15. `POST /api/remote/:id/ready` → transitions to ready, sets public_ip and ready_at.
16. `POST /api/remote/:id/ready` for already-ready env → 200 (idempotent no-op).
17. `POST /api/remote/:id/error` → transitions to error, stores error in metadata.
18. `POST /api/remote/:id/authorize-ip` → returns 200 (calls ec2Client.authorizeIngress).
19. Cursor pagination works correctly on list endpoint.
20. WebSocket `remote.update` broadcast fires on ready, terminate, and error transitions.

`remote-queries.test.ts` (bun:test):

1. `insertRemoteEnv` creates record with status=provisioning.
2. `getRemoteEnv` returns record by ID, null for unknown.
3. `listRemoteEnvs` filters by status, workspace_id.
4. `updateRemoteEnvStatus` with valid transition succeeds.
5. `updateRemoteEnvStatus` with invalid transition (terminated → ready) throws `InvalidStatusTransitionError`.
6. `markSshKeyDownloaded` sets metadata.ssh_key_downloaded_at.
7. `getActiveRemoteEnvs` returns only non-terminated, non-error envs.
8. `getRemoteEnvByInstanceId` returns record or null.
9. Migration creates both tables with correct columns and indexes.

### Success Criteria

1. All 8 API endpoints work with correct request/response shapes and status codes.
2. Status transitions are enforced — illegal transitions return 409.
3. SSH key endpoint returns key on first call, 410 Gone on subsequent calls.
4. Ready callback transitions to `ready` and records public_ip and device_id.
5. List endpoint supports filtering and cursor pagination.
6. All endpoints require auth.
7. Migration creates `remote_envs` and `blueprints` tables with indexes, and adds FK constraint on `sessions.remote_env_id` → `remote_envs(id)`.
8. `ApiClient` has matching methods for all endpoints.
9. WebSocket `remote.update` broadcasts on status changes.
10. DB query helpers enforce status transition rules at the data layer.
