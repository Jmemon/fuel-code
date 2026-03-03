# Task 16: Backfill Scanner — Sub-agent Directories

## Parallel Group: F

## Dependencies: Task 14 (sub-agent transcript upload pattern established)

## Description

Update `packages/core/src/session-backfill.ts` to enter `subagents/` directories instead of skipping them. Discover `agent-*.jsonl` files, check active status with `isSessionActive()`, and upload completed sub-agent transcripts alongside the parent session.

### Current Behavior

The backfill scanner in `discoverSessions()`:
1. Scans `~/.claude/projects/` recursively
2. For each project directory, lists files matching UUID pattern
3. **Skips all subdirectories** — increments `skipped.subagents` counter
4. Returns `DiscoveredSession[]`

The relevant code (around line 388-391) does something like:
```typescript
// Skip subdirectories (subagents/, tool-results/, etc.)
if (entry.isDirectory()) {
  stats.skipped.subagents++;
  continue;
}
```

### Required Changes

#### Phase 1: Discovery Enhancement

Instead of skipping all subdirectories, check if the directory matches the pattern `{uuid}/subagents/`:

```typescript
if (entry.isDirectory()) {
  // Check if this is a session directory that might have subagents
  if (UUID_REGEX.test(entry.name)) {
    const subagentsDir = path.join(currentDir, entry.name, 'subagents');
    if (await exists(subagentsDir)) {
      // Discover sub-agent transcripts
      const saFiles = await readdir(subagentsDir);
      for (const saFile of saFiles) {
        if (saFile.startsWith('agent-') && saFile.endsWith('.jsonl')) {
          const saPath = path.join(subagentsDir, saFile);
          const agentId = saFile.replace('agent-', '').replace('.jsonl', '');

          // Check if active
          const isActive = await isSessionActive(saPath);
          if (isActive) {
            stats.skipped.activeSubagents = (stats.skipped.activeSubagents ?? 0) + 1;
            continue;
          }

          // Record as a sub-agent transcript to upload
          subagentTranscripts.push({
            parentSessionId: entry.name, // The UUID directory name IS the session ID
            agentId,
            transcriptPath: saPath,
            fileSizeBytes: (await stat(saPath)).size,
          });
        }
      }
    }
  }
  continue; // Still skip other subdirectories (tool-results/, etc.)
}
```

Add to `ScanResult`:
```typescript
interface ScanResult {
  discovered: DiscoveredSession[];
  subagentTranscripts: DiscoveredSubagentTranscript[];
  errors: ScanError[];
  skipped: { /* existing fields + activeSubagents */ };
}

interface DiscoveredSubagentTranscript {
  parentSessionId: string;
  agentId: string;
  transcriptPath: string;
  fileSizeBytes: number;
}
```

#### Phase 2: Ingestion Enhancement

In `ingestBackfill()`, after processing parent sessions, process sub-agent transcripts:

```typescript
// After all parent sessions are ingested...
for (const saTx of scanResult.subagentTranscripts) {
  // Check if parent session was ingested (it should have been)
  if (!alreadyIngested.has(saTx.parentSessionId)) {
    // Parent session wasn't ingested — skip sub-agent
    continue;
  }

  try {
    // Upload sub-agent transcript to server
    // Use the same endpoint as Task 14: POST /api/sessions/:id/transcript/upload?subagent_id=<agent_id>
    await uploadSubagentTranscript(saTx.parentSessionId, saTx.agentId, saTx.transcriptPath);
    onProgress?.({ type: 'subagent_uploaded', parentSessionId: saTx.parentSessionId, agentId: saTx.agentId });
  } catch (err) {
    logger.warn({ err, ...saTx }, 'Failed to upload sub-agent transcript during backfill');
  }
}
```

### isSessionActive() for Sub-agents

The existing `isSessionActive()` check works correctly for sub-agent transcripts:
- **Stage 1 (tail check)**: Sub-agent transcripts don't have `/exit` commands, so this always falls through to Stage 2.
- **Stage 2 (lsof)**: If CC's sub-agent process has the file open, `lsof` detects it. This is the reliable check.

No changes to `isSessionActive()` needed.

### Upload Helper

```typescript
async function uploadSubagentTranscript(
  sessionId: string,
  agentId: string,
  transcriptPath: string
): Promise<void> {
  // Read the file
  const content = await readFile(transcriptPath);

  // POST to transcript upload endpoint with subagent_id query param
  // This was added in Task 14
  await apiClient.uploadTranscript(sessionId, content, { subagentId: agentId });
}
```

### Scan Stats Update

Update the scan stats reporting to include sub-agent transcript counts:
- `discovered_subagent_transcripts: number`
- `uploaded_subagent_transcripts: number`
- `skipped_active_subagents: number`

## Relevant Files
- Modify: `packages/core/src/session-backfill.ts`

## Success Criteria
1. Backfill scanner discovers sub-agent transcripts in `{sessionId}/subagents/` directories.
2. `agent-*.jsonl` files are correctly identified and their `agentId` extracted.
3. Active sub-agents (lsof check returns true) are skipped with a counter increment.
4. Completed sub-agent transcripts are uploaded to the server via the transcript upload endpoint.
5. Sub-agent transcripts are only uploaded if the parent session was successfully ingested.
6. Scan stats include sub-agent transcript counts.
7. Non-subdirectory files in project directories are still discovered as sessions (existing behavior).
8. `tool-results/` and other non-subagent subdirectories are still skipped (existing behavior).
9. Backfill with no sub-agent transcripts works identically to before (backward compatible).
10. All existing backfill tests pass.
