# Task 29: Cleanup — Remove Dead Code (`capturing`, Old Pipeline Triggers)

## Phase: H — Cleanup + Tests
## Dependencies: All Phase G tasks
## Parallelizable With: T30

---

## Description

Remove all references to the `capturing` lifecycle state and consolidate pipeline trigger logic. Currently the pipeline can be triggered from 4 scattered locations — after this cleanup, all entry points funnel through `enqueueReconcile`.

## Files

- **Modify**: `packages/core/src/session-lifecycle.ts` — remove `capturing` from any comments or documentation
- **Modify**: `packages/core/src/handlers/session-end.ts` — remove `capturing` from transition arrays
- **Modify**: `packages/core/src/session-pipeline.ts` — remove `runSessionPipeline` export (replaced by `reconcileSession`); keep `createPipelineQueue` but it now calls `reconcileSession`
- **Modify**: `packages/server/src/routes/transcript-upload.ts` — remove direct `runSessionPipeline` fallback (always use queue)
- **Modify**: `packages/server/src/routes/session-actions.ts` — reparse uses `enqueueReconcile`
- **Modify**: Various test files — remove `capturing` state references

## How to Test

```bash
# Grep for dead references
grep -r "capturing" packages/ --include="*.ts" | grep -v node_modules | grep -v ".test."
grep -r "runSessionPipeline" packages/ --include="*.ts" | grep -v node_modules
# Both should return 0 results (except re-exports for backwards compat if needed)

bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

## Success Criteria

1. No runtime references to `capturing` state
2. No direct `runSessionPipeline` calls (all go through `reconcileSession`)
3. Pipeline trigger consolidated to `enqueueReconcile` at all entry points
4. All tests pass
