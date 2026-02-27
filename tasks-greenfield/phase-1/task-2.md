# Task 2: Shared Types, Zod Schemas, and Utilities

## Parallel Group: B

## Description

Build the `@fuel-code/shared` package — the contract layer every other package imports. Contains: TypeScript types for all 5 abstractions, Zod validation schemas for Phase 1 event payloads, ULID generation utility, git remote URL normalization, and a structured error hierarchy.

### Dependencies to install
```bash
cd packages/shared && bun add zod ulidx
```

### Files to Create

**`packages/shared/src/types/event.ts`**:
- `EventType` — string union of all 14 event types from CORE.md: `"session.start" | "session.end" | "session.compact" | "git.commit" | "git.push" | "git.checkout" | "git.merge" | "remote.provision.start" | "remote.provision.ready" | "remote.provision.error" | "remote.terminate" | "system.device.register" | "system.hooks.installed" | "system.heartbeat"`. Include ALL types (not just Phase 1) because the enum is the source of truth and the ingest endpoint must accept future event types.
- `EVENT_TYPES` — array of all EventType values (for runtime validation)
- `BlobRef` — `{ key: string; content_type: string; size_bytes: number }`
- `Event` interface — exactly as CORE.md lines 76-92: `id`, `type`, `timestamp`, `device_id`, `workspace_id`, `session_id` (nullable), `data` (Record<string, unknown>), `ingested_at` (nullable), `blob_refs` (BlobRef[])
- `IngestRequest` — `{ events: Event[] }`
- `IngestResponse` — `{ ingested: number; duplicates: number; rejected?: number; errors?: Array<{ index: number; error: string }> }`

**`packages/shared/src/types/workspace.ts`**:
- `Workspace` interface matching CORE.md Postgres schema: `id`, `canonical_id`, `display_name`, `default_branch` (nullable), `metadata`, `first_seen_at`, `updated_at`
- `UNASSOCIATED_WORKSPACE = "_unassociated"` constant

**`packages/shared/src/types/device.ts`**:
- `DeviceType` — `"local" | "remote"`
- `DeviceStatus` — `"online" | "offline" | "provisioning" | "terminated"`
- `Device` interface matching Postgres schema

**`packages/shared/src/types/session.ts`**:
- `SessionLifecycle` — `"detected" | "capturing" | "ended" | "parsed" | "summarized" | "archived" | "failed"`
- `ParseStatus` — `"pending" | "parsing" | "completed" | "failed"`
- `Session` interface matching Postgres schema

**`packages/shared/src/types/index.ts`**: barrel re-export all type files

**`packages/shared/src/schemas/event-base.ts`**:
- `blobRefSchema` — Zod object for BlobRef
- `eventSchema` — Zod object validating Event structure. `id` validated with regex `^[0-9A-HJKMNP-TV-Z]{26}$` (ULID format). `type` validated as `z.enum(EVENT_TYPES)`. `timestamp` as `z.string().datetime()`. `device_id` as `z.string().min(1)`. `workspace_id` as `z.string().min(1)`. `session_id` as `z.string().nullable()`. `data` as `z.record(z.unknown())` (permissive at envelope level). `blob_refs` as `z.array(blobRefSchema).default([])`.
- `ingestRequestSchema` — `z.object({ events: z.array(eventSchema).min(1).max(100) })`. Max 100 events per batch.

**`packages/shared/src/schemas/session-start.ts`**:
- `sessionStartPayloadSchema` — Zod object for `SessionStartPayload` per CORE.md:
  - `cc_session_id`: `z.string().min(1)`
  - `cwd`: `z.string().min(1)`
  - `git_branch`: `z.string().nullable()`
  - `git_remote`: `z.string().nullable()`
  - `cc_version`: `z.string()`
  - `model`: `z.string().nullable()`
  - `source`: `z.enum(["startup", "resume", "clear", "compact"])`
  - `transcript_path`: `z.string()`

**`packages/shared/src/schemas/session-end.ts`**:
- `sessionEndPayloadSchema`:
  - `cc_session_id`: `z.string().min(1)`
  - `duration_ms`: `z.number().int().nonneg()`
  - `end_reason`: `z.enum(["exit", "clear", "logout", "crash"])`
  - `transcript_path`: `z.string()`

**`packages/shared/src/schemas/payload-registry.ts`**:
- `PAYLOAD_SCHEMAS`: `Partial<Record<EventType, z.ZodSchema>>` mapping event types to their payload schemas. Phase 1 registers `session.start` and `session.end`. Unregistered types have no schema (accepted with permissive `z.record(z.unknown())`).
- `validateEventPayload(type: EventType, data: unknown): { success: true; data: unknown } | { success: false; error: z.ZodError }` — looks up registry, validates if schema exists, passes through if no schema.

**`packages/shared/src/schemas/index.ts`**: barrel re-export

**`packages/shared/src/ulid.ts`**:
- `import { ulid, decodeTime } from "ulidx"`
- `generateId(): string` — returns `ulid()`. Wrapper for consistent import path.
- `isValidUlid(id: string): boolean` — regex `^[0-9A-HJKMNP-TV-Z]{26}$`
- `extractTimestamp(id: string): Date` — `new Date(decodeTime(id))`

**`packages/shared/src/canonical.ts`**:
- `normalizeGitRemote(remoteUrl: string): string | null`:
  Normalization rules (from CORE.md):
  1. Strip protocol: `https://`, `http://`, `ssh://`, `git://`
  2. Strip auth prefix: everything before `@` in SCP-style URLs (e.g., `git@`)
  3. Replace `:` with `/` for SCP-style (e.g., `github.com:user/repo` → `github.com/user/repo`)
  4. Strip `.git` suffix
  5. Lowercase the host portion only (first segment before `/`). Path case preserved.
  6. Trim trailing slashes
  7. Return `null` if input is empty or unparseable (no throw)

- `deriveWorkspaceCanonicalId(remoteUrl: string | null, firstCommitHash: string | null): string`:
  - If `remoteUrl` non-null/non-empty: return `normalizeGitRemote(remoteUrl)` (falling back to `_unassociated` if normalization returns null)
  - If no remote but `firstCommitHash` provided: return `local:<sha256(firstCommitHash)>`
  - If both null: return `_unassociated`

- `deriveDisplayName(canonicalId: string): string`:
  - `_unassociated` → `_unassociated`
  - `local:abc123...` → `local-abc12345` (first 8 hex chars)
  - `github.com/user/repo` → `repo` (last path segment)

**`packages/shared/src/errors.ts`**:
- `FuelCodeError` extends `Error` — adds `code: string` and `context: Record<string, unknown>`. Serializable to JSON.
- `ConfigError` (code `CONFIG_*`) — config file missing, corrupted, invalid
- `NetworkError` (code `NETWORK_*`) — HTTP failures, timeouts, DNS errors
- `ValidationError` (code `VALIDATION_*`) — Zod validation failures
- `StorageError` (code `STORAGE_*`) — Postgres/Redis/S3 failures

**`packages/shared/src/index.ts`**: barrel re-export all types, schemas, utils, and errors

### Tests to Create

**`packages/shared/src/__tests__/canonical.test.ts`**:
Test at least these cases:
- `git@github.com:user/repo.git` → `github.com/user/repo`
- `https://github.com/user/repo.git` → `github.com/user/repo`
- `ssh://git@github.com/user/repo` → `github.com/user/repo`
- `https://GITHUB.COM/User/Repo.git` → `github.com/User/Repo` (host lowered, path preserved)
- `git@github.company.com:org/repo.git` → `github.company.com/org/repo` (enterprise)
- `""` → `null` (empty input)
- `"not-a-url"` → `null`
- URL with trailing slash: `https://github.com/user/repo/` → `github.com/user/repo`
- `deriveDisplayName("github.com/user/fuel-code")` → `"fuel-code"`
- `deriveDisplayName("_unassociated")` → `"_unassociated"`
- `deriveWorkspaceCanonicalId(null, null)` → `"_unassociated"`

**`packages/shared/src/__tests__/schemas.test.ts`**:
- Valid event passes `eventSchema.parse()`
- Event with invalid ULID id fails
- Valid `session.start` payload passes `sessionStartPayloadSchema.parse()`
- `session.start` payload missing `cwd` fails
- `ingestRequestSchema` rejects empty events array
- `ingestRequestSchema` rejects >100 events
- `validateEventPayload("session.start", validData)` returns `{ success: true }`
- `validateEventPayload("git.commit", anyData)` returns `{ success: true }` (no schema registered, passthrough)

## Relevant Files
- `packages/shared/src/types/event.ts` (create)
- `packages/shared/src/types/workspace.ts` (create)
- `packages/shared/src/types/device.ts` (create)
- `packages/shared/src/types/session.ts` (create)
- `packages/shared/src/types/index.ts` (create)
- `packages/shared/src/schemas/event-base.ts` (create)
- `packages/shared/src/schemas/session-start.ts` (create)
- `packages/shared/src/schemas/session-end.ts` (create)
- `packages/shared/src/schemas/payload-registry.ts` (create)
- `packages/shared/src/schemas/index.ts` (create)
- `packages/shared/src/ulid.ts` (create)
- `packages/shared/src/canonical.ts` (create)
- `packages/shared/src/errors.ts` (create)
- `packages/shared/src/index.ts` (modify)
- `packages/shared/src/__tests__/canonical.test.ts` (create)
- `packages/shared/src/__tests__/schemas.test.ts` (create)

## Success Criteria
1. `import { Event, EventType, Workspace, Device, Session, generateId, normalizeGitRemote, eventSchema, ingestRequestSchema } from "@fuel-code/shared"` compiles and resolves.
2. `generateId()` returns a 26-character ULID string. `isValidUlid(generateId())` is `true`.
3. `normalizeGitRemote("git@github.com:user/repo.git")` returns `"github.com/user/repo"`.
4. `normalizeGitRemote("")` returns `null` (does not throw).
5. `eventSchema.parse(validEvent)` succeeds. `eventSchema.parse({})` throws ZodError.
6. `ingestRequestSchema.parse({ events: [] })` throws (min 1). Array of 101 events throws (max 100).
7. `sessionStartPayloadSchema.parse(validPayload)` succeeds. Missing `cwd` throws.
8. `validateEventPayload("session.start", validData)` returns `{ success: true, data: ... }`.
9. `validateEventPayload("git.commit", {})` returns `{ success: true }` (no schema, passthrough).
10. `FuelCodeError` instances have `code` and `context` properties, and `JSON.stringify` works.
11. `bun test packages/shared` passes all tests (canonical + schemas).
12. EventType enum contains all 14 event types from CORE.md.
