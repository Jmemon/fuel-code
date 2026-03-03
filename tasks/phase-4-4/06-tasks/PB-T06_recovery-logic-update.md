# Task 6: Recovery Logic — Drop `parse_status`, Use `lifecycle + updated_at`

## Phase: B — Lifecycle State Machine
## Dependencies: T4
## Parallelizable With: None

---

## Description

Update `session-recovery.ts` to use the simplified stuck-session detection. With `parse_status` gone, stuck sessions are found purely by `lifecycle = 'transcript_ready' AND updated_at < threshold`.

## Files

- **Modify**: `packages/core/src/session-recovery.ts` — rewrite both recovery functions
- **Modify**: `packages/server/src/index.ts` — update startup recovery call if needed (states may be referenced in log messages)

## Key Changes

**`recoverStuckSessions`**:
- Current: `lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing') AND updated_at < threshold`
- New: `lifecycle = 'transcript_ready' AND updated_at < threshold`
- Recovery action: if `transcript_s3_key` exists, enqueue reconcile; if not, `failSession`

**`recoverUnsummarizedSessions`**:
- Current: `lifecycle = 'parsed' AND parse_status = 'completed' AND summary IS NULL AND updated_at < threshold`
- New: `lifecycle = 'parsed' AND summary IS NULL AND updated_at < threshold`
- Recovery action: `resetSessionForReparse` then enqueue pipeline

## How to Test

```bash
cd packages/core && bun test session-recovery 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. No `parse_status` references in recovery code
2. Stuck session detection uses `lifecycle = 'transcript_ready'`
3. Unsummarized detection uses `lifecycle = 'parsed' AND summary IS NULL`
4. Recovery correctly enqueues sessions for re-processing
5. Recovery handles the case where `transcript_s3_key` is missing (→ failSession)
