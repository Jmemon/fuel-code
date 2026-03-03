# Design: Backfill Error Enrichment & Retry Guidance

## Problem

When `fuel-code backfill` finishes with upload failures, the error block shows
only a truncated session ID and the raw exception string:

```
Errors (3):
  01abc123  fetch failed
  02def456  401 Unauthorized
  03ghi789  ENOENT: no such file or directory
```

This tells the user nothing about which project the session belongs to, where
the file lives for manual inspection, what kind of failure occurred, or how to
retry. Users must already know that re-running `fuel-code backfill` is the
retry mechanism.

## Goals

1. Show a human-readable error category per failure (`[network]`, `[auth]`, etc.)
2. Show the full transcript path so users can inspect the raw JSONL
3. Print explicit retry instructions at the bottom of the error block

## Non-goals

- No changes to `BackfillResult` types in `@fuel-code/core`
- No new CLI flags
- No changes to scan-phase error reporting
- No side-car error log file

## Design

### Where changes live

All changes are in `packages/cli/src/commands/backfill.ts`. The core package
is untouched. This is a purely presentational concern.

### Cross-referencing transcript paths

`scanForSessions` returns `ScanResult` which includes `discovered: DiscoveredSession[]`.
Each `DiscoveredSession` has `sessionId` and `transcriptPath`. After scanning,
we build a lookup map before ingestion starts:

```ts
const sessionPathMap = new Map(
  scanResult.discovered.map(s => [s.sessionId, s.transcriptPath])
);
```

When printing errors, look up `sessionPathMap.get(err.sessionId)` for each
failure. Because `ingestBackfillSessions` only fails sessions that were in
`discovered`, every lookup will hit.

### Error categorization helper

A pure `categorizeError(msg: string): string` function matches the raw error
string against ordered patterns and returns a fixed-width label:

| Label        | Patterns matched                                              |
|--------------|---------------------------------------------------------------|
| `[network]`  | "fetch failed", "ECONNREFUSED", "ETIMEDOUT", "socket"        |
| `[auth]`     | "401", "Unauthorized", "403", "Forbidden"                    |
| `[payload]`  | "413", "Payload Too Large", "request entity too large"        |
| `[server]`   | "500", "502", "503", "504", "Internal Server Error"           |
| `[timeout]`  | "TimeoutError", "AbortError", "timed out", "timeout"         |
| `[file]`     | "ENOENT", "EACCES", "EPERM", "no such file"                  |
| `[parse]`    | "JSON", "SyntaxError", "parse error", "invalid"              |
| `[error]`    | fallback                                                      |

All labels are padded to the same width (`[network]` = 9 chars) so columns align.

### New error block format

```
Errors (3):
  [network]  ~/.claude/projects/-Users-john-Desktop-myproject/01abc123-def4-5678-ghij-klmnopqrstuv.jsonl
             fetch failed

  [auth]     ~/.claude/projects/-Users-john-Desktop-other/02def456-789a-bcde-fghi-jklmnopqrstuv.jsonl
             401 Unauthorized

  [file]     ~/.claude/projects/-Users-john-Desktop-repo/03ghi789-abcd-ef01-2345-678901234567.jsonl
             ENOENT: no such file or directory

To retry failed sessions: fuel-code backfill
```

- Two lines per error: `{category}  {path}` then indented raw error message
- Path is home-dir-shortened (`~` substitution) for readability
- Blank line between errors for scannability
- Overflow line: `  ... and N more` (unchanged, but followed by retry instruction)
- Retry instruction always printed when `result.errors.length > 0`

### Home directory shortening

```ts
function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
```

### Retry mechanism (no change needed)

`ingestedSessionIds` in `~/.fuel-code/backfill-state.json` tracks only
sessions that succeeded. Failed sessions are absent, so a plain re-run of
`fuel-code backfill` retries them naturally. The retry instruction simply
surfaces this fact to the user.

## Test plan

- Unit test `categorizeError` for each category label and the fallback
- Unit test `shortenPath` for home-dir paths and paths outside home
- Update/add CLI test that asserts the new error block format (category label,
  path, error text, retry instruction) when `ingestBackfillSessions` returns errors
- Existing tests must continue to pass (no output regressions for happy-path runs)
