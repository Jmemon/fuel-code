# Task 8: Session Archival Engine with Integrity Verification

## Parallel Group: C

## Dependencies: Task 1

## Description

Implement the server-side archival engine that prunes parsed transcript data from Postgres for old sessions while maintaining a verified S3 backup. The engine transitions sessions from `summarized` to `archived` after deleting their `transcript_messages` and `content_blocks` rows, but only after verifying that the S3 backup contains the same number of messages. The entire verification-and-delete operation happens in a single Postgres transaction so a crash mid-delete rolls back cleanly. A restore path re-downloads from S3 and re-inserts the data, transitioning `archived` back to `summarized`.

The `archived` state already exists in the session lifecycle CHECK constraint (from Phase 1 schema) but no code currently transitions to it.

### Interface

```typescript
// packages/server/src/services/archival-engine.ts

import type postgres from 'postgres';
import type pino from 'pino';
// NOTE: The S3 client (Phase 2 Task 3) must export an `S3Operations` interface
// that the `FuelCodeS3Client` class implements. Import as `S3Operations` for
// type references and testability.
import type { S3Operations } from '../aws/s3-client.js';

export interface ArchivalEngineDeps {
  sql: postgres.Sql;
  s3: S3Operations;
  logger: pino.Logger;
  // S3 bucket name for transcript storage
  bucket: string;
  // Injectable clock for testing
  now?: () => number;
}

export interface ArchivalEngine {
  // Archive a single session: verify S3 backup, delete parsed data, transition lifecycle.
  // Throws if integrity check fails.
  archiveSession(sessionId: string): Promise<ArchiveResult>;

  // Archive all eligible sessions (summarized + older than minAgeDays).
  archiveSessions(options: {
    // Minimum age in days since session ended (default: 30)
    minAgeDays?: number;
    // Maximum sessions to archive in one run (default: 100)
    batchSize?: number;
  }): Promise<BatchArchiveResult>;

  // Restore a single session: re-download from S3, re-insert data, transition back to summarized.
  restoreSession(sessionId: string): Promise<RestoreResult>;
}

export interface ArchiveResult {
  sessionId: string;
  messagesDeleted: number;
  contentBlocksDeleted: number;
  s3BackupVerified: boolean;
}

export interface BatchArchiveResult {
  archived: ArchiveResult[];
  skipped: { sessionId: string; reason: string }[];
  errors: { sessionId: string; error: string }[];
}

export interface RestoreResult {
  sessionId: string;
  messagesRestored: number;
  contentBlocksRestored: number;
}

export function createArchivalEngine(deps: ArchivalEngineDeps): ArchivalEngine;
```

### Archive Flow (Single Session)

```
archiveSession(sessionId):

1. Fetch session from DB. Verify lifecycle = 'summarized'.
   If not summarized → throw ValidationError('Session must be in summarized state to archive')

2. Count transcript_messages for this session in Postgres:
   SELECT COUNT(*) FROM transcript_messages WHERE session_id = $1

3. Check S3 for existing backup:
   s3Key = `transcripts/{workspace_id}/{session_id}/parsed.json`
   Try HEAD object → exists?

4a. If S3 backup exists:
    Download parsed.json from S3.
    Parse and count messages in the backup.
    Compare with Postgres count.
    If counts don't match → throw IntegrityError with both counts.

4b. If S3 backup does NOT exist:
    Export parsed data from Postgres as JSON:
      SELECT * FROM transcript_messages WHERE session_id = $1 ORDER BY ordinal
      SELECT * FROM content_blocks WHERE message_id IN (message_ids)
    Upload as parsed.json to S3.
    Re-download and verify the upload (read-after-write verification).

5. Begin Postgres transaction:
   a. DELETE FROM content_blocks WHERE message_id IN
      (SELECT id FROM transcript_messages WHERE session_id = $1)
   b. DELETE FROM transcript_messages WHERE session_id = $1
   c. UPDATE sessions SET lifecycle = 'archived', updated_at = NOW()
      WHERE id = $1 AND lifecycle = 'summarized'
      -- Conditional update prevents race conditions
   d. If UPDATE affected 0 rows → rollback (concurrent modification)
   COMMIT

6. Return ArchiveResult with counts.
```

### Restore Flow (Single Session)

```
restoreSession(sessionId):

1. Fetch session from DB. Verify lifecycle = 'archived'.
   If not archived → throw ValidationError('Session must be in archived state to restore')

2. Download parsed.json from S3.
   If not found → throw StorageError('S3 backup not found', { code: 'archival.s3_backup_missing' })

3. Parse the backup data (messages + content blocks).

4. Begin Postgres transaction:
   a. INSERT transcript_messages (batch insert all messages)
   b. INSERT content_blocks (batch insert all blocks)
   c. UPDATE sessions SET lifecycle = 'summarized', updated_at = NOW()
      WHERE id = $1 AND lifecycle = 'archived'
   d. If UPDATE affected 0 rows → rollback (concurrent modification)
   COMMIT

5. Return RestoreResult with counts.
```

### Batch Archive Flow

```
archiveSessions({ minAgeDays = 30, batchSize = 100 }):

1. Query eligible sessions:
   SELECT id FROM sessions
   WHERE lifecycle = 'summarized'
   AND ended_at < NOW() - INTERVAL '{minAgeDays} days'
   ORDER BY ended_at ASC
   LIMIT {batchSize}

2. For each session:
   try {
     const result = await archiveSession(session.id);
     archived.push(result);
   } catch (error) {
     if (error is IntegrityError) {
       skipped.push({ sessionId, reason: error.message });
     } else {
       errors.push({ sessionId, error: error.message });
     }
   }

3. Return BatchArchiveResult.
```

### S3 Backup Format (parsed.json)

```json
{
  "version": 1,
  "sessionId": "01HXYZ...",
  "exportedAt": "2024-01-15T10:30:00Z",
  "messageCount": 42,
  "messages": [
    {
      "id": "msg-uuid",
      "session_id": "01HXYZ...",
      "ordinal": 1,
      "role": "user",
      "content": "...",
      "timestamp": "2024-01-15T10:00:00Z",
      "content_blocks": [
        { "id": "cb-uuid", "type": "text", "content": "..." }
      ]
    }
  ]
}
```

### Retry Integration

S3 operations within the archival engine use `withRetry` (via the S3 client already retrofitted in Task 5) for transient error resilience. The archival engine itself does not need to add retry — it relies on the hardened S3 client.

### Relevant Files

**Create:**
- `packages/server/src/services/archival-engine.ts`
- `packages/server/src/services/__tests__/archival-engine.test.ts`

**Modify:**
- `packages/shared/src/errors.ts` — add `IntegrityError` subclass (if not already present): `class IntegrityError extends FuelCodeError`

### Tests

`archival-engine.test.ts` (bun:test, mock SQL + mock S3):

1. `archiveSession`: session in `summarized` state with existing S3 backup → verifies counts match, deletes from Postgres, transitions to `archived`.
2. `archiveSession`: session in `summarized` state without S3 backup → exports to S3, verifies upload, then deletes and transitions.
3. `archiveSession`: S3 backup message count doesn't match Postgres → throws `IntegrityError`, no data deleted.
4. `archiveSession`: session not in `summarized` state → throws `ValidationError`.
5. `archiveSession`: concurrent modification (UPDATE affects 0 rows) → transaction rolled back, error thrown.
6. `archiveSession`: returns correct `messagesDeleted` and `contentBlocksDeleted` counts.
7. `archiveSession`: `content_blocks` are deleted before `transcript_messages` (ON DELETE CASCADE would handle this, but explicit delete is safer for counting).
8. `restoreSession`: session in `archived` state → downloads from S3, re-inserts data, transitions to `summarized`.
9. `restoreSession`: S3 backup not found → throws `StorageError` with `archival.s3_backup_missing` code.
10. `restoreSession`: session not in `archived` state → throws `ValidationError`.
11. `restoreSession`: returns correct `messagesRestored` and `contentBlocksRestored` counts.
12. `archiveSessions`: archives all eligible sessions older than `minAgeDays`.
13. `archiveSessions`: respects `batchSize` limit.
14. `archiveSessions`: one session fails → others still archived, error recorded in result.
15. `archiveSessions`: integrity error → session skipped (not in errors).
16. `archiveSessions`: no eligible sessions → empty result.
17. S3 backup format includes `version`, `sessionId`, `exportedAt`, `messageCount`, and `messages` array.
18. Re-download verification after upload: uploaded content matches what was read back.
19. Transaction atomicity: if DELETE succeeds but UPDATE fails → entire transaction rolled back.

### Success Criteria

1. `archiveSession` verifies S3 backup integrity before deleting any Postgres data.
2. Message count comparison catches data loss scenarios — archival aborts on mismatch.
3. Delete + lifecycle transition happen in a single Postgres transaction.
4. `restoreSession` re-downloads from S3 and fully restores the parsed data.
5. `archived → summarized` transition is added to the session lifecycle.
6. Batch archival processes sessions independently — one failure doesn't block others.
7. S3 backup format is versioned (`version: 1`) for future format changes.
8. Read-after-write verification ensures S3 uploads are durable before deleting Postgres data.
9. All operations use the hardened S3 client (with retry from Task 5).
10. No data is deleted unless the backup is verified — safety is the top priority.
