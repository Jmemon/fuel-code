# Task 17: API — Transcript Sub-agent Filtering

## Parallel Group: F

## Dependencies: Task 14 (sub-agent messages stored with subagent_id FK)

## Description

Enhance `GET /api/sessions/:id/transcript` to support filtering by sub-agent. Add a `subagent_id` query parameter that controls which messages are returned.

### Query Parameter

`GET /api/sessions/:id/transcript?subagent_id=<value>`

Behavior:
- **No param** (default): Return only main session messages (`subagent_id IS NULL`). This preserves backward compatibility — existing callers see the same data as before.
- **`?subagent_id=<ulid>`**: Return only that sub-agent's messages (`subagent_id = $1`).
- **`?subagent_id=all`**: Return all messages (main + all sub-agents). Messages are ordered by timestamp with sub-agent messages interleaved at their actual position.

### Implementation

In `packages/server/src/routes/sessions.ts`, the transcript endpoint handler:

```typescript
// Parse subagent_id param
const subagentId = req.query.subagent_id as string | undefined;

let whereClause: string;
if (!subagentId) {
  // Default: main session only
  whereClause = 'AND tm.subagent_id IS NULL';
} else if (subagentId === 'all') {
  // All messages
  whereClause = '';
} else {
  // Specific sub-agent
  // Validate that the subagent_id exists for this session
  const [sa] = await sql`
    SELECT id FROM subagents WHERE id = ${subagentId} AND session_id = ${sessionId}
  `;
  if (!sa) {
    return res.status(404).json({ error: 'Sub-agent not found for this session' });
  }
  whereClause = `AND tm.subagent_id = '${subagentId}'`;
}
```

**Note**: Use parameterized queries, not string interpolation, for the actual implementation. The above is pseudocode.

### Response Enhancement

When `subagent_id` is specified (not default), add sub-agent context to each message:

```json
{
  "messages": [
    {
      "id": "01J...",
      "role": "assistant",
      "message_type": "assistant",
      "subagent_id": "01J...",
      "subagent": {
        "agent_id": "a834e7d",
        "agent_type": "Explore",
        "agent_name": null
      },
      // ... existing fields
    }
  ]
}
```

When `subagent_id=all`, each message includes its `subagent_id` (null for main session) and optionally the sub-agent summary.

### Presigned URL Endpoint

Also update `GET /api/sessions/:id/transcript/raw` to support sub-agent raw transcripts:
- `?subagent_id=<agent_id_string>` (the CC agent ID, not the ULID) → presign the S3 key `transcripts/{session_id}/subagents/{agent_id}.jsonl`
- No param → existing behavior (main session transcript)

## Relevant Files
- Modify: `packages/server/src/routes/sessions.ts`

## Success Criteria
1. Default behavior unchanged: no `subagent_id` param returns only main session messages.
2. `?subagent_id=<ulid>` returns only that sub-agent's messages.
3. `?subagent_id=all` returns all messages (main + sub-agents) ordered by timestamp.
4. 404 returned for nonexistent subagent_id.
5. Sub-agent context included on messages when filtering by sub-agent.
6. Raw transcript presigned URL works for sub-agent transcripts.
7. Sessions without sub-agent messages return empty result for `?subagent_id=<id>`.
8. Existing transcript endpoint tests pass (default behavior unchanged).
