# Task 16: Teammate Identification from Agent Tool Results

## Phase: E — Team Detection
## Dependencies: T15
## Parallelizable With: None

---

## Description

Implement Phase B of team detection (from design §6.2). When the lead session spawns teammates via the `Agent` tool with `team_name`, the tool_result contains `teammate_spawned` status. Extract teammate names and create `teammates` rows.

## Files

- **Modify**: `packages/core/src/reconcile/team-detection.ts` — add `extractTeammates(contentBlocks, teams): ParsedTeammate[]`, `persistTeammates(sql, sessionId, teammates)`
- **Modify**: `packages/core/src/transcript-parser.ts` — ensure `Agent` tool_result data (teammate_id, team_name, status) is preserved in content_blocks

## Key Implementation

```typescript
interface ParsedTeammate {
  teamName: string;
  name: string;           // e.g., "alice"
  ccTeammateId: string;   // e.g., "alice@ping-pong"
  color: string | null;
}

function extractTeammates(contentBlocks: ParsedContentBlock[], teams: TeamRow[]): ParsedTeammate[] {
  return contentBlocks
    .filter(b => b.block_type === 'tool_result' && /* corresponding tool_use is 'Agent' */)
    .map(b => {
      const result = JSON.parse(b.result_text ?? '{}');
      if (result.status !== 'teammate_spawned') return null;
      return {
        teamName: result.team_name,
        name: result.teammate_id?.split('@')[0] ?? result.agent_id,
        ccTeammateId: result.teammate_id ?? result.agent_id,
        color: null,  // CC doesn't provide color in tool result
      };
    })
    .filter(Boolean)
    .filter((t, i, arr) => arr.findIndex(x => x.ccTeammateId === t.ccTeammateId) === i); // dedup
}
```

## How to Test

```bash
cd packages/core && bun test team-detection 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Teammates extracted from Agent tool results with `teammate_spawned` status
2. Each unique teammate gets one row in `teammates` table
3. `teammate.team_id` correctly references the parent team
4. `teammate.cc_teammate_id` stores the full `"name@team"` identifier
5. Duplicate teammate spawns (same agent re-spawned) produce one row
