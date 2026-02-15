# Task 5: CLI: `fuel-code session <id>` Command (Detail + All Flags)

## Parallel Group: B

**Dependencies**: Task 3 (API Client + Output Formatting Utilities)

## Description

Implement the `fuel-code session <id>` command -- the most feature-rich CLI command. Without flags, it displays a session summary card. With flags, it shows specific views of session data: transcript, events, git activity. It also supports mutation flags (tag, reparse) and data export (JSON, Markdown). A transcript renderer is extracted as a separate reusable module for TUI reuse in Task 9.

### Session ID Resolution

**`packages/cli/src/lib/session-resolver.ts`** (or inline in the command file):

The `<id>` argument supports:
1. **Full ULID** (26 chars): pass directly to `GET /api/sessions/:id`.
2. **Prefix** (8+ chars): call `GET /api/sessions?limit=10` and filter client-side by ID prefix. If exactly one match, use it. If zero matches, print `Session not found: <prefix>`. If multiple matches, list candidates and ask for full ID.
3. **Fewer than 8 chars**: reject with `Session ID prefix must be at least 8 characters. Got <N>.`

```typescript
// Resolves a session ID or prefix to a full session ID.
// Returns the full session ULID.
// Throws with helpful message if not found or ambiguous.
export async function resolveSessionId(
  api: ApiClient,
  idOrPrefix: string
): Promise<string>
```

When ambiguous, the error message should list candidates:
```
Ambiguous session ID prefix "01jmf3a8". Matches:
  01jmf3a8xyzw1234...  fuel-code   12m ago   "Redesigning the event pipeline"
  01jmf3a8abcd5678...  api-service  3h ago   "Fixed timezone handling"
Use the full session ID to disambiguate.
```

### Command Structure

**`packages/cli/src/commands/session-detail.ts`**:

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import { resolveSessionId } from '../lib/session-resolver';
import { renderTranscript } from '../lib/transcript-renderer';
import {
  formatDetail, formatDuration, formatCost, formatRelativeTime,
  formatLifecycle, formatTokens, renderTable, truncate, outputResult,
  formatError, colors
} from '../lib/formatters';

// ─── Data Layer (exported for TUI reuse) ───────────────────────────

// Fetches full session detail from the API.
// Returns the session object with all metadata, stats, and tags.
export async function fetchSessionDetail(
  api: ApiClient,
  sessionId: string
): Promise<SessionDetail>

// Fetches parsed transcript for a session.
// Returns array of transcript messages with content blocks.
export async function fetchSessionTranscript(
  api: ApiClient,
  sessionId: string
): Promise<TranscriptMessage[]>

// Fetches events that occurred during a session.
export async function fetchSessionEvents(
  api: ApiClient,
  sessionId: string
): Promise<Event[]>

// Fetches git activity during a session.
export async function fetchSessionGit(
  api: ApiClient,
  sessionId: string
): Promise<GitActivity[]>

// Fetches all session data for export (combines detail + transcript + events + git).
export async function fetchSessionExportData(
  api: ApiClient,
  sessionId: string
): Promise<SessionExportData>

// ─── Presentation Layer ────────────────────────────────────────────

// Formats the default session summary card.
export function formatSessionSummary(session: SessionDetail): string

// Formats the events table.
export function formatSessionEvents(events: Event[]): string

// Formats the git activity view.
export function formatSessionGitActivity(git: GitActivity[]): string

// Generates a Markdown export document from session data.
export function generateMarkdownExport(data: SessionExportData): string

// Commander registration
export function registerSessionDetailCommand(program: Command): void
```

### Flag Definitions

| Flag | Type | Default | Behavior |
|------|------|---------|----------|
| `--transcript` | boolean | false | Show parsed conversation transcript with tool usage tree. |
| `--events` | boolean | false | Show chronological event table for this session. |
| `--git` | boolean | false | Show git activity (commits, pushes, merges, checkouts) during this session. |
| `--export <format>` | `"json"` or `"md"` | none | Export complete session data to `session-<id>.json` or `session-<id>.md` in cwd. |
| `--tag <tag>` | string | none | Add a tag to this session via `PATCH /api/sessions/:id`. |
| `--reparse` | boolean | false | Re-trigger transcript parsing via `POST /api/sessions/:id/reparse`. |
| `--json` | boolean | false | Output the default summary view as JSON (machine-readable). |

Flags are mutually exclusive in groups: `--transcript`, `--events`, `--git`, `--export`, `--tag`, `--reparse` each produce different output. If multiple are provided, process them in this priority order: `--tag` (mutation) > `--reparse` (mutation) > `--export` > `--transcript` > `--events` > `--git`. Only one view is rendered per invocation.

### Default View (No Flags)

**Session summary card**:

```
Session: 01jmf3a8xyzw1234abcd5678
Workspace:  fuel-code (github.com/user/fuel-code)
Device:     macbook-pro (local)
Status:     ✓ Summarized
Started:    2h ago (2026-02-14T10:23:00Z)
Duration:   47m
Cost:       $0.42
Model:      claude-sonnet-4-5-20250929
Branch:     main

Summary:
  Refactored authentication middleware to replace session-based auth with
  JWT tokens. Updated middleware, added token verification, wrote tests.

Stats:
  Messages:  42 total (12 user, 30 assistant)
  Tools:     Edit(12) Read(15) Bash(8) Grep(4) Write(3)
  Tokens:    125K in / 48K out / 890K cache
  Commits:   2

Tags: refactoring, auth

Use --transcript, --events, or --git for detailed views.
```

**Implementation**: Call `fetchSessionDetail()`, format with `formatSessionSummary()`. The summary function uses `formatDetail()` from formatters for the key-value header, then appends Summary text block (word-wrapped to terminal width - 4 chars indent), Stats block, and Tags line.

### `--transcript` Flag

**Transcript rendering** is extracted to a reusable module:

**`packages/cli/src/lib/transcript-renderer.ts`**:

```typescript
// Renders a parsed transcript as readable terminal output.
// Used by both CLI (session --transcript) and TUI (Task 9).

export interface TranscriptRenderOptions {
  maxWidth?: number;          // terminal width, default process.stdout.columns || 120
  showThinking?: boolean;     // show full thinking content, default false (collapsed)
  maxMessages?: number;       // limit messages shown, default 50
  colorize?: boolean;         // use picocolors, default true
}

// Main render function: takes transcript messages, returns formatted string.
export function renderTranscript(
  messages: TranscriptMessage[],
  options?: TranscriptRenderOptions
): string

// Renders a single message (for streaming/incremental TUI use).
export function renderMessage(
  message: TranscriptMessage,
  index: number,
  options?: TranscriptRenderOptions
): string

// Renders tool use as a tree structure (├─ / └─).
// Returns multi-line string of tool uses within an assistant message.
export function renderToolUseTree(
  contentBlocks: ContentBlock[]
): string
```

**Transcript output format**:

```
[1] Human (10:23):
  Fix the auth bug in the login endpoint. The session cookie isn't being
  set correctly after the OAuth callback.

[2] Assistant (10:24) · claude-sonnet-4-5 · $0.03:
  I'll investigate the auth flow. Let me start by reading the relevant files.
  ├ Read: src/auth/middleware.ts
  ├ Read: src/auth/oauth.ts
  ├ Read: src/routes/login.ts
  I can see the issue. The cookie options are missing the `secure` flag...
  ├ Edit: src/auth/middleware.ts (+12 -3)
  └ Bash: bun test src/auth/ (exit 0)

[3] Human (10:35):
  Now add tests for the JWT validation edge cases.

[4] Assistant (10:36) · claude-sonnet-4-5 · $0.05:
  [thinking... 2,430 chars]
  I'll add comprehensive tests for JWT validation.
  ├ Read: src/auth/__tests__/jwt.test.ts
  ├ Write: src/auth/__tests__/jwt.test.ts
  └ Bash: bun test src/auth/__tests__/jwt.test.ts (exit 0)

... 38 more messages. Use fuel-code session <id> --transcript --limit 100 to see all.
```

**Rendering rules**:
1. Each message has an ordinal `[N]`, role (`Human` / `Assistant`), and timestamp (HH:MM format).
2. Assistant messages additionally show model name and per-turn cost if available.
3. Text content is word-wrapped to `maxWidth - 2` (2 chars indent).
4. Tool uses within assistant messages render as an indented tree:
   - `├` for all but the last tool use in a sequence.
   - `└` for the last tool use.
   - Tool name + primary argument summary:
     - `Read`: file path from input
     - `Edit`: file path + `(+N -M)` from result if available
     - `Write`: file path
     - `Bash`: command (truncated to 60 chars) + `(exit N)` from result
     - `Grep`/`Glob`: pattern from input
     - Other tools: tool name + first 60 chars of input stringified
5. Tool results are NOT shown inline (too verbose). Only the one-line summary above.
6. Thinking blocks render as dimmed `[thinking... N chars]` unless `showThinking` is true.
7. If transcript exceeds `maxMessages`, truncate with "... N more messages" footer.

### `--events` Flag

**Event table format**:

```
Events (12 events)

TIME       TYPE             DATA
10:23:00   session.start    branch=main, model=claude-sonnet-4-5
10:30:12   git.commit       abc123 "fix auth bug" (+12 -3, 2 files)
10:35:45   git.commit       def456 "add JWT tests" (+45 -0, 1 file)
10:41:30   git.push         main → origin (2 commits)
11:10:00   session.end      duration=47m, reason=exit
```

**Implementation**: Call `fetchSessionEvents()`, format with `renderTable()`. The DATA column is event-type-specific: session.start shows branch + model, git.commit shows hash + message + stats, git.push shows branch + remote + count, session.end shows duration + reason.

### `--git` Flag

**Git activity format**:

```
Git Activity (2 commits, 1 push · +57 -3)

HASH     MESSAGE                           BRANCH  TIME    +/-      FILES
abc123   fix auth bug                      main    10:30   +12 -3   2
def456   add JWT validation tests          main    10:35   +45 -0   1

Push: main → origin (2 commits) at 10:41
```

**Implementation**: Call `fetchSessionGit()`. Render commits as a table, pushes/merges/checkouts as separate lines below. Header shows aggregate stats (total commits, total pushes, total insertions/deletions).

### `--export json`

Writes `session-<id-prefix>.json` to the current working directory. The file contains the complete session data:

```json
{
  "session": { ...session detail... },
  "transcript": {
    "messages": [ ...TranscriptMessage[]... ]
  },
  "events": [ ...Event[]... ],
  "git_activity": [ ...GitActivity[]... ],
  "exported_at": "2026-02-14T..."
}
```

After writing, print: `Exported session data to session-01jmf3a8.json (47 KB)`

### `--export md`

Writes `session-<id-prefix>.md` to the current working directory. Markdown structure:

```markdown
# Session: fuel-code -- Refactored auth middleware

- **Workspace**: fuel-code (github.com/user/fuel-code)
- **Device**: macbook-pro (local)
- **Duration**: 47m
- **Cost**: $0.42
- **Date**: Feb 14, 2026 10:23 AM
- **Status**: Summarized
- **Tags**: refactoring, auth

## Summary

Refactored authentication middleware to replace session-based auth with JWT tokens.
Updated middleware, added token verification, wrote tests.

## Stats

- Messages: 42 total (12 user, 30 assistant)
- Tools: Edit(12) Read(15) Bash(8) Grep(4) Write(3)
- Tokens: 125K in / 48K out / 890K cache
- Commits: 2

## Transcript

### [1] Human
Fix the auth bug in the login endpoint...

### [2] Assistant
I'll investigate the auth flow...
- Read: src/auth/middleware.ts
- Edit: src/auth/middleware.ts (+12 -3)
- Bash: bun test src/auth/ (exit 0)

## Git Activity

- `abc123` fix auth bug (+12 -3, 2 files)
- `def456` add JWT validation tests (+45 -0, 1 file)
```

After writing, print: `Exported session to session-01jmf3a8.md (12 KB)`

### `--tag <tag>`

1. Fetch current session detail to get existing tags.
2. If tag already exists, print: `Session already has tag "refactoring".` and exit 0.
3. Call `PATCH /api/sessions/:id` with `{ tags: [...existingTags, newTag] }`.
4. Print: `Added tag "refactoring" to session 01jmf3a8.`

### `--reparse`

1. Call `POST /api/sessions/:id/reparse`.
2. Print: `Re-parse triggered for session 01jmf3a8. Transcript will be re-processed.`

### Handling Missing Data

Sessions in early lifecycle states may not have all data:
- `detected` / `capturing`: no transcript yet. `--transcript` prints: `Transcript not yet available. Session is currently <lifecycle>.`
- `detected`: no events beyond session.start. `--events` shows whatever is available.
- No git activity: `--git` prints: `No git activity during this session.`
- `failed`: `--transcript` prints: `Transcript parsing failed for this session. Use --reparse to retry.`

### Command Handler Flow

1. Load config, create `ApiClient`.
2. Resolve session ID via `resolveSessionId()`.
3. Route to the appropriate sub-handler based on flags (priority: tag > reparse > export > transcript > events > git > default).
4. Each sub-handler fetches the needed data and formats output.
5. Handle errors: 404 → "Session not found", connection errors → friendly message.

## Relevant Files

- `packages/cli/src/commands/session-detail.ts` (create)
- `packages/cli/src/lib/transcript-renderer.ts` (create)
- `packages/cli/src/lib/session-resolver.ts` (create)
- `packages/cli/src/index.ts` (modify -- register `session` command)
- `packages/cli/src/commands/__tests__/session-detail.test.ts` (create)
- `packages/cli/src/lib/__tests__/transcript-renderer.test.ts` (create)

## Tests

### `packages/cli/src/commands/__tests__/session-detail.test.ts`

Test approach: Mock `ApiClient` with `Bun.serve()` local HTTP server. Capture stdout for output assertions. Write export files to a temp directory.

1. **Default view (no flags)**: prints summary card with workspace, device, timing, cost, status, summary, stats, tags.
2. **Default view --json**: outputs session detail as valid JSON.
3. **`--transcript`**: renders transcript with message ordinals, roles, timestamps, and content.
4. **`--transcript` with tool uses**: assistant messages show tool use tree with `├` / `└` formatting.
5. **`--transcript` with thinking blocks**: thinking blocks render as `[thinking... N chars]`.
6. **`--transcript` long transcript**: truncates at 50 messages with "N more messages" footer.
7. **`--events`**: renders chronological event table with TYPE and DATA columns.
8. **`--events` event data column**: session.start shows branch+model, git.commit shows hash+message, session.end shows duration+reason.
9. **`--git`**: renders git activity table with hash, message, branch, files, insertions/deletions.
10. **`--git` with push**: push events render below the commit table.
11. **`--git` no activity**: prints "No git activity during this session."
12. **`--export json`**: writes valid JSON file to disk with session + transcript + events + git.
13. **`--export md`**: writes well-formed Markdown file with all sections.
14. **`--export json` confirmation**: prints file path and size after writing.
15. **`--tag refactoring`**: calls PATCH endpoint with updated tags, prints confirmation.
16. **`--tag` duplicate**: tag already exists, prints "already has tag" message.
17. **`--reparse`**: calls POST reparse endpoint, prints confirmation.
18. **Session not found**: prints "Session not found: <id>" message.
19. **Ambiguous prefix**: lists candidate sessions with metadata.
20. **Short prefix (< 8 chars)**: rejects with minimum length message.
21. **Session in "capturing" state + --transcript**: prints "Transcript not yet available" message.
22. **Session in "failed" state + --transcript**: prints "parsing failed" with reparse hint.

### `packages/cli/src/lib/__tests__/transcript-renderer.test.ts`

1. **Human message**: renders `[N] Human (HH:MM):` followed by indented text content.
2. **Assistant message with text only**: renders `[N] Assistant (HH:MM):` followed by indented text.
3. **Assistant message with tool uses**: text content + tool use tree with `├` and `└` characters.
4. **Tool use tree -- middle items use `├`**: first and middle tool uses show `├`.
5. **Tool use tree -- last item uses `└`**: final tool use shows `└`.
6. **Read tool**: displays `Read: <filepath>` from input.
7. **Edit tool**: displays `Edit: <filepath> (+N -M)` with diff stats from result.
8. **Write tool**: displays `Write: <filepath>`.
9. **Bash tool**: displays `Bash: <command truncated to 60 chars> (exit N)`.
10. **Grep/Glob tool**: displays `Grep: <pattern>` or `Glob: <pattern>`.
11. **Unknown tool**: displays `ToolName: <first 60 chars of input>`.
12. **Thinking block**: renders as dimmed `[thinking... N chars]`.
13. **Thinking block with showThinking=true**: renders full thinking content.
14. **Empty content blocks**: handles messages with no content gracefully.
15. **Message truncation**: when exceeding `maxMessages`, shows truncation footer.
16. **Text wrapping**: long text content wraps at `maxWidth - 2`.

## Success Criteria

1. `fuel-code session <id>` prints a formatted summary card with workspace, device, timing, cost, model, branch, summary, stats, and tags.
2. Session ID resolution accepts full ULIDs (26 chars) and unambiguous prefixes (8+ chars).
3. Ambiguous prefixes list candidate sessions with enough metadata to disambiguate.
4. Prefixes shorter than 8 chars are rejected with a clear minimum length message.
5. `--transcript` renders the full parsed transcript with tool use tree formatting.
6. Transcript renderer uses `├` for intermediate and `└` for final tool uses in a sequence.
7. Tool use summaries are tool-type-specific (Read shows path, Bash shows command + exit code, etc.).
8. Thinking blocks are collapsed by default, showing only character count.
9. `--events` shows a chronological event table with type-specific data formatting.
10. `--git` shows git activity with commit details, diff stats, and push/merge info.
11. `--export json` writes a complete JSON file with session + transcript + events + git + export timestamp.
12. `--export md` writes a well-structured Markdown document suitable for reading or sharing.
13. Both export formats print file path and size confirmation after writing.
14. `--tag` adds a tag (checking for duplicates first) and confirms.
15. `--reparse` triggers re-parsing and confirms.
16. `--json` outputs the default summary view as machine-readable JSON.
17. Sessions in early lifecycle states show appropriate "not yet available" messages for transcript/events.
18. Failed sessions show reparse hint when transcript is requested.
19. The transcript renderer is a separate, importable module (`packages/cli/src/lib/transcript-renderer.ts`) for TUI reuse.
20. Data-fetching functions are exported for TUI reuse (`fetchSessionDetail`, `fetchSessionTranscript`, etc.).
21. All error states produce user-friendly messages (no stack traces).
22. The command is registered in `packages/cli/src/index.ts` and appears in `fuel-code --help`.
23. All tests pass (`bun test`).
