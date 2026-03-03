# Task 22: API — Teammate Endpoints

## Phase: G — API + TUI + CLI
## Dependencies: T18
## Parallelizable With: T23, T24, T25

---

## Description

Add new API endpoints for teammate data. These power both the TUI and CLI.

## Files

- **Modify**: `packages/server/src/routes/sessions.ts` — add `GET /sessions/:id/teammates` and `GET /sessions/:id/teammates/:teammateId/messages`

## Endpoints

**`GET /sessions/:id/teammates`**
```sql
SELECT tm.*, t.team_name
FROM teammates tm
JOIN teams t ON t.id = tm.team_id
WHERE tm.session_id = $1
ORDER BY tm.created_at
```
Response: `{ teammates: Teammate[] }`

**`GET /sessions/:id/teammates/:teammateId/messages`**
```sql
SELECT msg.*, sa.agent_id, sa.agent_name,
  COALESCE(json_agg(
    json_build_object('id', cb.id, 'block_type', cb.block_type, 'content_text', cb.content_text,
      'thinking_text', cb.thinking_text, 'tool_name', cb.tool_name, 'tool_use_id', cb.tool_use_id,
      'tool_input', cb.tool_input, 'tool_result_id', cb.tool_result_id, 'is_error', cb.is_error,
      'result_text', cb.result_text, 'metadata', cb.metadata)
    ORDER BY cb.block_order
  ) FILTER (WHERE cb.id IS NOT NULL), '[]') AS content_blocks
FROM transcript_messages msg
JOIN subagents sa ON sa.id = msg.subagent_id
LEFT JOIN content_blocks cb ON cb.message_id = msg.id
WHERE msg.teammate_id = $1
GROUP BY msg.id, sa.agent_id, sa.agent_name
ORDER BY msg.timestamp
```
Response: `{ messages: TranscriptMessageWithBlocks[] }`

## How to Test

```bash
cd packages/server && bun test sessions 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Manual test
curl http://localhost:3457/api/sessions/<session-with-team>/teammates | jq
curl http://localhost:3457/api/sessions/<session-id>/teammates/<teammate-id>/messages | jq
```

## Success Criteria

1. `GET /teammates` returns all teammates for a session with team_name
2. `GET /teammates/:id/messages` returns stitched message feed with content_blocks
3. Each message includes the `agent_id` and `agent_name` of the emitting subagent
4. Messages ordered by timestamp
5. 404 for unknown session or teammate
6. Empty array for sessions with no teammates
