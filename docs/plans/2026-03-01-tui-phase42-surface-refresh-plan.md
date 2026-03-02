# TUI Phase 4-2 Surface Refresh — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the split-pane dashboard with drill-down navigation, add team group collapsing, session chain indicators, subagent nesting, rich inline metadata (skills/worktrees/permission mode), and fix the backfill transition gap.

**Architecture:** The current `Dashboard.tsx` (two-pane: workspaces + sessions) splits into `WorkspacesView.tsx` (full-width workspace list) and `SessionsView.tsx` (full-width smart session list for one workspace). App.tsx routing gains a `workspaces` → `sessions` → `session-detail` drill-down. The session list uses client-side grouping of sessions by `team_name` to render collapsed/expanded team groups. The server's session list query gets three lightweight correlated subqueries for `subagent_types`, `skill_names`, and `worktree_names`.

**Tech Stack:** React (Ink), TypeScript, postgres.js, bun test

---

### Task 1: Backfill Transition Message

The quick fix. Add a status line between scan completion and ingestion start.

**Files:**
- Modify: `packages/cli/src/commands/backfill.ts:168-183`

**Step 1: Add the transition message**

In `packages/cli/src/commands/backfill.ts`, after the dry-run check and before state persistence, add a console.error line:

```typescript
// After line 167 (end of dry-run block):

  console.error("Preparing ingestion...");

  // Phase 2: Mark as running and persist state
```

Find this exact block (around line 169):

```typescript
  // Phase 2: Mark as running and persist state
  const updatedState: BackfillState = {
```

Add `console.error("Preparing ingestion...");` immediately before it, with a blank line after the `Found N sessions` message.

**Step 2: Verify manually**

Run: `fuel-code backfill --dry-run` (confirm it still works, no extra message)
Then a real backfill if possible, or just confirm the code reads correctly.

**Step 3: Commit**

```bash
git add packages/cli/src/commands/backfill.ts
git commit -m "add transition message between backfill scan and ingest phases"
```

---

### Task 2: Server — Add subagent_types, skill_names, worktree_names to Session List API

The session list endpoint (`GET /api/sessions`) currently returns `SELECT s.*` which gives us `team_name`, `team_role`, `subagent_count`, etc. But for rich inline display we need the actual subagent type names, skill names, and worktree names without a separate detail fetch.

**Files:**
- Modify: `packages/server/src/routes/sessions.ts:223-234` (the list query)
- Test: `packages/server/src/__tests__/e2e/phase4-2-relationships.test.ts` (add assertions)

**Step 1: Write a failing test**

Add a test to `packages/server/src/__tests__/e2e/phase4-2-relationships.test.ts` (or a new test file if cleaner) that:
1. Creates a session
2. Creates subagent rows for it (with distinct `agent_type` values)
3. Creates skill rows for it
4. Creates worktree rows for it
5. Fetches `GET /api/sessions?workspace_id=X`
6. Asserts the response includes `subagent_types`, `skill_names`, `worktree_names` arrays

```typescript
it("session list includes subagent_types, skill_names, worktree_names arrays", async () => {
  // ... setup session with subagents/skills/worktrees ...
  const res = await request(app).get(`/api/sessions?workspace_id=${workspaceId}`);
  expect(res.status).toBe(200);
  const session = res.body.sessions[0];
  expect(session.subagent_types).toEqual(expect.arrayContaining(["researcher"]));
  expect(session.skill_names).toEqual(expect.arrayContaining(["brainstorming"]));
  expect(session.worktree_names).toEqual(expect.arrayContaining(["feature-branch"]));
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test e2e/phase4-2 2>&1 | grep -E "(pass|fail)"`
Expected: FAIL — `subagent_types` is undefined.

**Step 3: Update the list query**

In `packages/server/src/routes/sessions.ts`, modify the session list SELECT (around line 223) from:

```sql
SELECT s.*,
       w.canonical_id AS workspace_canonical_id,
       w.display_name AS workspace_name,
       d.name AS device_name
FROM sessions s
```

To:

```sql
SELECT s.*,
       w.canonical_id AS workspace_canonical_id,
       w.display_name AS workspace_name,
       d.name AS device_name,
       COALESCE(
         (SELECT array_agg(DISTINCT sa.agent_type)
          FROM subagents sa WHERE sa.session_id = s.id),
         '{}'
       ) AS subagent_types,
       COALESCE(
         (SELECT array_agg(DISTINCT sk.skill_name)
          FROM session_skills sk WHERE sk.session_id = s.id),
         '{}'
       ) AS skill_names,
       COALESCE(
         (SELECT array_agg(DISTINCT wt.worktree_name)
          FROM session_worktrees wt WHERE wt.session_id = s.id),
         '{}'
       ) AS worktree_names
FROM sessions s
```

**Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test e2e/phase4-2 2>&1 | grep -E "(pass|fail)"`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/src/routes/sessions.ts packages/server/src/__tests__/
git commit -m "add subagent_types, skill_names, worktree_names to session list API"
```

---

### Task 3: Update SessionDisplayData Type

Extend the client-side type to include the new server fields.

**Files:**
- Modify: `packages/cli/src/tui/components/SessionRow.tsx:39-51`

**Step 1: Add new fields to SessionDisplayData**

```typescript
export interface SessionDisplayData extends Session {
  device_name?: string;
  workspace_name?: string;
  summary?: string | null;
  cost_estimate_usd?: number | null;
  total_messages?: number | null;
  tool_uses?: number | null;
  commit_messages?: string[] | null;
  tool_counts?: Record<string, number> | null;
  subagent_count?: number | null;
  // Phase 4-2 enrichment fields from server
  subagent_types?: string[];
  skill_names?: string[];
  worktree_names?: string[];
}
```

No test needed — this is a type-only change. TypeScript compilation is the test.

**Step 2: Commit**

```bash
git add packages/cli/src/tui/components/SessionRow.tsx
git commit -m "extend SessionDisplayData with subagent_types, skill_names, worktree_names"
```

---

### Task 4: Enrich SessionRow with Phase 4-2 Metadata Sub-Lines

Add optional sub-lines for permission mode, skills, worktrees, and subagent types below the session summary.

**Files:**
- Modify: `packages/cli/src/tui/components/SessionRow.tsx`

**Step 1: Add metadata sub-lines to the SessionRow render**

After the existing commit messages block and before the closing `</Box>`, add conditional rendering:

```tsx
{/* Phase 4-2 metadata: skills + worktree on one line, subagents on another */}
{(skillNames.length > 0 || worktreeNames.length > 0) && (
  <Box paddingLeft={4}>
    <Text dimColor>
      {skillNames.length > 0 && `\u26A1 ${skillNames.join(", ")}`}
      {skillNames.length > 0 && worktreeNames.length > 0 && "  |  "}
      {worktreeNames.length > 0 && `\uD83C\uDF3F ${worktreeNames[0]}`}
    </Text>
  </Box>
)}
{subagentCount > 0 && subagentTypes.length > 0 && (
  <Box paddingLeft={4}>
    <Text dimColor>
      {"\u2514\u2500"} {subagentCount} agent{subagentCount !== 1 ? "s" : ""} ({subagentTypes.join(", ")})
    </Text>
  </Box>
)}
```

Also add permission mode to the status line (after tokens, if present):

```tsx
{session.permission_mode && (
  <>
    <Text>{"  "}</Text>
    <Text dimColor>{session.permission_mode}</Text>
  </>
)}
```

Extract the new fields at the top of the component:

```typescript
const subagentTypes = (session as SessionDisplayData).subagent_types ?? [];
const skillNames = (session as SessionDisplayData).skill_names ?? [];
const worktreeNames = (session as SessionDisplayData).worktree_names ?? [];
```

Remove the old `[N agent(s)]` badge since subagent info now shows on its own line.

**Step 2: Commit**

```bash
git add packages/cli/src/tui/components/SessionRow.tsx
git commit -m "add skills, worktree, subagent types, and permission mode to session rows"
```

---

### Task 5: Create WorkspacesView Component

Replace the left pane of the old dashboard with a full-width workspace list view.

**Files:**
- Create: `packages/cli/src/tui/WorkspacesView.tsx`

**Step 1: Create the WorkspacesView component**

```tsx
/**
 * WorkspacesView — full-width workspace list with drill-down navigation.
 *
 * Replaces the left pane of the old Dashboard. Shows all workspaces with
 * session count, active indicator, and last activity. Press Enter to
 * drill into a workspace's sessions.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FuelApiClient } from "../lib/api-client.js";
import type { WsClient } from "../lib/ws-client.js";
import type { WorkspaceSummary } from "../lib/api-client.js";
import { useWorkspaces } from "./hooks/useWorkspaces.js";
import { useWsConnection } from "./hooks/useWsConnection.js";
import { useTodayStats } from "./hooks/useTodayStats.js";
import { StatusBar } from "./components/StatusBar.js";
import { Spinner } from "./components/Spinner.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { formatDuration, formatRelativeTime } from "../lib/formatters.js";

export interface WorkspacesViewProps {
  api: FuelApiClient;
  ws: WsClient;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
}

export function WorkspacesView({
  api,
  ws,
  onSelectWorkspace,
}: WorkspacesViewProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { workspaces, loading, error, refresh } = useWorkspaces(api);
  const { state: wsState } = useWsConnection(ws);
  const stats = useTodayStats(workspaces);

  useInput((input, key) => {
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, workspaces.length - 1));
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (key.return && workspaces[selectedIndex]) {
      onSelectWorkspace(workspaces[selectedIndex]);
    }
    if (input === "r") {
      refresh();
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold> fuel-code </Text>
      </Box>

      {error && <ErrorBanner message={error.message} />}

      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="cyan"> WORKSPACES</Text>
        {loading && workspaces.length === 0 ? (
          <Spinner label="Loading workspaces..." />
        ) : workspaces.length === 0 ? (
          <Text dimColor> No workspaces found. Run `fuel-code init` to get started.</Text>
        ) : (
          workspaces.map((w, i) => {
            const selected = i === selectedIndex;
            const activeCount = w.active_session_count;
            return (
              <Box key={w.id}>
                <Text bold={selected} color={selected ? "cyan" : undefined}>
                  {selected ? "> " : "  "}
                  {w.display_name}
                </Text>
                <Text dimColor>  {w.session_count} sessions</Text>
                <Text dimColor>  {formatDuration(w.total_duration_ms)}</Text>
                {w.last_session_at && (
                  <Text dimColor>  {formatRelativeTime(w.last_session_at)}</Text>
                )}
                {activeCount > 0 && (
                  <Text color="green">  [{activeCount} live]</Text>
                )}
              </Box>
            );
          })
        )}
      </Box>

      <StatusBar stats={stats} wsState={wsState} keyHints="j/k:navigate  enter:open  t:teams  r:refresh  q:quit" />
    </Box>
  );
}
```

**Step 2: Commit**

```bash
git add packages/cli/src/tui/WorkspacesView.tsx
git commit -m "add full-width WorkspacesView component for drill-down navigation"
```

---

### Task 6: Create TeamGroupRow Component

Renders a collapsed or expanded team group in the session list.

**Files:**
- Create: `packages/cli/src/tui/components/TeamGroupRow.tsx`

**Step 1: Create the TeamGroupRow component**

```tsx
/**
 * TeamGroupRow — collapsed/expandable team group in the session list.
 *
 * Collapsed: single row showing team name, member count, aggregate duration, status.
 * Expanded: header row + indented member sessions.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Session } from "@fuel-code/shared";
import { formatDuration } from "../../lib/formatters.js";
import { SessionRow, type SessionDisplayData } from "./SessionRow.js";

export interface TeamGroup {
  teamName: string;
  leadSession: SessionDisplayData | null;
  memberSessions: SessionDisplayData[];
  allSessions: SessionDisplayData[];
}

export interface TeamGroupRowProps {
  group: TeamGroup;
  expanded: boolean;
  selected: boolean;
  /** Index of selected member within the expanded group (-1 = header selected) */
  selectedMemberIndex: number;
}

export function TeamGroupRow({
  group,
  expanded,
  selected,
  selectedMemberIndex,
}: TeamGroupRowProps): React.ReactElement {
  const totalDuration = group.allSessions.reduce(
    (sum, s) => sum + (s.duration_ms ?? 0),
    0,
  );
  const isActive = group.allSessions.some(
    (s) => s.lifecycle === "detected" || s.lifecycle === "capturing",
  );
  const statusLabel = isActive ? "ACTIVE" : "DONE";
  const statusColor = isActive ? "green" : "gray";
  const toggleIcon = expanded ? "\u25BC" : "\u25B6";
  const leadSummary = group.leadSession?.summary
    ?? group.leadSession?.metadata?.initial_prompt as string | undefined
    ?? "(no summary)";

  if (!expanded) {
    // Collapsed: single compact row
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold={selected} color={selected ? "cyan" : undefined}>
            {selected ? "> " : "  "}
          </Text>
          <Text>{toggleIcon} </Text>
          <Text bold>Team: {group.teamName}</Text>
          <Text dimColor>  {group.allSessions.length} members</Text>
          <Text>  {formatDuration(totalDuration)}</Text>
          <Text>  </Text>
          <Text color={statusColor as any}>{statusLabel}</Text>
        </Box>
        <Box paddingLeft={6}>
          <Text dimColor wrap="truncate">{leadSummary}</Text>
        </Box>
      </Box>
    );
  }

  // Expanded: header + indented members
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold={selected && selectedMemberIndex === -1} color={selected && selectedMemberIndex === -1 ? "cyan" : undefined}>
          {selected && selectedMemberIndex === -1 ? "> " : "  "}
        </Text>
        <Text>{toggleIcon} </Text>
        <Text bold>Team: {group.teamName}</Text>
        <Text dimColor>  {group.allSessions.length} members</Text>
        <Text>  {formatDuration(totalDuration)}</Text>
        <Text>  </Text>
        <Text color={statusColor as any}>{statusLabel}</Text>
      </Box>
      {group.allSessions.map((member, i) => {
        const memberSelected = selected && selectedMemberIndex === i;
        const role = member.team_role === "lead"
          ? "lead"
          : (member as any).agent_name ?? (member as any).agent_type ?? "member";
        return (
          <Box key={member.id} paddingLeft={4} flexDirection="column">
            <Box>
              <Text bold={memberSelected} color={memberSelected ? "cyan" : undefined}>
                {memberSelected ? "> " : "  "}
              </Text>
              <Text color={getLifecycleColor(member.lifecycle)}>
                {getLifecycleIcon(member.lifecycle)}
              </Text>
              <Text> </Text>
              <Text dimColor>{role.padEnd(12)}</Text>
              <Text>  {formatDuration(member.duration_ms)}</Text>
              <Text>  </Text>
              <Text dimColor wrap="truncate">
                {member.summary ?? "(no summary)"}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// Helpers to avoid importing LIFECYCLE_DISPLAY from SessionRow
function getLifecycleIcon(lifecycle: string): string {
  const icons: Record<string, string> = {
    detected: "\u25CF", capturing: "\u25CF", ended: "\u25D0",
    parsed: "\u25CC", summarized: "\u2713", archived: "\u25AA", failed: "\u2717",
  };
  return icons[lifecycle] ?? "?";
}

function getLifecycleColor(lifecycle: string): string {
  const colors: Record<string, string> = {
    detected: "green", capturing: "green", ended: "yellow",
    parsed: "yellow", summarized: "green", archived: "gray", failed: "red",
  };
  return colors[lifecycle] ?? "gray";
}
```

**Step 2: Commit**

```bash
git add packages/cli/src/tui/components/TeamGroupRow.tsx
git commit -m "add TeamGroupRow component with collapsed/expanded team rendering"
```

---

### Task 7: Create SessionsView Component

Full-width session list for a single workspace with team grouping, chain indicators, and smart navigation.

**Files:**
- Create: `packages/cli/src/tui/SessionsView.tsx`
- Modify: `packages/cli/src/tui/hooks/useSessions.ts` (no changes to hook interface needed — it already returns `Session[]`)

**Step 1: Create the SessionsView component**

This is the largest component. Key responsibilities:
- Fetch sessions for the workspace via `useSessions`
- Group sessions by `team_name` (client-side) into `TeamGroup` objects
- Build a flat "display list" where each item is either a standalone session, a collapsed team group, or (when expanded) team header + members
- Handle `j`/`k` navigation through the flat list
- Handle Enter to expand/collapse teams or open session detail
- Render chain indicators (`↳`) for resumed sessions
- WebSocket live updates (same pattern as old Dashboard)

The component is ~200 lines. Key logic for the grouping:

```typescript
interface DisplayItem {
  type: "session" | "team-header" | "team-member";
  session?: SessionDisplayData;
  teamGroup?: TeamGroup;
  memberIndex?: number; // for team-member items
  isChainChild?: boolean; // resumed from another session in the list
}

function buildDisplayList(
  sessions: SessionDisplayData[],
  expandedTeams: Set<string>,
): DisplayItem[] {
  // 1. Separate team sessions from standalone
  const teamMap = new Map<string, SessionDisplayData[]>();
  const standalone: SessionDisplayData[] = [];
  const sessionIds = new Set(sessions.map(s => s.id));

  for (const s of sessions) {
    if (s.team_name) {
      const arr = teamMap.get(s.team_name) ?? [];
      arr.push(s);
      teamMap.set(s.team_name, arr);
    } else {
      standalone.push(s);
    }
  }

  // 2. Build team groups
  const teamGroups = new Map<string, TeamGroup>();
  for (const [name, members] of teamMap) {
    const lead = members.find(m => m.team_role === "lead") ?? null;
    teamGroups.set(name, {
      teamName: name,
      leadSession: lead,
      memberSessions: members.filter(m => m.team_role !== "lead"),
      allSessions: members,
    });
  }

  // 3. Build display list sorted by most recent session in each group
  // ... interleave standalone sessions and team groups by timestamp ...
  // 4. Mark chain children (resumed_from_session_id is in sessionIds)
}
```

Full implementation should handle:
- Sorting team groups by their most recent member's `started_at`
- Interleaving teams and standalone sessions by time
- Chain detection: if `session.resumed_from_session_id` exists in the visible session list, mark as chain child
- Navigation: `selectedIndex` maps into the flat display list

**Step 2: Wire WS live updates**

Same pattern as the old `Dashboard.tsx` — buffer WS events, flush at 500ms intervals, apply patches via `updateSession`/`prependSession`. Copy the WS handling code from Dashboard.tsx.

**Step 3: Commit**

```bash
git add packages/cli/src/tui/SessionsView.tsx
git commit -m "add full-width SessionsView with team grouping, chains, and smart navigation"
```

---

### Task 8: Update StatusBar for Context-Aware Key Hints

The StatusBar needs to show different key hints depending on which view is active.

**Files:**
- Modify: `packages/cli/src/tui/components/StatusBar.tsx`

**Step 1: Add keyHints prop**

```typescript
export interface StatusBarProps {
  stats: TodayStats;
  wsState: WsConnectionState;
  queuePending?: number;
  keyHints?: string;  // NEW — override default key hints
}
```

Replace the hardcoded hints line with:

```tsx
<Text dimColor>
  {keyHints ?? "j/k:navigate  enter:detail  tab:switch  t:teams  r:refresh  q:quit"}
</Text>
```

**Step 2: Commit**

```bash
git add packages/cli/src/tui/components/StatusBar.tsx
git commit -m "add keyHints prop to StatusBar for per-view key hint customization"
```

---

### Task 9: Rewire App.tsx Navigation

Replace the two-pane dashboard with the drill-down navigation model.

**Files:**
- Modify: `packages/cli/src/tui/App.tsx`

**Step 1: Update the View type and routing**

```typescript
type View =
  | { name: "workspaces" }
  | { name: "sessions"; workspace: WorkspaceSummary }
  | { name: "session-detail"; sessionId: string; fromView: "sessions"; workspace: WorkspaceSummary }
  | { name: "teams-list" }
  | { name: "team-detail"; teamName: string };
```

Update imports: remove `Dashboard`, add `WorkspacesView` and `SessionsView`.

Update the view routing:

```tsx
if (view.name === "workspaces") {
  return (
    <WorkspacesView
      api={api}
      ws={ws}
      onSelectWorkspace={(workspace) =>
        setView({ name: "sessions", workspace })
      }
    />
  );
}

if (view.name === "sessions") {
  return (
    <SessionsView
      api={api}
      ws={ws}
      workspace={view.workspace}
      onSelectSession={(sessionId) =>
        setView({ name: "session-detail", sessionId, fromView: "sessions", workspace: view.workspace })
      }
      onBack={() => setView({ name: "workspaces" })}
    />
  );
}

if (view.name === "session-detail") {
  return (
    <SessionDetailView
      apiClient={api}
      wsClient={ws}
      sessionId={view.sessionId}
      onBack={() => {
        if (view.fromView === "sessions") {
          setView({ name: "sessions", workspace: view.workspace });
        } else {
          setView({ name: "workspaces" });
        }
      }}
    />
  );
}
```

Update initial state: `useState<View>({ name: "workspaces" })`.

Move `t` keybinding to work from both `workspaces` and `sessions` views.

**Step 2: Update back navigation from session detail in team flow**

When navigating from team detail → session detail, the back button should return to team detail. Extend the session-detail view type:

```typescript
| { name: "session-detail"; sessionId: string; fromView: "sessions" | "team-detail"; workspace?: WorkspaceSummary; teamName?: string }
```

**Step 3: Commit**

```bash
git add packages/cli/src/tui/App.tsx
git commit -m "replace split-pane dashboard with drill-down navigation (workspaces -> sessions -> detail)"
```

---

### Task 10: Clean Up Old Dashboard

The old `Dashboard.tsx` is no longer used after the navigation rewire.

**Files:**
- Delete: `packages/cli/src/tui/Dashboard.tsx`
- Modify: `packages/cli/src/tui/App.tsx` (remove Dashboard import if not already done)

**Step 1: Remove Dashboard.tsx**

Delete the file. Confirm no other imports reference it:

```bash
grep -r "Dashboard" packages/cli/src/ --include="*.ts" --include="*.tsx"
```

Remove any remaining references.

**Step 2: Commit**

```bash
git rm packages/cli/src/tui/Dashboard.tsx
git add packages/cli/src/tui/App.tsx
git commit -m "remove old split-pane Dashboard component (replaced by drill-down views)"
```

---

### Task 11: Integration Test — Full TUI Navigation Flow

Verify the drill-down works end-to-end. This is a manual verification task since Ink components are hard to unit test.

**Steps:**
1. Start the backend: `cd packages/server && bun run dev`
2. Start the TUI: `cd packages/cli && bun run dev`
3. Verify: Workspaces view shows full-width
4. Enter a workspace → sessions view shows full-width with enriched rows
5. If any sessions have subagents: verify `└─ N agents (type1, type2)` sub-line
6. If any sessions have teams: verify collapsed team group row
7. Enter on team group → verify it expands with members
8. Enter on a member → verify session detail opens
9. Press `b` → verify back navigation works correctly at each level
10. If any sessions are resumed: verify `↳` chain indicator

**Step 1: Run existing tests to confirm nothing broke**

```bash
cd packages/cli && bun test 2>&1 | grep -E "(pass|fail)|^Ran "
cd packages/server && bun test 2>&1 | grep -E "(pass|fail)|^Ran "
```

**Step 2: Commit any fixes found during integration testing**

---

### Task Dependency Graph

```
Task 1 (backfill message)     — independent, do first
Task 2 (server API)           — independent
Task 3 (SessionDisplayData)   — depends on Task 2
Task 4 (SessionRow enrichment) — depends on Task 3
Task 5 (WorkspacesView)       — independent
Task 6 (TeamGroupRow)         — independent
Task 7 (SessionsView)         — depends on Tasks 4, 5, 6
Task 8 (StatusBar keyHints)   — independent
Task 9 (App.tsx rewire)       — depends on Tasks 5, 7, 8
Task 10 (Dashboard cleanup)   — depends on Task 9
Task 11 (integration test)    — depends on Task 10
```

Parallelizable groups:
- **Group A (independent):** Tasks 1, 2, 5, 6, 8
- **Group B (after Group A):** Tasks 3, 4
- **Group C (after Group B):** Task 7
- **Group D (after Group C):** Tasks 9, 10, 11
