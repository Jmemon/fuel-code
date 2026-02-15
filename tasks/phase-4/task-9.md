# Task 9: TUI: Session Detail View (Transcript Viewer, Git Sidebar)

## Parallel Group: C

## Dependencies: Tasks 5, 7

## Description

Build the TUI session detail view — the second screen of the TUI, reached by pressing Enter on a session in the dashboard. This task implements the CORE.md "Session Detail View" mockup: a header with session metadata, a scrollable transcript viewer in the left panel, a sidebar with git activity / tool usage / modified files in the right panel, tab switching between transcript/events/git views, and live updates for active sessions.

### Target Layout (from CORE.md)

```
┌─ Session: fuel-code ─────────────────────────────────────────────────┐
│  Workspace: fuel-code     Device: macbook-pro (local)                │
│  Started: 47m ago         Duration: 47m         Cost: $0.42          │
│  Tokens: 125K in / 48K out / 890K cache                             │
│  Summary: Refactored authentication middleware to use JWT tokens...  │
│                                                                      │
│  TRANSCRIPT                       │  SIDEBAR                         │
│  ──────────                       │  ───────                         │
│  [1] Human:                       │  Git Activity:                   │
│    Fix the auth bug in login...   │  ● abc123 refactor: JWT auth     │
│                                   │  ● def456 test: JWT validation   │
│  [2] Assistant:                   │                                  │
│    I'll investigate the auth...   │  Tools Used:                     │
│    ├ Read: src/auth/middleware.ts  │  Edit     12                     │
│    ├ Read: src/auth/jwt.ts        │  Read     15                     │
│    ├ Edit: src/auth/middleware.ts  │  Bash      8                     │
│    └ Bash: bun test               │  Grep      4                     │
│                                   │  Write     3                     │
│  [3] Human:                       │                                  │
│    Now add tests for the JWT...   │  Files Modified:                 │
│                                   │  src/auth/middleware.ts           │
│  [4] Assistant:                   │  src/auth/jwt.ts                 │
│    I'll write tests for...        │  src/auth/__tests__/jwt.test.ts  │
│                                   │                                  │
│──────────────────────────────────────────────────────────────────────│
│  b:back  t:toggle-transcript  g:git  e:events  x:export  q:quit     │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Tree

```
<SessionDetailView sessionId apiClient wsClient onBack>
  <SessionHeader>                       — Top 4 lines: workspace, device, duration, cost, tokens, summary
  <Box flexDirection="row">
    <TranscriptViewer>                  — Left panel (~65% width): scrollable transcript
      <MessageBlock message>            — Individual conversation turn
        <ToolUsageLine>                 — Inline tool usage with tree chars (├/└)
    <Sidebar>                           — Right panel (~35% width): three stacked panels
      <GitActivityPanel>                — Commits with short hash + message
      <ToolsUsedPanel>                  — Tool name → count table, sorted desc
      <FilesModifiedPanel>              — Unique file paths from git + content blocks
  <FooterBar>                           — Key hints: b:back  t:transcript  g:git  e:events  x:export  q:quit
```

### Session Detail View (`packages/cli/src/tui/SessionDetailView.tsx`)

```typescript
// Main session detail view component.
// Fetches all data in parallel on mount: session metadata, transcript, git activity.
// For live (capturing) sessions, subscribes to session_id via WsClient for real-time updates.

interface SessionDetailProps {
  apiClient: ApiClient;
  wsClient: WsClient;
  sessionId: string;
  onBack: () => void;
}

// Internal state:
// - session: Session | null (metadata: workspace, device, duration, cost, tokens, summary)
// - transcript: TranscriptMessage[] | null (parsed conversation turns)
// - events: Event[] | null (raw events, fetched lazily on 'e' tab)
// - gitActivity: GitActivity[] | null (commits, pushes during session)
// - activeTab: 'transcript' | 'events' | 'git' (default: 'transcript')
// - scrollOffset: number (for transcript/events scrolling)
// - loading: boolean
// - error: Error | null
```

**Data fetching on mount** — uses the `useSessionDetail` hook:
1. `apiClient.getSession(sessionId)` — session metadata
2. `apiClient.getSessionTranscript(sessionId)` — parsed transcript messages + content blocks
3. `apiClient.getSessionGit(sessionId)` — git activity

All three run in `Promise.all` on mount for parallel loading.

**Keybindings** (handled via `useInput`):
- `b` or `Escape`: call `onBack()` — return to Dashboard
- `t`: switch to transcript tab (default)
- `e`: switch to events tab (lazy-fetch events on first switch)
- `g`: switch to git tab (git activity displayed full-width, replacing the split-pane layout)
- `j` / `Down arrow`: scroll down by one message (transcript) or one event (events tab)
- `k` / `Up arrow`: scroll up by one message
- `Space` / `PageDown`: scroll down by one page (visible height)
- `x`: trigger export — write session data to `session-<id>.json` in current directory, print path to stderr
- `q`: quit entire TUI (handled by parent App)

### SessionHeader (`packages/cli/src/tui/components/SessionHeader.tsx`)

Renders the top 4 lines of metadata:

```typescript
// Props: session: Session
//
// Line 1: Workspace: fuel-code     Device: macbook-pro (local)
// Line 2: Started: 47m ago         Duration: 47m         Cost: $0.42
// Line 3: Tokens: 125K in / 48K out / 890K cache
// Line 4: Summary: Refactored authentication middleware to use JWT tokens...
//
// For live (capturing) sessions:
// - Duration shows a live elapsed time counter that increments every second
// - Cost shows current running cost
// - Summary may show "Session in progress..." if no summary yet
```

Uses `formatDuration`, `formatCost`, `formatTokens`, `formatRelativeTime` from Task 3's formatter utilities for consistent value formatting.

### TranscriptViewer (`packages/cli/src/tui/components/TranscriptViewer.tsx`)

The left panel. Renders the parsed transcript as a scrollable list of conversation turns.

```typescript
// Props:
//   messages: TranscriptMessage[] | null
//   scrollOffset: number
//   visibleHeight: number (calculated from terminal rows minus header/footer)
//   onScroll: (newOffset: number) => void
//   paneWidth: number

// Rendering format for each message:
//
//   [N] Role (time):
//     Content text (word-wrapped to paneWidth - indent)
//     ├ ToolName: primary_argument
//     ├ ToolName: primary_argument
//     └ ToolName: primary_argument (last tool in sequence)
//
// Content block rendering by type:
// - text: word-wrap to available width, display as-is
// - thinking: render as dimmed "[thinking... N chars]" (single line, collapsed)
// - tool_use: render as "├ ToolName: primary_input" with tree-draw chars
//   - Read/Edit/Write tools → show file path: "├ Read: src/auth/middleware.ts"
//   - Bash tool → show command (truncated to 60 chars): "├ Bash: bun test src/auth/"
//   - Grep/Glob tools → show pattern: "├ Grep: auth.*middleware"
//   - Other tools → show first argument truncated
// - tool_result: skip (info already captured in the tool_use line above)
//
// Tree-draw characters:
// - ├ for tool_use blocks that are NOT the last in the message
// - └ for the LAST tool_use block in the message
//
// Scroll position indicator at bottom of transcript pane:
//   "Message 3 of 30" — updates as user scrolls
//
// If transcript is null (not yet fetched or not available):
//   Show "Transcript not yet available (status: <lifecycle>)" centered in pane
//   Where lifecycle comes from session.lifecycle: "detected", "capturing", "ended", "parsing"
```

**Scrolling behavior**:
- `j`/`k` scrolls by one message (one `TranscriptMessage`, which may be multiple rendered lines)
- `Space`/`PageDown` scrolls by `visibleHeight` messages
- Scroll offset clamped to `[0, messages.length - 1]`
- For live sessions: if user is scrolled to the bottom and new messages arrive, auto-scroll to show them. If user has scrolled up, do NOT auto-scroll (preserve their position).

### Sidebar (`packages/cli/src/tui/components/Sidebar.tsx`)

The right panel. Three vertically stacked sections.

```typescript
// Props:
//   gitActivity: GitActivity[] | null
//   transcript: TranscriptMessage[] | null (used to compute tools/files)
//   paneWidth: number

// === Git Activity ===
// Each commit rendered as:
//   ● <short_hash> <message truncated to fit>
// Example:
//   ● abc123 refactor: JWT auth middleware
//   ● def456 test: JWT validation tests
// If no git activity: "No git activity"
// Max 10 commits shown; if more, show "... N more commits"

// === Tools Used ===
// Frequency table computed from transcript content_blocks where type = 'tool_use'.
// Group by tool_name, count occurrences, sort descending.
// Rendered as aligned columns:
//   Edit     12
//   Read     15
//   Bash      8
//   Grep      4
//   Write     3
// If no tools: "No tool usage recorded"

// === Files Modified ===
// Sources:
//   1. From git_activity[].file_list — files from commits during the session
//   2. From content_blocks where tool_name in ('Edit', 'Write') — files touched by tools
// Deduplicate by file path. Sort alphabetically.
// Rendered as simple list:
//   src/auth/middleware.ts
//   src/auth/jwt.ts
//   src/auth/__tests__/jwt.test.ts
// If no files: "No files modified"
```

### GitActivityPanel, ToolsUsedPanel, FilesModifiedPanel

These are sub-components of `Sidebar` for clarity:

**`packages/cli/src/tui/components/GitActivityPanel.tsx`**: Renders the "Git Activity" section. Receives `gitActivity: GitActivity[]`.

**`packages/cli/src/tui/components/ToolsUsedPanel.tsx`**: Receives `toolCounts: Map<string, number>` (pre-computed from transcript). Renders frequency table.

**`packages/cli/src/tui/components/FilesModifiedPanel.tsx`**: Receives `files: string[]` (pre-computed, deduplicated). Renders file path list.

### MessageBlock (`packages/cli/src/tui/components/MessageBlock.tsx`)

Renders a single conversation turn (one `TranscriptMessage` with its `ContentBlock[]`).

```typescript
// Props:
//   message: TranscriptMessage
//   contentBlocks: ContentBlock[] (filtered to this message's ordinal)
//   paneWidth: number
//   isLastMessage: boolean (for auto-scroll awareness)

// Rendering:
// 1. Header line: [ordinal] Role (time) [· model · $cost]
//    - Role colored: Human = cyan, Assistant = green
//    - Model and cost only shown for Assistant messages
//    - Time formatted as "14:30" (just HH:MM)
//
// 2. Content blocks rendered in order:
//    - text → word-wrapped to (paneWidth - 4) with 4-space indent
//    - thinking → dimmed "[thinking... N chars]" on single line
//    - tool_use → tree line: "    ├ ToolName: primary_input"
//    - tool_result → skipped (info subsumed by tool_use)
//
// 3. Tree-draw characters for tool_use sequences:
//    - Collect consecutive tool_use blocks
//    - Use "├" for all but the last
//    - Use "└" for the last tool_use in the message
//    - If there's text content after tool_uses, the last tool still gets "└"
```

### Tab Switching

The `activeTab` state controls which content appears in the main (left) panel:

- **`t` — Transcript tab (default)**: Shows `<TranscriptViewer>` with `<Sidebar>` on the right. Standard split-pane layout (65%/35%).
- **`e` — Events tab**: Replaces `<TranscriptViewer>` with an events list. Events are fetched lazily on first switch via `apiClient.getSessionEvents(sessionId)`. Rendered as a table:
  ```
  TIME       TYPE              DATA
  14:30:01   session.start     branch=main model=claude-sonnet-4-5
  14:31:15   git.commit        abc123 "refactor: JWT auth middleware"
  14:34:22   git.commit        def456 "test: add JWT validation tests"
  14:45:00   session.end       duration=47m reason=exit
  ```
  Sidebar remains visible showing the same git/tools/files panels.
- **`g` — Git tab**: Shows git activity in full-width mode (no sidebar split). Each commit shown with full detail:
  ```
  ● abc123  refactor: JWT auth middleware         main   +15 -8   3 files
    src/auth/middleware.ts (M)
    src/auth/jwt.ts (M)
    src/routes/login.ts (M)

  ● def456  test: add JWT validation tests        main   +45 -0   1 file
    src/auth/__tests__/jwt.test.ts (A)
  ```
  Scrollable with j/k.

Each tab caches its fetched data so switching back doesn't re-fetch.

### Live Updates for Active Sessions

For sessions with `lifecycle === 'capturing'`:

1. **WS subscription**: Subscribe to `session_id` via `wsClient.subscribe({ session_id: sessionId })` on mount. Unsubscribe on unmount.
2. **`session.update` messages**: Update the session header in real-time — refresh `lifecycle`, `summary`, `stats` (tokens, cost, duration).
3. **Elapsed time counter**: For capturing sessions, the Duration field in the header increments every second using a `setInterval`. Shows live elapsed time: "12m", "13m", etc.
4. **Transcript refresh for live sessions**: Since WS does not stream individual transcript messages (that would require deep integration with the CC hook), poll `apiClient.getSessionTranscript(sessionId)` every 5 seconds for live sessions to pick up new messages. If new messages arrive, append them. If user is scrolled to bottom, auto-scroll.

On unmount (navigating back): unsubscribe from the session_id WS channel and clear all intervals.

### useSessionDetail Hook (`packages/cli/src/tui/hooks/useSessionDetail.ts`)

```typescript
// Fetches all session detail data in parallel on mount.
// For live sessions, subscribes via WS and polls transcript.
// Returns all data + loading/error state.

export function useSessionDetail(
  apiClient: ApiClient,
  wsClient: WsClient,
  sessionId: string
): {
  session: Session | null;
  transcript: TranscriptMessage[] | null;
  gitActivity: GitActivity[] | null;
  events: Event[] | null;        // null until events tab is activated
  loading: boolean;
  error: Error | null;
  fetchEvents: () => void;       // lazy-fetch for events tab
  isLive: boolean;               // session.lifecycle === 'capturing'
}
```

Implementation:
1. On mount: `Promise.all([getSession, getTranscript, getSessionGit])`. Set state on resolve.
2. If session is live: subscribe to `session_id` on WS. Set up 5-second transcript polling interval.
3. On `session.update` WS message matching this session: update `session` state fields.
4. `fetchEvents()`: called when user switches to events tab for the first time. Fetches `getSessionEvents(sessionId)`.
5. On unmount: unsubscribe from WS, clear intervals.

### Data Layer Reuse

Import data-fetch functions from Task 5's session detail command:

```typescript
// The CLI session-detail command exports its data-fetching logic:
import { fetchSessionDetail, renderTranscript } from '../commands/session-detail';
```

The hook uses these functions for fetching. The TUI components render the data through Ink components instead of stdout strings.

### Integration with App Shell (Task 8)

Modify `packages/cli/src/tui/App.tsx` to render `<SessionDetailView>` when the view state is `'session-detail'`:

```tsx
// Replace the SessionDetailPlaceholder from Task 8 with the real component:
import { SessionDetailView } from './SessionDetailView';

// In the App component's render:
if (view.type === 'session-detail') {
  return (
    <SessionDetailView
      apiClient={apiClient}
      wsClient={wsClient}
      sessionId={view.sessionId}
      onBack={() => setView({ type: 'dashboard' })}
    />
  );
}
```

### Tests

**`packages/cli/src/tui/__tests__/SessionDetail.test.tsx`** (using `ink-testing-library`):

Mock `ApiClient` returns canned session, transcript, and git data. Mock `WsClient` is an EventEmitter stub.

1. Session header renders workspace name, device name, duration, cost, and summary.
2. Session header renders token counts formatted as "125K in / 48K out / 890K cache".
3. Transcript tab (default) renders messages in correct order with ordinal numbers and roles.
4. Human messages show role in cyan; Assistant messages in green.
5. Assistant messages show tool usage with tree-draw characters (├ and └).
6. Thinking blocks render as dimmed "[thinking... N chars]" (collapsed).
7. Scroll position indicator shows "Message 1 of N" and updates on scroll.
8. Pressing `j` increments scroll offset; pressing `k` decrements it.
9. Pressing `Space` scrolls by page (visibleHeight messages).
10. Scroll offset is clamped — cannot go below 0 or above `messages.length - 1`.
11. Sidebar renders git activity section with commits (short hash + message).
12. Sidebar renders tools used section with frequency table sorted by count descending.
13. Sidebar renders files modified section with deduplicated, sorted file paths.
14. Pressing `e` switches to events tab and triggers lazy event fetch.
15. Events tab renders chronological event table with timestamp, type, and data.
16. Pressing `g` switches to git tab showing full-width git activity with file lists per commit.
17. Pressing `t` switches back to transcript tab (data preserved, no re-fetch).
18. Pressing `b` calls `onBack()` to return to the dashboard.
19. Session with no transcript (lifecycle = "detected") shows "Transcript not yet available (status: detected)".
20. Session with no git activity shows "No git activity" in the sidebar.
21. Session with no tool usage shows "No tool usage recorded" in the sidebar.
22. Live (capturing) session: `useSessionDetail` subscribes to `session_id` via WS.
23. Live session: WS `session.update` message updates the header (lifecycle, summary, cost).
24. Live session: elapsed time counter in header increments (test with fake timers).
25. Export keybinding `x` writes session JSON to file and shows confirmation.
26. Loading state shows spinner while initial data is being fetched.
27. API error on fetch shows error message in the view (no crash).

**`packages/cli/src/tui/__tests__/TranscriptViewer.test.tsx`**:

1. Renders empty state when `messages` is null: "Transcript not yet available".
2. Renders empty state when `messages` is empty array: "No messages in transcript".
3. Renders a single Human message with ordinal, role, and text content.
4. Renders an Assistant message with text + inline tool uses.
5. Tool use tree characters: middle tools get `├`, last tool gets `└`.
6. Read/Edit/Write tools show file path as primary argument.
7. Bash tool shows command truncated to 60 characters.
8. Grep/Glob tools show the search pattern.
9. Thinking block renders as "[thinking... 1234 chars]" in dim color.
10. Long text content is word-wrapped to `paneWidth`.
11. Scroll position renders correctly: "Message 1 of 30".
12. Auto-scroll: when `scrollOffset` equals last message and new messages arrive, offset advances.
13. No auto-scroll: when user has scrolled up, new messages do not change offset.

**`packages/cli/src/tui/__tests__/Sidebar.test.tsx`**:

1. Git activity section renders commits with `●` bullet, short hash, and truncated message.
2. Git activity with >10 commits shows first 10 and "... N more commits".
3. Tools used section computes correct counts from content blocks.
4. Tools used table is sorted by count descending.
5. Files modified section deduplicates paths from git activity and content blocks.
6. Files modified section sorts paths alphabetically.
7. Empty git activity shows "No git activity".
8. Empty tools shows "No tool usage recorded".
9. Empty files shows "No files modified".

**`packages/cli/src/tui/__tests__/MessageBlock.test.tsx`**:

1. Human message renders with `[1] Human (14:30):` header.
2. Assistant message renders with `[2] Assistant (14:31) · claude-sonnet-4-5 · $0.03:` header.
3. Text content is indented 4 spaces and word-wrapped.
4. Tool use sequence: 3 tools → first two get `├`, last gets `└`.
5. Primary input extraction: Read → file path, Bash → command, Edit → file path, Grep → pattern.
6. Tool result blocks are skipped (not rendered).

## Relevant Files

### Create
- `packages/cli/src/tui/SessionDetailView.tsx` — main session detail view component
- `packages/cli/src/tui/components/SessionHeader.tsx` — metadata header (workspace, device, duration, cost, tokens, summary)
- `packages/cli/src/tui/components/TranscriptViewer.tsx` — scrollable parsed transcript viewer
- `packages/cli/src/tui/components/Sidebar.tsx` — right panel: git + tools + files
- `packages/cli/src/tui/components/GitActivityPanel.tsx` — git commits sub-panel
- `packages/cli/src/tui/components/ToolsUsedPanel.tsx` — tool frequency table sub-panel
- `packages/cli/src/tui/components/FilesModifiedPanel.tsx` — modified files list sub-panel
- `packages/cli/src/tui/components/MessageBlock.tsx` — single conversation turn renderer
- `packages/cli/src/tui/components/FooterBar.tsx` — keybinding hints footer
- `packages/cli/src/tui/hooks/useSessionDetail.ts` — hook: parallel fetch + WS subscription + live polling
- `packages/cli/src/tui/__tests__/SessionDetail.test.tsx` — session detail view tests
- `packages/cli/src/tui/__tests__/TranscriptViewer.test.tsx` — transcript viewer tests
- `packages/cli/src/tui/__tests__/Sidebar.test.tsx` — sidebar tests
- `packages/cli/src/tui/__tests__/MessageBlock.test.tsx` — message block tests

### Modify
- `packages/cli/src/tui/App.tsx` — replace SessionDetail placeholder with real `<SessionDetailView>` component

## Success Criteria

1. Pressing Enter on a session in the Dashboard opens the SessionDetailView for that session.
2. Session header displays: workspace, device, duration, cost, tokens (formatted as "125K in / 48K out / 890K cache"), and summary.
3. Transcript panel renders conversation turns in chronological order with correct ordinal numbers `[1]`, `[2]`, etc.
4. Human messages show role label in cyan; Assistant messages in green.
5. Assistant messages show inline tool usage with tree-draw characters: `├` for middle tools, `└` for the last tool.
6. Tool use lines show the primary argument: file path for Read/Edit/Write, command for Bash, pattern for Grep/Glob.
7. Thinking blocks render as collapsed single-line `[thinking... N chars]` in dim color (not full thinking text).
8. Transcript is scrollable: `j`/`k` moves by one message, `Space`/`PageDown` by one page.
9. Scroll position indicator shows "Message N of M" and updates on scroll.
10. Scroll offset is clamped to valid range (0 to messages.length - 1).
11. Sidebar shows git activity: commits with `●` bullet, short hash, and truncated message.
12. Sidebar shows tools used: frequency table (tool name → count) sorted by count descending.
13. Sidebar shows files modified: deduplicated file paths from git activity and tool content blocks, sorted alphabetically.
14. Tab switching works: `t` for transcript (default), `e` for events (lazy fetch), `g` for git (full-width).
15. Events tab fetches data lazily on first switch, then caches for subsequent switches.
16. Git tab shows full-width git activity with file lists per commit.
17. Tab data is cached — switching between tabs does not re-fetch.
18. `b` key (or Escape) returns to the Dashboard view.
19. `x` key exports session data as JSON to `session-<id>.json` in the current directory.
20. Live (capturing) sessions: subscribe to `session_id` via WsClient on mount, unsubscribe on unmount.
21. Live sessions: WS `session.update` updates header fields (lifecycle, summary, stats) in real-time.
22. Live sessions: elapsed time counter in Duration field increments every second.
23. Live sessions: transcript polls every 5 seconds for new messages; auto-scrolls if user is at bottom.
24. Empty states handled: no transcript → "Transcript not yet available (status: <lifecycle>)"; no git → "No git activity"; no tools → "No tool usage recorded"; no files → "No files modified".
25. Loading state shows spinner while initial data loads.
26. API errors display an error message within the view (no unhandled crash).
27. All tests pass (`bun test`).
