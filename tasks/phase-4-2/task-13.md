# Task 13: TUI — Teams Views

## Parallel Group: D

## Dependencies: Task 10 (Teams API routes)

## Description

Create a dedicated Teams TUI screen accessible from the dashboard via `t` keybind. Two views: TeamsListView (top-level team list) and TeamDetailView (expanded single team with members).

### TeamsListView

Create `packages/cli/src/tui/views/TeamsListView.tsx` (or in the appropriate TUI views directory — check existing structure).

**Layout**:
```
┌─ Teams ──────────────────────────────────────────────┐
│ Name              Members  Lead Prompt       Created  │
│ ──────────────────────────────────────────────────── │
│ ▶ phase-2-impl     5      Implement Phase 2  Feb 19  │
│   downstream-rev   3      Review downstream   Feb 20  │
│   bug-fix-team     2      Fix auth bugs       Feb 21  │
│                                                       │
│                                                       │
│ [j/k] navigate  [Enter] detail  [b] back  [q] quit  │
└───────────────────────────────────────────────────────┘
```

**Data source**: `GET /api/teams` with cursor pagination.

**Behavior**:
- j/k for navigation (follow existing pattern from session list)
- Enter to expand → TeamDetailView
- b/Escape back to dashboard
- Load more on scroll (if cursor pagination has more)

### TeamDetailView

Create `packages/cli/src/tui/views/TeamDetailView.tsx`.

**Layout**:
```
┌─ Team: phase-2-impl ─────────────────────────────────┐
│ Description: Implementing Phase 2 - 12 tasks          │
│ Created: Feb 19, 2026 3:30 PM                         │
│ Lead: Implement Phase 2... (claude-opus-4-6)           │
│ Members: 5  Messages: 12                               │
│ ───────────────────────────────────────────────────── │
│ Name              Type             Model     Status    │
│ ▶ task-1-worker   general-purpose  sonnet    ✓ done   │
│   task-2-worker   general-purpose  sonnet    ✓ done   │
│   task-3-worker   general-purpose  haiku     ✓ done   │
│   reviewer        code-reviewer    opus      ✓ done   │
│   researcher      Explore          haiku     ✓ done   │
│                                                        │
│ [j/k] navigate  [Enter] session  [b] back  [q] quit  │
└────────────────────────────────────────────────────────┘
```

**Data source**: `GET /api/teams/:name` (includes members).

**Behavior**:
- j/k to navigate members
- Enter on a member → navigate to the parent session's SessionDetailView (the `session_id` on the subagent row)
- Enter on the lead → navigate to the lead session's SessionDetailView
- b/Escape back to TeamsListView
- Status indicators: spinner for running, checkmark for completed, X for failed

### Data Hook

Create `packages/cli/src/tui/hooks/useTeams.ts`:

```typescript
export function useTeams() {
  // Fetch teams list with pagination
  // Returns { teams, loading, error, loadMore, hasMore }
}

export function useTeamDetail(teamName: string) {
  // Fetch team detail with members
  // Returns { team, loading, error }
}
```

Use the existing `ApiClient` for data fetching.

### Dashboard Integration

- Add `t` keybind handler in `App.tsx` (or the dashboard's key handler) to navigate to TeamsListView
- Add hint to StatusBar: "t: teams" alongside existing hints
- TeamsListView is a peer view of the existing workspace→sessions flow

### Empty States

- No teams: "No teams found. Teams are created when Claude Code uses agent teams."
- Team with no members: Show lead session info only, "No sub-agent members recorded."

## Relevant Files
- Create: `packages/cli/src/tui/views/TeamsListView.tsx`
- Create: `packages/cli/src/tui/views/TeamDetailView.tsx`
- Create: `packages/cli/src/tui/hooks/useTeams.ts`
- Modify: `packages/cli/src/tui/App.tsx` (add teams route + keybind)
- Modify: StatusBar component (add "t: teams" hint)

## Success Criteria
1. `t` from dashboard opens TeamsListView.
2. Teams listed with name, member count, lead prompt, created date.
3. Enter on a team opens TeamDetailView with all members.
4. Enter on a member navigates to the session detail view.
5. b/Escape navigates back correctly (detail → list → dashboard).
6. Empty state displayed when no teams exist.
7. Pagination works for large team lists.
8. Status indicators (running/completed/failed) render correctly.
9. Keyboard navigation (j/k/Enter/b/q) follows existing TUI patterns.
