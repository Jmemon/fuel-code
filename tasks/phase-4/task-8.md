# Task 8: TUI: Shell + Dashboard View (Sessions by Workspace, Live Updates)

## Parallel Group: C

## Dependencies: Tasks 4, 6, 7

## Description

Build the Ink-based TUI that launches when the user runs `fuel-code` with no arguments. This task has two parts: the TUI shell (view routing, client lifecycle, global keybindings) and the Dashboard view (sessions grouped by workspace with live WebSocket updates). After this task, the user can launch `fuel-code`, see all their workspaces on the left, sessions on the right, and watch live sessions update in real-time.

### Part 1: TUI Shell (`packages/cli/src/tui/App.tsx`)

The shell is the top-level React component that owns the `ApiClient` and `WsClient` instances, manages view routing, and handles global keybindings.

```tsx
// packages/cli/src/tui/App.tsx
//
// Top-level TUI application. Manages view routing between Dashboard and SessionDetail.
// Owns ApiClient and WsClient instances — both created once and passed as props.

import React, { useState, useEffect } from 'react';
import { render, useInput, useApp } from 'ink';
import { ApiClient } from '../lib/api-client';
import { WsClient } from '../lib/ws-client';
import { Dashboard } from './Dashboard';
// SessionDetail is imported later by Task 9; for now, show a placeholder

type View =
  | { type: 'dashboard' }
  | { type: 'session-detail'; sessionId: string };

export function App() {
  const [view, setView] = useState<View>({ type: 'dashboard' });
  const [apiClient] = useState(() => ApiClient.fromConfig(loadConfig()));
  const [wsClient] = useState(() => WsClient.fromConfig(loadConfig()));
  const { exit } = useApp();

  // Connect WS on mount, subscribe to "all", disconnect on unmount
  useEffect(() => {
    wsClient.connect().catch(() => {
      // WS connection failure is non-fatal; dashboard falls back to polling
    });
    wsClient.subscribe({ scope: 'all' });
    return () => wsClient.disconnect();
  }, []);

  // Global keybinding: q exits the app
  useInput((input, key) => {
    if (input === 'q') exit();
    if (input === 'b' && view.type !== 'dashboard') {
      setView({ type: 'dashboard' });
    }
  });

  if (view.type === 'dashboard') {
    return (
      <Dashboard
        apiClient={apiClient}
        wsClient={wsClient}
        onSelectSession={(id) => setView({ type: 'session-detail', sessionId: id })}
      />
    );
  }

  if (view.type === 'session-detail') {
    // SessionDetail component added by Task 9.
    // For now, render a placeholder that shows the session ID and b:back hint.
    return <SessionDetailPlaceholder sessionId={view.sessionId} />;
  }
}

export async function launchTui() {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
```

**Entry point wiring** — modify `packages/cli/src/index.ts`:

When commander receives no subcommand (the default action), dynamically import and launch the TUI:

```typescript
// Default action: no subcommand → launch TUI
program.action(async () => {
  const { launchTui } = await import('./tui/App');
  await launchTui();
});
```

Dynamic import so Ink/React are not loaded for non-TUI commands (keeps `fuel-code sessions` fast).

### Part 2: Dashboard View (`packages/cli/src/tui/Dashboard.tsx`)

Match the CORE.md "Main View: Sessions by Workspace" mockup exactly:

```
┌─ fuel-code ─────────────────────────────────────────────────────────┐
│                                                                      │
│  WORKSPACES           │  SESSIONS                                    │
│  ──────────           │  ────────                                    │
│                       │                                              │
│  ► fuel-code    (3)   │  ● LIVE  macbook-pro              12m $0.18 │
│    api-service  (1)   │    Redesigning the event pipeline            │
│    dotfiles     (0)   │    Edit(3) Bash(2) Read(5)                   │
│    _unassociated(2)   │                                              │
│                       │  ✓ DONE  macbook-pro       47m $0.42 · 2↑   │
│                       │    Refactored auth middleware to use JWT      │
│                       │    abc123 refactor: JWT auth middleware       │
│                       │    def456 test: add JWT validation tests     │
│                       │                                              │
│                       │  ✓ DONE  remote-abc       1h22m $1.87 · 5↑  │
│                       │    Implemented cursor-based pagination        │
│                       │    7890ab feat: cursor-based pagination      │
│                       │    ... 4 more commits                        │
│                       │                                              │
│                       │  ✓ DONE  macbook-pro        23m $0.31 · 1↑  │
│                       │    Fixed timezone handling in event timestamps│
│                       │                                              │
│──────────────────────────────────────────────────────────────────────│
│  Today: 4 sessions · 2h50m · $2.78 · 8 commits                      │
│  Queue: 0 pending · Backend: connected (ws)                          │
│  j/k:navigate  enter:detail  f:filter  r:refresh  /:search  q:quit  │
└──────────────────────────────────────────────────────────────────────┘
```

**Layout**: Two-column flexbox using Ink's `<Box>`:
- Left column (~30% width): `<WorkspaceList>` — workspace names + session counts. Selected workspace highlighted with `►` prefix and bold/inverse styling. Navigate with j/k when workspace pane has focus.
- Right column (~70% width): `<SessionList>` — sessions for the currently selected workspace. Each session rendered by `<SessionRow>`.
- Bottom: `<StatusBar>` — spans full width with 3 lines: today's aggregate stats, queue/WS status, key hints.

**Dashboard component state**:

```typescript
// packages/cli/src/tui/Dashboard.tsx

interface DashboardProps {
  apiClient: ApiClient;
  wsClient: WsClient;
  onSelectSession: (sessionId: string) => void;
}

// Internal state:
// - workspaces: WorkspaceSummary[] (from useWorkspaces hook)
// - sessions: Session[] (from useSessions hook, scoped to selected workspace)
// - selectedWorkspaceIndex: number (default 0)
// - selectedSessionIndex: number (default 0)
// - focusPane: 'workspaces' | 'sessions' (default 'workspaces')
// - wsConnected: boolean (from useWsConnection hook)
// - todayStats: { sessions: number; duration: number; cost: number; commits: number }
```

**Keyboard bindings** (handled via `useInput`):
- `j` / `Down arrow`: move selection down within the focused pane
- `k` / `Up arrow`: move selection up within the focused pane
- `Tab`: toggle focus between workspace list and session list
- `Enter`: if focus is on session list, call `onSelectSession(selectedSession.id)`
- `r`: re-fetch all data (workspaces + sessions + stats)
- `q`: quit (handled by parent App)

When `selectedWorkspaceIndex` changes, fetch sessions for the newly selected workspace. Reset `selectedSessionIndex` to 0.

### WebSocket Live Updates

The Dashboard subscribes to `scope: "all"` (done by the App shell). It listens for WS messages and updates state:

- **`session.update`**: Find the matching session in the current sessions list by `session_id`. Update its `lifecycle`, `summary`, and `stats` fields in-place. This covers lifecycle transitions (capturing → ended → parsed → summarized) and progressive summary updates.
- **`event` of type `session.start`**: If the new session belongs to the currently selected workspace, prepend it to the sessions list. Also increment the session count on the matching workspace in the workspace list.
- **`event` of type `session.end`**: Find the matching session, update its lifecycle to `ended`.

**Re-render debouncing**: WS messages can arrive rapidly (especially during active sessions). Debounce state updates so the UI re-renders at most 2 times per second. Use a `useRef` to buffer incoming updates and a `setInterval` (500ms) to flush buffered updates to state.

**Polling fallback**: If the WS connection drops (detected via `useWsConnection` returning `connected: false`), start a polling interval that re-fetches workspaces and sessions every 10 seconds. Stop polling when WS reconnects. Show "WS: ○ Polling (10s)" in the status bar instead of "WS: ● Connected".

### React Hooks

**`packages/cli/src/tui/hooks/useWorkspaces.ts`**:

```typescript
// Fetches workspace list from API. Returns typed state.
// Refreshes on manual trigger or WS event.
export function useWorkspaces(apiClient: ApiClient): {
  workspaces: WorkspaceSummary[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}
```

Implementation: `useEffect` fetches on mount via `apiClient.listWorkspaces()`. Stores result in state. `refresh()` re-triggers the fetch. Handles errors by setting `error` state (not throwing).

**`packages/cli/src/tui/hooks/useSessions.ts`**:

```typescript
// Fetches sessions for a specific workspace. Re-fetches when workspaceId changes.
// Supports in-place updates from WS messages.
export function useSessions(
  apiClient: ApiClient,
  workspaceId: string | null
): {
  sessions: Session[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  prependSession: (session: Session) => void;
}
```

Implementation: `useEffect` with `workspaceId` dependency. Calls `apiClient.listSessions({ workspace_id: workspaceId })`. The `updateSession` and `prependSession` methods allow WS message handlers to modify the list without a full re-fetch.

**`packages/cli/src/tui/hooks/useWsConnection.ts`**:

```typescript
// Manages WsClient lifecycle awareness for components.
// Listens for connected/disconnected events on the WsClient.
export function useWsConnection(wsClient: WsClient): {
  connected: boolean;
  reconnecting: boolean;
}
```

Implementation: Listens to `wsClient.on('connected', ...)` and `wsClient.on('disconnected', ...)`. Returns reactive boolean state.

**`packages/cli/src/tui/hooks/useTodayStats.ts`**:

```typescript
// Fetches today's aggregate stats for the status bar.
// Returns: session count, total duration, total cost, commit count.
export function useTodayStats(apiClient: ApiClient): {
  stats: { sessions: number; duration: number; cost: number; commits: number } | null;
  loading: boolean;
}
```

Implementation: Fetches `apiClient.listSessions({ after: startOfToday() })` and aggregates. Refreshes every 60 seconds.

### Shared TUI Components (`packages/cli/src/tui/components/`)

**`WorkspaceItem.tsx`**:
```typescript
// Renders a single workspace row in the sidebar.
// Props: workspace: WorkspaceSummary, selected: boolean, focused: boolean
// Selected: shows "►" prefix, bold text
// Active sessions indicated with colored session count: "(3)" in green if any are capturing
```

**`SessionRow.tsx`**:
```typescript
// Renders a single session in the session list.
// Line 1: STATUS_ICON  DEVICE_NAME              DURATION  COST [· N↑]
// Line 2:   Summary text (truncated to available width)
// Line 3 (if LIVE): Tool counts: Edit(N) Bash(N) Read(N) ...
// Line 3 (if DONE with commits): First 2 commit messages (short hash + message)
// Line 4 (if >2 commits): "... N more commits"
//
// Status icons match formatLifecycle from Task 3's formatter:
//   capturing → green "● LIVE"
//   summarized → "✓ DONE"
//   failed → red "✗ FAIL"
//   ended/parsed → yellow "◌ ..."
//
// Props: session: Session, selected: boolean
// Selected: highlighted background or bold border
```

**`StatusBar.tsx`**:
```typescript
// Bottom status bar. Three lines:
// Line 1: Today: N sessions · XhYm · $X.XX · N commits
// Line 2: Queue: N pending · Backend: connected (ws) | disconnected | polling (10s)
// Line 3: j/k:navigate  enter:detail  tab:switch  r:refresh  q:quit
//
// Props: todayStats, queueDepth, wsConnected, wsReconnecting
```

**`Spinner.tsx`**:
```typescript
// Simple animated loading indicator using Ink's built-in spinner or dots animation.
// Shows "Loading..." with animated dots.
```

**`ErrorBanner.tsx`**:
```typescript
// Displays an error message in red.
// Props: message: string
// Renders: ✗ Error: <message>
// Auto-dismisses after 5 seconds (optional prop: persistent: boolean)
```

### Data Layer Reuse

Import data-fetching functions from Task 4 (`sessions` command) and Task 6 (`workspaces` command):

```typescript
// Dashboard uses:
import { fetchSessions } from '../commands/sessions';      // Task 4
import { fetchWorkspaces } from '../commands/workspaces';   // Task 6
```

The hooks call these exported data-layer functions, which in turn call the `ApiClient`. This avoids duplicating fetch/transform logic between CLI and TUI.

### TSX and Dependency Setup

Ensure `packages/cli/tsconfig.json` has JSX support:
```json
{
  "compilerOptions": {
    "jsx": "react-jsx"
  }
}
```

Dependencies (if not already added by prior tasks):
```bash
cd packages/cli && bun add ink react picocolors
cd packages/cli && bun add -d @types/react ink-testing-library
```

### Tests

**`packages/cli/src/tui/__tests__/Dashboard.test.tsx`** (using `ink-testing-library`):

All tests use mock `ApiClient` and `WsClient` instances that return canned data.

1. Dashboard renders workspace list on mount with workspace names and session counts.
2. First workspace is selected by default; its sessions appear in the right pane.
3. Pressing `j` moves workspace selection down; pressing `k` moves it up.
4. Changing selected workspace fetches and displays that workspace's sessions.
5. Pressing `Tab` switches focus from workspace pane to session pane.
6. In session pane, `j`/`k` navigates sessions; selected session is highlighted.
7. Pressing `Enter` on a selected session calls `onSelectSession` with the session ID.
8. Pressing `r` re-fetches workspaces and sessions (calls `refresh()` on both hooks).
9. `SessionRow` displays correct status icon for each lifecycle state (LIVE, DONE, FAIL, PARSING).
10. Live (capturing) sessions show tool usage counts on the third line.
11. Summarized sessions with commits show commit messages beneath the summary.
12. `StatusBar` shows today's aggregate stats (session count, duration, cost, commits).
13. `StatusBar` shows "WS: ● Connected" when WS is connected and "WS: ○ Polling (10s)" when disconnected.
14. WS `session.update` message updates the matching session's lifecycle and summary in-place without full re-fetch.
15. WS `event` of type `session.start` prepends a new session to the list.
16. Empty workspace list shows "No workspaces found. Run `fuel-code init` to get started."
17. API error on initial fetch shows `ErrorBanner` with the error message (no crash).
18. Loading state shows `Spinner` while data is being fetched.

**`packages/cli/src/tui/__tests__/hooks.test.ts`**:

1. `useWorkspaces`: fetches workspace list on mount, returns `{ workspaces, loading: false }`.
2. `useWorkspaces`: `refresh()` re-fetches and updates state.
3. `useWorkspaces`: API error sets `error` state, `workspaces` remains empty array.
4. `useSessions`: fetches sessions when `workspaceId` is provided.
5. `useSessions`: re-fetches when `workspaceId` changes.
6. `useSessions`: `updateSession()` modifies a session in-place by ID.
7. `useSessions`: `prependSession()` adds a session to the front of the list.
8. `useSessions`: returns empty sessions array when `workspaceId` is null.
9. `useWsConnection`: reports `connected: true` after WS emits "connected" event.
10. `useWsConnection`: reports `connected: false` after WS emits "disconnected" event.

**`packages/cli/src/tui/__tests__/components.test.tsx`**:

1. `WorkspaceItem` renders workspace name and session count.
2. `WorkspaceItem` shows `►` prefix and bold style when selected.
3. `WorkspaceItem` shows green count when workspace has active (capturing) sessions.
4. `SessionRow` renders status icon, device name, duration, cost, and summary.
5. `SessionRow` for a live session shows tool usage counts.
6. `SessionRow` for a summarized session with 2 commits shows both commit messages.
7. `SessionRow` for a session with 5 commits shows first 2 and "... 3 more commits".
8. `StatusBar` renders key hints on the last line.
9. `Spinner` renders without crashing.
10. `ErrorBanner` renders error message in red.

## Relevant Files

### Create
- `packages/cli/src/tui/App.tsx` — TUI shell: view routing, client lifecycle, global keybindings
- `packages/cli/src/tui/Dashboard.tsx` — main dashboard view with two-column layout
- `packages/cli/src/tui/components/WorkspaceItem.tsx` — single workspace row component
- `packages/cli/src/tui/components/SessionRow.tsx` — single session row component
- `packages/cli/src/tui/components/StatusBar.tsx` — bottom status bar with stats, WS status, key hints
- `packages/cli/src/tui/components/Spinner.tsx` — loading indicator
- `packages/cli/src/tui/components/ErrorBanner.tsx` — error display component
- `packages/cli/src/tui/hooks/useWorkspaces.ts` — hook: fetch workspace list
- `packages/cli/src/tui/hooks/useSessions.ts` — hook: fetch sessions for workspace, supports in-place updates
- `packages/cli/src/tui/hooks/useWsConnection.ts` — hook: WS connection state
- `packages/cli/src/tui/hooks/useTodayStats.ts` — hook: today's aggregate stats
- `packages/cli/src/tui/__tests__/Dashboard.test.tsx` — dashboard component tests
- `packages/cli/src/tui/__tests__/hooks.test.ts` — hook unit tests
- `packages/cli/src/tui/__tests__/components.test.tsx` — shared component tests

### Modify
- `packages/cli/src/index.ts` — add default action that launches TUI via dynamic import
- `packages/cli/tsconfig.json` — ensure `"jsx": "react-jsx"` is set in compilerOptions
- `packages/cli/package.json` — add `ink`, `react`, `picocolors` dependencies; add `@types/react`, `ink-testing-library` dev dependencies (if not already added by prior tasks)

## Success Criteria

1. `fuel-code` with no arguments launches the Ink TUI dashboard (not a help message, not a crash).
2. The TUI shell creates `ApiClient` and `WsClient` once and passes them to views.
3. WS connection is established on mount with `subscribe({ scope: "all" })` and disconnected on unmount.
4. Global keybinding `q` exits the application cleanly (no lingering processes or timers).
5. View routing works: Dashboard is the default; pressing Enter on a session navigates to SessionDetail (placeholder until Task 9); pressing `b` navigates back.
6. Left pane shows all workspaces sorted by last session activity, each with name and session count.
7. First workspace is auto-selected and its sessions appear in the right pane.
8. `j`/`k` (or arrow keys) navigate workspace list when workspace pane has focus.
9. `Tab` toggles focus between workspace pane and session pane.
10. Changing workspace selection fetches and displays that workspace's sessions (via `useSessions` hook).
11. Session rows match the CORE.md mockup: status icon, device, duration, cost, commit count, summary, and (for completed sessions) commit messages.
12. Live (capturing) sessions show tool usage counts (Edit, Bash, Read, etc.) on their row.
13. `StatusBar` shows today's aggregate stats: session count, total duration, total cost, commit count.
14. `StatusBar` shows WS connection status: "● Connected" (green) or "○ Polling (10s)" (yellow).
15. `StatusBar` shows key hints: `j/k:navigate  enter:detail  tab:switch  r:refresh  q:quit`.
16. WS `session.update` messages update matching sessions in-place (lifecycle, summary, stats) without a full re-fetch.
17. WS `event` of type `session.start` prepends a new session if it belongs to the selected workspace.
18. Re-render debouncing limits WS-triggered updates to max 2 per second.
19. Polling fallback: if WS disconnects, sessions refresh every 10 seconds via API; polling stops when WS reconnects.
20. `r` key triggers a manual data refresh (re-fetches workspaces and sessions).
21. Empty states handled: "No workspaces found" when workspace list is empty; "No sessions" when selected workspace has zero sessions.
22. API errors show `ErrorBanner` with a user-friendly message (no React error boundary crash).
23. Loading state shows `Spinner` while initial data is being fetched.
24. Dynamic import of TUI module ensures `ink`/`react` are not loaded for non-TUI commands (e.g., `fuel-code sessions`).
25. All tests pass (`bun test`).
