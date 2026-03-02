# TUI Phase 4-2 Surface Refresh

**Date:** 2026-03-01
**Status:** Design

## Problem

Phase 4-2 added substantial relationship data (teams, subagents, skills, worktrees, session chains, permission modes) but the TUI doesn't surface any of it meaningfully. The dashboard still looks like Phase 1 — flat session list with dim badges. Users can't see at a glance which sessions are related, which spawned agents, or which are part of a coordinated team effort.

Additionally, the backfill command has a dead pause between scanning and processing phases with no user feedback.

## Design

### 1. Navigation: Drill-Down Replaces Split Panes

**Current:** Two-pane dashboard (30% workspaces | 70% sessions) shown simultaneously.

**New:** Full-width drill-down navigation. Each view gets the entire terminal width.

```
WorkspacesView (full-width)
  → [Enter] → SessionsView (full-width, one workspace)
    → [Enter] → SessionDetailView (existing, enhanced)
```

**WorkspacesView** — list of workspaces, each showing:
- Workspace name (from `display_name` or `canonical_id`)
- Session count
- Last activity timestamp
- Active session indicator (if any session is `detected`/`capturing`)

**Navigation:** `j`/`k` to move, `Enter` to drill into workspace, `t` for teams view, `q` to quit.

**Rationale:** The split pane wastes space. Workspaces are selected infrequently; sessions are browsed constantly. Full width gives room for the richer session rendering below.

### 2. Smart Session List — Teams, Subagents, Chains

The session list for a workspace becomes a mixed list of **standalone rows**, **team groups**, and **chain-linked sessions**.

#### 2a. Team Groups (Collapsed/Expandable)

Sessions sharing a `team_name` are grouped into a single collapsible row. The lead session's data drives the group header.

**Collapsed (default):**
```
  ▶ Team: deploy-pipeline  4 members  45m  ACTIVE
    Setting up CI/CD pipeline...
```

Fields:
- `▶`/`▼` toggle indicator
- Team name (from `team_name`)
- Member count (count of sessions with this `team_name`)
- Total duration (sum of member `duration_ms`)
- Aggregate status: `ACTIVE` if any member is `detected`/`capturing`, else `DONE`/`ENDED`
- Summary from the lead session (`team_role = 'lead'`)

**Expanded (press Enter on collapsed group):**
```
  ▼ Team: deploy-pipeline  4 members  45m  ACTIVE
    ● LIVE  lead        12m  Setting up CI/CD pipeline...
    ✓ DONE  researcher   3m  Found Terraform patterns
    ● LIVE  tester       5m  Writing deploy tests...
    ✓ DONE  executor     8m  Created Dockerfile
```

Members show:
- Lifecycle icon + label
- Role label derived from: `team_role` if 'lead', else `agent_name` or `agent_type` from subagent metadata if available, else 'member'
- Duration
- Summary (truncated)

**Interaction:**
- Enter on collapsed group → expand
- Enter on expanded group header → collapse
- Enter on individual member → open session detail
- `j`/`k` moves through the flat list (collapsed groups count as 1 item; expanded groups expose each member)

**Implementation:** Client-side grouping. The `GET /api/sessions?workspace_id=X` response already includes `team_name` and `team_role` on every session. Group by `team_name`, identify the lead, render as a composite row. No API changes needed for basic grouping.

#### 2b. Subagent Nesting (Standalone Sessions)

Sessions with `subagent_count > 0` (but not part of a team) show a compact sub-line listing the subagent types:

```
  ● LIVE  macbook  8m  32K tok
    Refactoring the auth module...
    └─ 2 agents (researcher, tester)
```

The sub-line shows:
- `└─` tree connector
- Count and parenthesized list of `agent_type` values

**Data requirement:** The session list API currently returns `subagent_count` but not the type names. Add a lightweight `subagent_types` text array to the list query:

```sql
SELECT s.*,
       w.canonical_id AS workspace_canonical_id,
       w.display_name AS workspace_name,
       d.name AS device_name,
       COALESCE(
         (SELECT array_agg(DISTINCT sa.agent_type)
          FROM subagents sa WHERE sa.session_id = s.id),
         '{}'
       ) AS subagent_types
FROM sessions s
JOIN workspaces w ON s.workspace_id = w.id
JOIN devices d ON s.device_id = d.id
...
```

This is a correlated subquery but only fires for rows in the result set (typically 50), and `subagents` is indexed on `session_id`. Negligible cost.

#### 2c. Session Chains (Resumed Sessions)

Sessions linked by `resumed_from_session_id` form chains. Visually connect them:

```
  ✓ DONE  macbook  22m  89K tok                     ↓
    Started auth implementation

  ↳ ✓ DONE  macbook  15m  45K tok                   ↓
      Continued auth — added tests

  ↳ ● LIVE  macbook  8m  32K tok
      Finishing auth — final cleanup
```

- Child sessions prefixed with `↳` and indented 2 extra chars
- Parent session shows dim `↓` on the right edge when its child is visible
- Chain detection: scan the session list for `resumed_from_session_id` matches. Since sessions are ordered by `started_at DESC`, a resumed session appears near its parent.

**Edge case:** If a chain spans pages (parent on page 1, child on page 2), just show the `↳` without the parent's `↓`. No cross-page linking needed.

### 3. Richer Inline Metadata

Each session row gains optional sub-lines for Phase 4-2 data. These only render when the data exists — a plain session looks identical to today.

**Full example with all features present:**
```
  ✓ DONE  macbook  22m  89K tok  plan
    Fixed auth flow for OAuth2
    • fix: validate redirect URI before exchange
    ⚡ brainstorming, tdd, commit  |  🌿 auth-fix
    └─ 2 agents (researcher, tester)
```

Line-by-line:
1. **Status line:** lifecycle icon, label, device, duration, tokens, permission mode (dim, right of tokens — only if non-default)
2. **Summary:** session summary or initial prompt
3. **Commits:** bullet-pointed commit messages (max 2, existing behavior)
4. **Skills + worktree line** (conditional): `⚡ skill1, skill2, ...` and/or `🌿 worktree-name`, pipe-separated if both present
5. **Subagent line** (conditional): `└─ N agents (type1, type2)`

**Data requirements for skills/worktrees in list view:**
- Skills: Add `skill_names` text array to list query (same pattern as `subagent_types`)
- Worktrees: Add `worktree_names` text array to list query
- Permission mode: Already in `s.permission_mode` via `SELECT s.*`

```sql
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
```

### 4. Backfill Transition Message

Between scan completion and ingestion start, add status messages so the terminal doesn't appear hung:

```
  Scanning:    [████████████████████████████████] 523/523
Found 489 sessions across 12 projects

Preparing ingestion...

Processing with concurrency: 5
  Uploading:   [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0/489
  Processing:  waiting...
```

**Implementation:** Add `console.error("Preparing ingestion...");` after the dry-run check and before state persistence. This covers the ~50-100ms of state save + set construction + bar initialization that currently shows as a dead pause.

### 5. StatusBar Updates

The StatusBar at the bottom adapts to the new navigation:

**WorkspacesView:** `[j/k] navigate  [Enter] open  [t] teams  [q] quit`
**SessionsView:** `[j/k] navigate  [Enter] open/expand  [b] back  [r] refresh  [t] teams  [q] quit`
**SessionDetailView:** Same as today.

The stats line (today's sessions, active count, WS status) stays but moves to the StatusBar content area.

## Files Modified

| File | Change |
|------|--------|
| `packages/cli/src/tui/Dashboard.tsx` | Replace with `WorkspacesView` + `SessionsView` drill-down |
| `packages/cli/src/tui/App.tsx` | Update navigation state machine for new view hierarchy |
| `packages/cli/src/tui/components/SessionRow.tsx` | Add skill/worktree/permission-mode/subagent-type sub-lines |
| `packages/cli/src/tui/components/TeamGroupRow.tsx` | **New** — collapsed/expanded team group rendering |
| `packages/cli/src/tui/components/WorkspaceRow.tsx` | **New** — full-width workspace row (replaces WorkspaceItem) |
| `packages/cli/src/tui/components/SessionRow.tsx` | Extend `SessionDisplayData` with `subagent_types`, `skill_names`, `worktree_names` |
| `packages/cli/src/tui/hooks/useSessions.ts` | Add client-side team grouping logic |
| `packages/server/src/routes/sessions.ts` | Add `subagent_types`, `skill_names`, `worktree_names` to list query |
| `packages/cli/src/commands/backfill.ts` | Add "Preparing ingestion..." message |
| `packages/cli/src/tui/components/StatusBar.tsx` | Update key hints per view |

## Non-Goals

- Subagent transcript viewing from the session list (use detail view's SubagentsPanel)
- Cross-workspace team display (teams are per-workspace)
- Keyboard shortcut for jumping between chain members (future enhancement)
- Filtering/sorting by team or agent type (future enhancement)

## Risks

- **Team grouping assumes all team members share a workspace.** If a team spans workspaces, some members won't appear in the group. Acceptable for now — teams are typically workspace-scoped.
- **Correlated subqueries in list endpoint.** Three small subqueries per row. With LIMIT 50, this is ~150 extra micro-queries. All indexed. Should be <5ms total. Monitor.
- **Session chain rendering assumes proximity.** If parent and child are far apart in the list (e.g., days apart), the chain connector won't be visible. Acceptable — chains are typically close in time.
