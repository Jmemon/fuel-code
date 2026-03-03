# Task 14: Session Pipeline — Sub-agent Transcript Upload + Parse

## Parallel Group: E

## Dependencies: Task 12 (pipeline persist relationships must exist)

## Description

Extend the session-end hook to discover and upload sub-agent transcripts, and extend the pipeline to download, parse, and store sub-agent messages with the `subagent_id` FK set.

### Part 1: Session-End Hook — Sub-agent Transcript Discovery

In `packages/cli/src/commands/cc-hook.ts`, the `session-end` handler currently:
1. Reads stdin context (session_id, transcript_path, cwd)
2. Uploads the main transcript to the server
3. Emits session.end event

**Add after step 2**: Discover and upload sub-agent transcripts.

```typescript
// Discover sub-agent transcripts
// CC stores them at: ~/.claude/projects/{encoded_path}/{sessionId}/subagents/agent-*.jsonl
const transcriptDir = path.dirname(transcriptPath);
const subagentsDir = path.join(transcriptDir, sessionId, 'subagents');

if (await exists(subagentsDir)) {
  const files = await readdir(subagentsDir);
  const agentFiles = files.filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

  for (const file of agentFiles) {
    const agentPath = path.join(subagentsDir, file);

    // Check if sub-agent is still running
    const isActive = await isSessionActive(agentPath);
    if (isActive) {
      logger.debug({ file }, 'Skipping active sub-agent transcript');
      continue;
    }

    // Upload to server
    // Use transcript upload endpoint with a sub-path parameter
    // S3 key pattern: transcripts/{session_id}/subagents/{agent_id}.jsonl
    const agentId = file.replace('agent-', '').replace('.jsonl', '');
    try {
      await uploadTranscript(agentPath, sessionId, agentId);
    } catch (err) {
      logger.warn({ err, file }, 'Failed to upload sub-agent transcript — will be caught by backfill');
    }
  }
}
```

**Important**: This must be **non-fatal**. If sub-agent transcript upload fails, the main session processing continues. Backfill (Task 16) catches anything missed.

**Important**: The `isSessionActive()` check uses `lsof` to detect if the file is open. This is the reliable check for sub-agent liveness. Don't rely on file content patterns (sub-agent transcripts don't have `/exit` commands).

### Part 2: Transcript Upload Endpoint Enhancement

The server needs to accept sub-agent transcripts. Either:
- Extend the existing `POST /api/sessions/:id/transcript/upload` to accept a `subagent_id` query param
- Or create a new endpoint `POST /api/sessions/:id/subagents/:agentId/transcript/upload`

The simpler option: add `?subagent_id=<agent_id>` to the existing upload endpoint. When present, the uploaded transcript is stored at S3 key `transcripts/{session_id}/subagents/{agent_id}.jsonl`.

Modify: `packages/server/src/routes/transcript-upload.ts`

### Part 3: Pipeline — Parse Sub-agent Transcripts

After `persistRelationships()` (step 5.5), add step 5.6:

```typescript
// Step 5.6: Parse sub-agent transcripts
for (const subagent of parseResult.subagents) {
  try {
    // Look up the subagent row to get its ULID
    const [saRow] = await sql`
      SELECT id FROM subagents WHERE session_id = ${sessionId} AND agent_id = ${subagent.agent_id}
    `;
    if (!saRow) continue;

    // Try to download sub-agent transcript from S3
    const saKey = `transcripts/${sessionId}/subagents/${subagent.agent_id}.jsonl`;
    let saTranscript: string;
    try {
      saTranscript = await downloadFromS3(saKey);
    } catch {
      // Sub-agent transcript not uploaded yet — skip
      continue;
    }

    // Parse through the same parser
    const saResult = await parseTranscript(sessionId, saTranscript);

    // Batch insert messages with subagent_id set
    await batchInsertMessages(sql, saResult.messages.map(m => ({
      ...m,
      subagent_id: saRow.id, // Set the FK
    })));

    await batchInsertContentBlocks(sql, saResult.contentBlocks.map(b => ({
      ...b,
      subagent_id: saRow.id,
    })));

    // Update subagent row with transcript S3 key
    await sql`
      UPDATE subagents SET transcript_s3_key = ${saKey} WHERE id = ${saRow.id}
    `;

  } catch (err) {
    logger.warn({ err, agentId: subagent.agent_id }, 'Failed to parse sub-agent transcript');
  }
}
```

### Part 4: Batch Insert Column Update

The batch insert functions in `session-pipeline.ts` use raw SQL with numbered placeholders. The `subagent_id` column must be added:

**`batchInsertMessages()`**: Add `subagent_id` as the 22nd column (nullable). For main session messages, pass `null`. For sub-agent messages, pass the subagent ULID.

**`batchInsertContentBlocks()`**: Add `subagent_id` as the 15th column. Same pattern.

This is a careful change — the column count in the INSERT statement and the placeholder numbering must match exactly.

### Edge Cases

1. **Sub-agent still running when parent ends** — `isSessionActive()` returns true, transcript is skipped. Will be caught by backfill or a later session-end.
2. **Sub-agent transcript not uploaded** — S3 download fails silently, pipeline continues.
3. **Nested sub-agents** — a sub-agent's transcript may contain Task tool calls. The parser extracts them but they're stored as content_blocks on the sub-agent's messages. No recursive sub-agent row creation in this phase.
4. **Large sub-agent transcripts** — same batch insert limits as main session (500 per batch).
5. **Sub-agent transcript already parsed** (reparse case) — the `DELETE FROM transcript_messages WHERE session_id = $1 AND subagent_id = $2` before re-insert handles this.

## Relevant Files
- Modify: `packages/cli/src/commands/cc-hook.ts` (session-end: sub-agent discovery + upload)
- Modify: `packages/server/src/routes/transcript-upload.ts` (accept subagent_id param)
- Modify: `packages/core/src/session-pipeline.ts` (parse sub-agent transcripts, update batch inserts)

## Success Criteria
1. Session-end hook discovers sub-agent transcripts in `{sessionId}/subagents/` directory.
2. Completed sub-agent transcripts are uploaded to S3 with correct key pattern.
3. Active sub-agents (lsof check) are skipped.
4. Pipeline parses sub-agent transcripts and stores messages/blocks with `subagent_id` FK set.
5. Main session messages have `subagent_id = NULL`.
6. Batch insert functions correctly handle the new column.
7. Sub-agent transcript upload failure is non-fatal — main session processing continues.
8. `subagents.transcript_s3_key` is set after successful upload+parse.
9. Reparse cleans up old sub-agent messages before re-inserting.
10. All existing pipeline tests pass.
