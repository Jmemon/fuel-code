# Task 13: Session Archival: API + CLI + Archival-Aware Display

## Parallel Group: E

## Dependencies: Tasks 8, 12

## Description

Wire the archival engine (Task 8) into the server API and build the CLI commands for session archival. This task adds: (1) server API endpoints for archive and restore operations, (2) `fuel-code session archive` and `fuel-code session <id> --restore` CLI commands with progress indicators, and (3) archival-aware display in `fuel-code session ls` and `fuel-code session <id>` that shows archived sessions differently. The progress utilities from Task 12 provide visual feedback during archival operations.

### Server API Endpoints

```typescript
// packages/server/src/routes/sessions.ts (add to existing session routes)

// POST /api/sessions/:id/archive
// Archives a single session. Session must be in 'summarized' lifecycle.
// Response: 200 { sessionId, messagesDeleted, contentBlocksDeleted, s3BackupVerified }
// Errors: 404 (not found), 409 (not in summarized state), 500 (integrity check failed)

// POST /api/sessions/:id/restore
// Restores an archived session. Session must be in 'archived' lifecycle.
// Response: 200 { sessionId, messagesRestored, contentBlocksRestored }
// Errors: 404 (not found), 409 (not in archived state), 500 (S3 backup not found)

// POST /api/sessions/archive
// Batch archive eligible sessions.
// Body: { minAgeDays?: number, batchSize?: number }
// Response: 200 { archived: [...], skipped: [...], errors: [...] }

// GET /api/sessions?include_archived=true
// Existing list endpoint already returns sessions. Add filter:
// - Default: exclude archived sessions (lifecycle != 'archived')
// - include_archived=true: include archived sessions in results
// - lifecycle=archived: only return archived sessions
```

### API Implementation

```typescript
// POST /api/sessions/:id/archive
router.post('/:id/archive', async (req, res) => {
  const archivalEngine = createArchivalEngine({
    sql: req.app.locals.sql,
    s3: req.app.locals.s3,
    logger: req.log,
    bucket: req.app.locals.config.s3Bucket,
  });

  try {
    const result = await archivalEngine.archiveSession(req.params.id);
    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(409).json({ error: error.message, code: error.code });
    } else if (error instanceof IntegrityError) {
      res.status(500).json({ error: error.message, code: 'archival.integrity_mismatch' });
    } else {
      throw error; // Let global error handler catch
    }
  }
});

// POST /api/sessions/:id/restore
router.post('/:id/restore', async (req, res) => {
  const archivalEngine = createArchivalEngine({ ... });

  try {
    const result = await archivalEngine.restoreSession(req.params.id);
    res.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(409).json({ error: error.message, code: error.code });
    } else if (error instanceof StorageError) {
      res.status(500).json({ error: error.message, code: 'archival.s3_backup_missing' });
    } else {
      throw error;
    }
  }
});

// POST /api/sessions/archive (batch)
router.post('/archive', async (req, res) => {
  const { minAgeDays, batchSize } = req.body;
  const archivalEngine = createArchivalEngine({ ... });
  const result = await archivalEngine.archiveSessions({ minAgeDays, batchSize });
  res.json(result);
});
```

### ApiClient Extensions

```typescript
// packages/cli/src/lib/api-client.ts (add methods)

async archiveSession(sessionId: string): Promise<ArchiveResult> {
  return this.request('POST', `/api/sessions/${sessionId}/archive`);
}

async restoreSession(sessionId: string): Promise<RestoreResult> {
  return this.request('POST', `/api/sessions/${sessionId}/restore`);
}

async archiveSessions(options?: { minAgeDays?: number; batchSize?: number }): Promise<BatchArchiveResult> {
  return this.request('POST', '/api/sessions/archive', options);
}
```

### CLI Commands

```typescript
// fuel-code session archive [options]
// Archives old sessions to free up Postgres storage.
//
// Options:
//   --min-age <days>    Minimum age in days (default: 30)
//   --batch-size <n>    Maximum sessions to archive (default: 100)
//   --session <id>      Archive a specific session
//   --dry-run           Show what would be archived without doing it
//   --json              Output as JSON

// fuel-code session <id> --restore
// Restores an archived session from S3 backup.
```

### Session Archive Command Implementation

```typescript
// packages/cli/src/commands/session.ts (add subcommand)

async function sessionArchive(options: {
  minAge?: number;
  batchSize?: number;
  session?: string;
  dryRun?: boolean;
  json?: boolean;
}) {
  const apiClient = new ApiClient({ ... });

  if (options.session) {
    // Single session archive
    const progress = createProgressReporter();
    progress.start(`Archiving session ${options.session}...`);

    try {
      const result = await apiClient.archiveSession(options.session);
      progress.succeed(`Archived session ${options.session}: ${result.messagesDeleted} messages, ${result.contentBlocksDeleted} content blocks removed`);
    } catch (error) {
      progress.fail(`Failed to archive session ${options.session}`);
      throw error;
    }
    return;
  }

  // Batch archive
  if (options.dryRun) {
    // Query eligible sessions and display without archiving
    const sessions = await apiClient.getSessions({
      lifecycle: 'summarized',
      endedBefore: new Date(Date.now() - (options.minAge || 30) * 86400000).toISOString(),
      limit: options.batchSize || 100,
    });
    console.log(`Would archive ${sessions.length} sessions.`);
    // Print table of sessions...
    return;
  }

  const progress = createProgressReporter();
  progress.start(`Archiving sessions older than ${options.minAge || 30} days...`);

  const result = await apiClient.archiveSessions({
    minAgeDays: options.minAge,
    batchSize: options.batchSize,
  });

  progress.succeed(
    `Archived ${result.archived.length} sessions` +
    (result.skipped.length ? `, ${result.skipped.length} skipped` : '') +
    (result.errors.length ? `, ${result.errors.length} errors` : '')
  );

  if (result.errors.length > 0) {
    console.error('\nErrors:');
    for (const err of result.errors) {
      console.error(`  ${err.sessionId}: ${err.error}`);
    }
  }
}
```

### Archival-Aware Session Display

**Session list** (`fuel-code session ls`):

```
ID              Workspace    Started           Duration    Lifecycle    Events
01HXYZ123...    my-project   Jan 15, 10:00     2h 15m      ended        42
01HXYZ456...    my-project   Jan 10, 14:00     5h 30m      summarized   128
01HXYZ789...    my-project   Dec 5, 09:00      3h 12m      archived     (archived)
```

- Archived sessions show `archived` in the Lifecycle column with dimmed text (picocolors `dim`).
- The Events column shows `(archived)` instead of a count (events have been removed from Postgres).
- By default, archived sessions are NOT shown. Pass `--all` or `--archived` to include them.

**Session detail** (`fuel-code session <id>` for archived session):

```
Session: 01HXYZ789...
  Workspace:  my-project
  Lifecycle:  archived
  Started:    Dec 5, 2024 09:00
  Ended:      Dec 5, 2024 12:12
  Duration:   3h 12m
  Summary:    [summary text from DB]

  ⓘ This session is archived. Transcript data has been moved to S3.
    Run `fuel-code session 01HXYZ789... --restore` to restore transcript data.
```

The summary is still available (it's on the session row, not in transcript_messages), but the timeline is not (it requires transcript_messages). If a user requests the timeline of an archived session, show:

```
Timeline is not available for archived sessions.
Run `fuel-code session 01HXYZ789... --restore` to restore transcript data first.
```

### Relevant Files

**Create:**
- `packages/server/src/routes/__tests__/sessions-archive.test.ts`
- `packages/cli/src/commands/__tests__/session-archive.test.ts`

**Modify:**
- `packages/server/src/routes/sessions.ts` — add archive, restore, batch archive endpoints
- `packages/cli/src/lib/api-client.ts` — add `archiveSession`, `restoreSession`, `archiveSessions` methods
- `packages/cli/src/commands/session.ts` — add `archive` subcommand, `--restore` flag, archival-aware display
- `packages/cli/src/commands/session-ls.ts` (or wherever session list lives) — add `--all`/`--archived` flags, dim archived sessions

### Tests

`sessions-archive.test.ts` (server, bun:test):

1. `POST /api/sessions/:id/archive` with summarized session → 200 with archive result.
2. `POST /api/sessions/:id/archive` with non-summarized session → 409 conflict.
3. `POST /api/sessions/:id/archive` with nonexistent session → 404.
4. `POST /api/sessions/:id/restore` with archived session → 200 with restore result.
5. `POST /api/sessions/:id/restore` with non-archived session → 409 conflict.
6. `POST /api/sessions/:id/restore` with missing S3 backup → 500 with error code.
7. `POST /api/sessions/archive` batch → archives eligible sessions, returns full result.
8. `POST /api/sessions/archive` with minAgeDays → only archives sessions older than threshold.
9. `GET /api/sessions` default → does not include archived sessions.
10. `GET /api/sessions?include_archived=true` → includes archived sessions.
11. `GET /api/sessions?lifecycle=archived` → only archived sessions.

`session-archive.test.ts` (CLI, bun:test):

12. `fuel-code session archive --session <id>` → archives single session, shows progress.
13. `fuel-code session archive` → batch archives, shows progress with counts.
14. `fuel-code session archive --dry-run` → shows eligible sessions without archiving.
15. `fuel-code session archive --min-age 7` → passes minAgeDays to API.
16. `fuel-code session <id> --restore` → restores session, shows progress.
17. `fuel-code session ls` → archived sessions hidden by default.
18. `fuel-code session ls --all` → archived sessions shown with dimmed text.
19. `fuel-code session ls --archived` → only archived sessions.
20. `fuel-code session <id>` for archived session → shows archive notice with restore command hint.
21. `fuel-code session <id> --timeline` for archived session → shows "not available" message.
22. `fuel-code session archive --json` → JSON output with all archive results.

### Success Criteria

1. Archive and restore API endpoints handle all lifecycle states with correct HTTP status codes.
2. Batch archive endpoint processes eligible sessions and returns detailed results.
3. Session list defaults to hiding archived sessions — existing UX not disrupted.
4. `--all` / `--archived` flags control archived session visibility.
5. Archived sessions display distinctly in both list and detail views.
6. Detail view of archived session includes restore command hint.
7. Timeline request for archived session shows clear "not available" message.
8. Progress indicators show archival/restore status with elapsed time.
9. `--dry-run` mode shows what would be archived without actually doing it.
10. All CLI commands handle archive/restore errors gracefully with structured error messages.
