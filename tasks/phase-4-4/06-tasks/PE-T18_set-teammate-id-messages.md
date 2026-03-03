# Task 18: Set `teammate_id` on transcript_messages + content_blocks

## Phase: E — Team Detection
## Dependencies: T16, T17
## Parallelizable With: None

---

## Description

When persisting subagent transcript messages and content blocks, set the `teammate_id` FK alongside `subagent_id`. This enables the stitched message feed query.

## Files

- **Modify**: `packages/core/src/session-pipeline.ts` — update `batchInsertMessages` and `batchInsertContentBlocks` to accept and insert `teammate_id`
- **Modify**: `packages/core/src/reconcile/reconcile-session.ts` — pass `teammateId` through subagent transcript parsing

## Key Changes

Current batch insert for messages has columns like:
```sql
INSERT INTO transcript_messages (id, session_id, subagent_id, ...)
```

Add `teammate_id` to the column list:
```sql
INSERT INTO transcript_messages (id, session_id, subagent_id, teammate_id, ...)
```

For main transcript messages: both `subagent_id` and `teammate_id` are NULL.
For subagent messages: `subagent_id` is set; `teammate_id` is set if the subagent is team-affiliated.

## How to Test

```bash
cd packages/core && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Verify FK integrity
psql $DATABASE_URL -c "
  SELECT COUNT(*) FROM transcript_messages
  WHERE teammate_id IS NOT NULL
    AND teammate_id NOT IN (SELECT id FROM teammates)
"
# Should return 0
```

## Success Criteria

1. `teammate_id` column populated on transcript_messages for team subagent messages
2. `teammate_id` column populated on content_blocks for team subagent blocks
3. Main transcript messages have `teammate_id = NULL`
4. Non-team subagent messages have `teammate_id = NULL`
5. FK integrity maintained (no orphaned teammate_id values)
