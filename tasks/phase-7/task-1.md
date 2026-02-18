# Task 1: Change Request Entity + DB Migration

## Parallel Group: A

## Dependencies: None (Phase 5 must be complete as a cross-phase prerequisite)

## Description

Create the Change Request entity — types, Zod schemas, DB migration, and core CRUD queries. The Change Request is the orchestration record that tracks a code change from Slack message to merged branch. It references existing entities (Workspace, Session, Device/RemoteEnv) and has its own lifecycle state machine.

### DB Migration

**`packages/server/src/db/migrations/NNN_change_requests.sql`**:

> **Note:** Migration number is illustrative. Use the next available sequential number based on what exists in `packages/server/src/db/migrations/` at implementation time. All migrations live in `packages/server/src/db/migrations/`, NOT in `infra/sql/` (that directory does not exist).

```sql
-- Change Request: orchestration record for Slack-triggered code changes
CREATE TABLE change_requests (
  id TEXT PRIMARY KEY,                          -- ULID
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),

  -- Source of the request
  source TEXT NOT NULL DEFAULT 'slack',         -- 'slack' | 'api' (future)
  requester_id TEXT,                            -- Slack user ID or API caller
  requester_name TEXT,                          -- Human-readable name
  request_text TEXT NOT NULL,                   -- The change description

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending',         -- Request received, not yet started
      'provisioning',    -- Remote environment being provisioned
      'implementing',    -- Claude Code running on remote
      'deployed',        -- Preview URL available, awaiting approval
      'approved',        -- User approved, merge in progress
      'merging',         -- Git merge/push in progress
      'merged',          -- Successfully merged to target branch
      'rejected',        -- User rejected the change
      'failed'           -- Something went wrong (see error field)
    )),

  -- Linked resources
  remote_env_id TEXT REFERENCES remote_envs(id),  -- The provisioned EC2 instance
  session_id TEXT REFERENCES sessions(id),          -- The CC session that made the change
  branch_name TEXT,                                  -- e.g., 'change/add-loading-spinner'
  preview_url TEXT,                                  -- e.g., 'http://54.123.45.67:3000'
  preview_port INTEGER DEFAULT 3000,                 -- Port the app runs on for preview

  -- Slack context
  slack_channel_id TEXT,
  slack_thread_ts TEXT,                              -- Thread timestamp for updates
  slack_message_ts TEXT,                              -- Interactive message timestamp

  -- Merge info
  target_branch TEXT DEFAULT 'main',                  -- Branch to merge into
  merge_commit_sha TEXT,                              -- SHA after merge

  -- Error tracking
  error TEXT,                                         -- Error message if failed

  -- Deduplication
  idempotency_key TEXT UNIQUE,                        -- Slack event_id for dedup

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ                            -- When merged/rejected/failed
);

-- Indexes for common queries
CREATE INDEX idx_change_requests_workspace ON change_requests(workspace_id);
CREATE INDEX idx_change_requests_status ON change_requests(status);
CREATE INDEX idx_change_requests_remote_env ON change_requests(remote_env_id);
CREATE INDEX idx_change_requests_created ON change_requests(created_at DESC);
CREATE INDEX idx_change_requests_idempotency ON change_requests(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Add change_request_id to remote_envs to link back
ALTER TABLE remote_envs ADD COLUMN change_request_id TEXT REFERENCES change_requests(id);
CREATE INDEX idx_remote_envs_change_request ON remote_envs(change_request_id) WHERE change_request_id IS NOT NULL;
```

### Types

**`packages/shared/src/types/change-request.ts`**:

```typescript
// Change Request lifecycle states
export type ChangeRequestStatus =
  | 'pending'
  | 'provisioning'
  | 'implementing'
  | 'deployed'
  | 'approved'
  | 'merging'
  | 'merged'
  | 'rejected'
  | 'failed';

// Change Request entity
export interface ChangeRequest {
  id: string;
  workspace_id: string;
  source: 'slack' | 'api';
  requester_id: string | null;
  requester_name: string | null;
  request_text: string;
  status: ChangeRequestStatus;
  remote_env_id: string | null;
  session_id: string | null;
  branch_name: string | null;
  preview_url: string | null;
  preview_port: number;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  slack_message_ts: string | null;
  target_branch: string;
  merge_commit_sha: string | null;
  error: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// Valid status transitions
export const CHANGE_REQUEST_TRANSITIONS: Record<ChangeRequestStatus, ChangeRequestStatus[]> = {
  pending:        ['provisioning', 'failed'],
  provisioning:   ['implementing', 'failed'],
  implementing:   ['deployed', 'failed'],
  deployed:       ['approved', 'rejected', 'failed'],
  approved:       ['merging', 'failed'],
  merging:        ['merged', 'failed'],
  merged:         [],              // terminal
  rejected:       [],              // terminal
  failed:         ['pending'],     // allow retry from failed
};
```

### Zod Schemas

**`packages/shared/src/schemas/change-request.ts`**:

```typescript
import { z } from 'zod';

// Schema for creating a change request via API
export const createChangeRequestSchema = z.object({
  workspace_id: z.string().min(1),
  request_text: z.string().min(1).max(10000),
  source: z.enum(['slack', 'api']).default('api'),
  requester_id: z.string().optional(),
  requester_name: z.string().optional(),
  target_branch: z.string().default('main'),
  preview_port: z.number().int().min(1).max(65535).default(3000),
  slack_channel_id: z.string().optional(),
  slack_thread_ts: z.string().optional(),
  idempotency_key: z.string().optional(),
});

// Schema for change request event payloads
export const changeRequestEventSchema = z.object({
  change_request_id: z.string(),
  status: z.string(),
  workspace_id: z.string(),
  // Optional fields present in specific events
  preview_url: z.string().optional(),
  branch_name: z.string().optional(),
  error: z.string().optional(),
  merge_commit_sha: z.string().optional(),
});
```

### Event Types

Register new event types in two places:

**1. `packages/shared/src/types/event.ts`** (modify — add to `EVENT_TYPES` array and `EventType` union):

> **IMPORTANT (Phase 1 correction):** Phase 1 defines `EVENT_TYPES` as a closed array of 14 string literals and derives `EventType` from it. You MUST add all 7 `change.*` types to this array, otherwise event validation will reject them.

```typescript
// Add to the EVENT_TYPES array in packages/shared/src/types/event.ts:
'change.requested',
'change.implementing',
'change.deployed',
'change.approved',
'change.rejected',
'change.merged',
'change.failed',
```

**2. `packages/shared/src/schemas/events.ts`** (modify — add payload schemas):

```typescript
// Change request events (Phase 7)
'change.requested'     // Slack/API request received, CR created
'change.implementing'  // CC session started on remote
'change.deployed'      // Preview URL available
'change.approved'      // User approved the change
'change.rejected'      // User rejected the change
'change.merged'        // Branch merged to target
'change.failed'        // Something went wrong
```

Also register the `changeRequestEventSchema` in the payload registry (`packages/shared/src/schemas/payload-registry.ts`) for all 7 event types.

### Core CRUD Queries

**`packages/core/src/change-request-queries.ts`**:

```typescript
import type { ChangeRequest, ChangeRequestStatus } from '@fuel-code/shared';

export interface ChangeRequestQueries {
  // Create a new change request. Returns the created record.
  // Uses idempotency_key for dedup — if key exists, returns existing record.
  create(data: CreateChangeRequestInput): Promise<ChangeRequest>;

  // Get a change request by ID. Returns null if not found.
  getById(id: string): Promise<ChangeRequest | null>;

  // List change requests with optional filters.
  list(filters?: {
    workspace_id?: string;
    status?: ChangeRequestStatus | ChangeRequestStatus[];
    limit?: number;
    cursor?: string;
  }): Promise<{ items: ChangeRequest[]; nextCursor: string | null }>;

  // Transition status with optimistic locking.
  // Returns { success: true } or { success: false, reason: string }.
  transition(
    id: string,
    fromStatus: ChangeRequestStatus | ChangeRequestStatus[],
    toStatus: ChangeRequestStatus,
    updates?: Partial<Pick<ChangeRequest,
      'remote_env_id' | 'session_id' | 'branch_name' | 'preview_url' |
      'merge_commit_sha' | 'error' | 'slack_message_ts' | 'completed_at'
    >>
  ): Promise<{ success: boolean; reason?: string }>;

  // Get change request by idempotency key (for Slack dedup).
  getByIdempotencyKey(key: string): Promise<ChangeRequest | null>;
}

export function createChangeRequestQueries(sql: postgres.Sql): ChangeRequestQueries;
```

### Tests

**`packages/core/src/__tests__/change-request-queries.test.ts`** (requires Postgres):

1. `create` inserts a change request with status 'pending'.
2. `create` with same idempotency_key returns existing record (dedup).
3. `getById` returns the full record.
4. `getById` with invalid ID returns null.
5. `list` returns change requests in created_at DESC order.
6. `list` with status filter works.
7. `list` with cursor-based pagination works.
8. `transition` from 'pending' to 'provisioning' succeeds.
9. `transition` from wrong status fails with reason.
10. `transition` to 'merged' sets completed_at.
11. `transition` to 'failed' sets error field.
12. Concurrent transitions: only one succeeds (optimistic locking).

## Relevant Files
- `packages/server/src/db/migrations/NNN_change_requests.sql` (create — use next available number)
- `packages/shared/src/types/change-request.ts` (create)
- `packages/shared/src/types/event.ts` (modify — add 7 `change.*` types to `EVENT_TYPES` array)
- `packages/shared/src/schemas/change-request.ts` (create)
- `packages/shared/src/schemas/events.ts` (modify — add change.* payload schemas)
- `packages/shared/src/schemas/payload-registry.ts` (modify — register change.* payload validators)
- `packages/shared/src/index.ts` (modify — re-export)
- `packages/core/src/change-request-queries.ts` (create)
- `packages/core/src/__tests__/change-request-queries.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export)

## Success Criteria
1. Migration creates `change_requests` table with all columns and indexes (in `packages/server/src/db/migrations/`).
2. `remote_envs` table has new `change_request_id` column with FK reference.
3. All Change Request types and Zod schemas are exported from `@fuel-code/shared`.
4. CRUD queries handle create, read, list with pagination, and status transitions.
5. Idempotency key prevents duplicate change requests.
6. Status transitions use optimistic locking (UPDATE ... WHERE status = $expected).
7. Invalid transitions return `{ success: false, reason }` without throwing.
8. All 7 `change.*` event types are added to the `EVENT_TYPES` array in `packages/shared/src/types/event.ts` so they pass event validation.
9. All 7 `change.*` payload schemas are registered in the payload registry.
10. Terminal states (merged, rejected) have no outgoing transitions.
11. Failed state allows retry (transition back to pending).
