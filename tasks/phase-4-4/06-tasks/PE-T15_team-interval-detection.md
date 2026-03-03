# Task 15: Team Detection — Extract Team Intervals from Content Blocks

## Phase: E — Team Detection
## Dependencies: T8
## Parallelizable With: None (T16 depends on this)

---

## Description

Implement Phase A of team detection (from design §6.1). After the main transcript is parsed and content_blocks are persisted, scan for `TeamCreate` and `TeamDelete` tool_use blocks to build team intervals. Insert into the `teams` table.

## Files

- **Modify**: `packages/core/src/session-pipeline.ts` (or `packages/core/src/reconcile/reconcile-session.ts`) — add team detection to `persistRelationships()` step
- **Create**: `packages/core/src/reconcile/team-detection.ts` — `extractTeamIntervals(contentBlocks): TeamInterval[]`, `persistTeams(sql, sessionId, intervals)`

## Key Implementation

```typescript
interface TeamInterval {
  teamName: string;
  description: string | null;
  createdAt: string;     // from the TeamCreate tool_use block's timestamp
  endedAt: string | null; // from the paired TeamDelete, or null if still active
}

function extractTeamIntervals(contentBlocks: ParsedContentBlock[]): TeamInterval[] {
  const creates = contentBlocks.filter(b => b.block_type === 'tool_use' && b.tool_name === 'TeamCreate');
  const deletes = contentBlocks.filter(b => b.block_type === 'tool_use' && b.tool_name === 'TeamDelete');
  // Pair creates with deletes by ordinal order
  // Build intervals
}
```

## How to Test

```bash
cd packages/core && bun test team-detection 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write unit tests:
- Content blocks with TeamCreate but no TeamDelete → open-ended interval
- Content blocks with TeamCreate + TeamDelete → closed interval
- Multiple teams created in same session
- TeamCreate → TeamDelete → TeamCreate (same name) → two intervals

## Success Criteria

1. `extractTeamIntervals` correctly pairs creates with deletes
2. Teams inserted into `teams` table with correct `session_id`
3. Compound unique constraint `(session_id, team_name, created_at)` handles re-creation
4. Team intervals have correct timestamps
5. Non-team sessions produce zero team rows
