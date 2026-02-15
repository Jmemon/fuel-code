# Task 7: Workspace Resolver and Device Resolver

## Parallel Group: D

## Description

Implement the core domain functions that ensure workspaces and devices exist in Postgres before events reference them. These are upsert operations called by the event processor for every incoming event. They also create `workspace_devices` junction records.

These live in `packages/core/` — pure domain logic with injected database dependency. No HTTP, no CLI, no UI knowledge.

### Dependencies to install
```bash
cd packages/core && bun add postgres pino
```

### Files to Create

**`packages/core/src/workspace-resolver.ts`**:

```typescript
/**
 * Workspace resolution: given a canonical ID string from an event,
 * ensure the workspace exists in Postgres and return its ULID.
 *
 * IMPORTANT: Events arrive with workspace_id as a canonical string
 * (e.g., "github.com/user/repo"). The resolver translates this to
 * a Postgres ULID. All downstream references use the ULID.
 */
```

- `resolveOrCreateWorkspace(sql: Sql, canonicalId: string, hints?: { default_branch?: string; all_remotes?: string[] }): Promise<string>`:
  - If `canonicalId` is empty: use `_unassociated`.
  - Compute `displayName` from `canonicalId` via `deriveDisplayName()` from `@fuel-code/shared`.
  - Execute:
    ```sql
    INSERT INTO workspaces (id, canonical_id, display_name, default_branch, metadata)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (canonical_id) DO UPDATE SET updated_at = now()
    RETURNING id
    ```
  - The `id` is a fresh ULID (only used if inserting). On conflict, the RETURNING still gives back the existing id.
  - Hints: if `default_branch` or `all_remotes` are provided, they go into the INSERT. On conflict, do NOT overwrite them (the first-seen values are kept).
  - Return the workspace `id` (ULID).

- `getWorkspaceByCanonicalId(sql: Sql, canonicalId: string): Promise<Workspace | null>`:
  - `SELECT * FROM workspaces WHERE canonical_id = $1`

- `getWorkspaceById(sql: Sql, id: string): Promise<Workspace | null>`:
  - `SELECT * FROM workspaces WHERE id = $1`

**`packages/core/src/device-resolver.ts`**:

- `resolveOrCreateDevice(sql: Sql, deviceId: string, hints?: { name?: string; type?: DeviceType; hostname?: string; os?: string; arch?: string }): Promise<string>`:
  - The device ID is client-generated (by `fuel-code init`), so it's always provided.
  - Default name: `hints.name || "unknown-device"`.
  - Default type: `hints.type || "local"`.
  - Execute:
    ```sql
    INSERT INTO devices (id, name, type, hostname, os, arch, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      last_seen_at = now(),
      hostname = COALESCE(EXCLUDED.hostname, devices.hostname),
      os = COALESCE(EXCLUDED.os, devices.os),
      arch = COALESCE(EXCLUDED.arch, devices.arch)
    RETURNING id
    ```
  - On conflict: update `last_seen_at` and fill in any previously-null fields, but do not overwrite existing values.
  - Return the device `id`.

- `updateDeviceLastSeen(sql: Sql, deviceId: string): Promise<void>`:
  - `UPDATE devices SET last_seen_at = now() WHERE id = $1`

**`packages/core/src/workspace-device-link.ts`**:

- `ensureWorkspaceDeviceLink(sql: Sql, workspaceId: string, deviceId: string, localPath: string): Promise<void>`:
  - ```sql
    INSERT INTO workspace_devices (workspace_id, device_id, local_path)
    VALUES ($1, $2, $3)
    ON CONFLICT (workspace_id, device_id) DO UPDATE SET
      last_active_at = now(),
      local_path = EXCLUDED.local_path
    ```
  - `localPath` comes from `event.data.cwd` if available, otherwise `"unknown"`.

**`packages/core/src/index.ts`**: re-export all resolvers.

### Tests

**`packages/core/src/__tests__/workspace-resolver.test.ts`** (requires test Postgres):
- `resolveOrCreateWorkspace` with new canonical ID creates a row. Returns a ULID.
- Calling again with same canonical ID returns the SAME ULID (idempotent).
- Calling updates `updated_at` timestamp.
- `getWorkspaceByCanonicalId` returns the workspace after creation.
- `_unassociated` canonical ID is handled (creates a workspace for it).

**`packages/core/src/__tests__/device-resolver.test.ts`** (requires test Postgres):
- `resolveOrCreateDevice` with new device ID creates a row.
- Calling again updates `last_seen_at` but preserves name/type.
- COALESCE behavior: if hostname was NULL on first insert and provided on second, it's filled in.

## Relevant Files
- `packages/core/src/workspace-resolver.ts` (create)
- `packages/core/src/device-resolver.ts` (create)
- `packages/core/src/workspace-device-link.ts` (create)
- `packages/core/src/index.ts` (modify — add re-exports)
- `packages/core/src/__tests__/workspace-resolver.test.ts` (create)
- `packages/core/src/__tests__/device-resolver.test.ts` (create)

## Success Criteria
1. `resolveOrCreateWorkspace(sql, "github.com/user/repo")` creates a workspace with `display_name = "repo"` and returns a ULID.
2. Calling again with the same canonical ID returns the same ULID, not a new one.
3. `resolveOrCreateWorkspace(sql, "_unassociated")` works (doesn't crash on the special value).
4. `resolveOrCreateDevice(sql, someUlid, { name: "macbook" })` creates a device row.
5. Calling again with the same ID updates `last_seen_at` but does not overwrite `name`.
6. `ensureWorkspaceDeviceLink` creates a junction row on first call, updates `last_active_at` on subsequent calls.
7. All functions are idempotent — calling N times produces the same result as calling once.
8. Workspace `display_name` derivation: `github.com/user/fuel-code` → `fuel-code`.
9. Empty canonical ID is treated as `_unassociated`.
10. COALESCE works: device with `hostname = NULL` on first insert gets hostname filled in on second call with hostname provided.
