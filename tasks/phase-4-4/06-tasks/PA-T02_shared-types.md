# Task 2: Shared Types — Lifecycle, Teammate, SessionSeed, SessionGap

## Phase: A — Foundation
## Dependencies: None
## Parallelizable With: T1, T3

---

## Description

Update and create shared types that the rest of the codebase will depend on. This includes the new `SessionLifecycle` union type, `Teammate` interface, `SessionSeed` interface, and `SessionGap` interface.

## Files

- **Modify**: `packages/shared/src/types/session.ts` — update `SessionLifecycle` type, remove `ParseStatus`, add `Teammate`, update `Session` interface (drop `parse_status`, `parse_error`, `team_name`, `team_role`; add `last_error`, `teammates?`)
- **Create**: `packages/shared/src/types/teammate.ts` — `Teammate`, `TeammateDetail`, `TeammateSummary` interfaces
- **Modify**: `packages/shared/src/types/team.ts` — update `Team` interface for new schema (session-scoped, add `session_id`, remove `lead_session_id`, add `teammates?`)
- **Create**: `packages/core/src/types/reconcile.ts` — `SessionSeed`, `SessionGap` interfaces
- **Modify**: `packages/shared/src/types/transcript.ts` — add `teammate_id` to `TranscriptMessage` and `ParsedContentBlock`
- **Modify**: `packages/shared/src/index.ts` — re-export new types

## Key Type Definitions

```typescript
// SessionLifecycle — new states
type SessionLifecycle = 'detected' | 'ended' | 'transcript_ready' | 'parsed' | 'summarized' | 'complete' | 'failed';

// Teammate — new entity
interface Teammate {
  id: string;
  team_id: string;
  session_id: string;
  name: string;
  cc_teammate_id: string | null;
  color: string | null;
  summary: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

// SessionSeed — normalized input for reconcile
interface SessionSeed {
  ccSessionId: string;
  origin: 'hook' | 'backfill' | 'recovery';
  workspaceCanonicalId: string;
  deviceId: string;
  cwd: string;
  gitBranch: string | null;
  gitRemote: string | null;
  model: string | null;
  ccVersion: string | null;
  source: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  endReason: string | null;
  transcriptRef: { type: 'disk'; path: string } | { type: 's3'; key: string } | null;
  isLive: boolean;
}

// SessionGap — what the reconciler needs to do
interface SessionGap {
  needsTranscriptUpload: boolean;
  needsParsing: boolean;
  needsSubagentParsing: boolean;
  needsTeamDetection: boolean;
  needsStats: boolean;
  needsSummary: boolean;
  needsTeammateSummaries: boolean;
  needsLifecycleAdvance: boolean;
  staleStartedAt: boolean;
  staleDurationMs: boolean;
  staleSubagentCount: boolean;
}
```

## How to Test

```bash
# Type-check the monorepo
cd packages/shared && bun run typecheck
cd packages/core && bun run typecheck
```

## Success Criteria

1. All new types compile without errors
2. No downstream compile errors from removing `parse_status`/`parse_error` from `Session` (compile errors are expected and will be fixed in Tasks 3–5)
3. `SessionSeed` captures all data needed from both hooks and backfill
4. `SessionGap` covers every step in the reconcile pipeline
5. `Teammate` type matches the DB schema from Task 1
