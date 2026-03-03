# Task 17: Map Subagents to Teammates During Subagent Transcript Parsing

## Phase: E — Team Detection
## Dependencies: T16
## Parallelizable With: T18

---

## Description

Implement Phase C of team detection (from design §6.3). When parsing subagent transcripts, identify which teammate each subagent belongs to by examining `routing.sender` in SendMessage results and `teamName` fields.

## Files

- **Modify**: `packages/core/src/session-pipeline.ts` (or reconcile-session.ts) — update `parseSubagentTranscripts` to set `teammate_id` on subagent rows
- **Create**: `packages/core/src/reconcile/teammate-mapping.ts` — `extractTeammateName(parseResult)`, `extractTeamName(parseResult)`, `resolveTeammateId(sql, sessionId, teammateName, teamName)`

## Key Implementation

From design §6.4:
- Method 1: `routing.sender` from SendMessage tool results in the subagent's content_blocks
- Method 2: `teammate_id` attribute in `<teammate-message>` XML tags in user messages
- Team name: `teamName` field on JSONL lines

After resolving: `UPDATE subagents SET teammate_id = $1 WHERE id = $2`

## How to Test

```bash
cd packages/core && bun test teammate-mapping 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Subagents with SendMessage routing.sender are mapped to correct teammate
2. Subagents with teammate-message XML tags are mapped correctly
3. `subagents.teammate_id` FK is set correctly
4. Non-team subagents have `teammate_id = NULL`
5. Fallback: if no teammate mapping found, subagent remains unmapped (not an error)
