# Task 18: TUI — Session Enhancements (Detail + List Badges)

## Parallel Group: F

## Dependencies: Task 15 (session API with relationship data)

## Description

Enhance the SessionDetailView with new panels and header badges, and add badges to the session list rows. This task combines session detail and session list changes because they share the same API data source.

### Part 1: SessionDetailView Enhancements

#### SubagentsPanel Component

Create `packages/cli/src/tui/components/SubagentsPanel/index.tsx` (follow existing component directory structure):

```
Sub-agents (3)
──────────────
 Explore  agent-a01e254     ✓  2.3s
 Plan     phase-4-reviewer  ✓  8.1s
 general  task-worker       ●  running
```

- Groups sub-agents by type (Explore, Plan, general-purpose, custom)
- Each row: type icon/label, agent_name (or agent_id if no name), status indicator, duration
- Status: `●` running (dim green), `✓` completed (green), `✗` failed (red)
- Duration: computed from `started_at` to `ended_at` (or "running" if no ended_at)
- Returns `null` when no sub-agents (panel not shown)
- Panel position: right sidebar, below existing panels (ToolsUsedPanel, GitActivityPanel)

#### SkillsPanel Component

Create `packages/cli/src/tui/components/SkillsPanel/index.tsx`:

```
Skills (2)
──────────
 /commit         (user)   2:45 PM
 brainstorming   (auto)   2:34 PM
```

- User-invoked skills shown with `/` prefix
- Auto-invoked skills shown without prefix
- Each row: skill name, invocation source, time
- Returns `null` when no skills
- Panel position: right sidebar, below SubagentsPanel

#### Header Badges

In the session header component (likely `packages/cli/src/tui/components/SessionHeader/` or within SessionDetailView):

**Session chain breadcrumb**:
```
← Resumed from abc12... → [current session]
```
- If `resumed_from` is not null, show breadcrumb above the session header
- Dim styling, pressing Enter on it could navigate to the prior session (stretch goal)

**Team badge**:
```
[team: phase-2-impl (lead)]
```
- If `team_name` is not null, show badge in header area
- Shows team name and role

**Worktree indicator**:
```
[worktree: agent-a834e7d]
```
- If session has worktrees, show the first worktree name

#### Data Hook Update

Update `packages/cli/src/tui/hooks/useSessionDetail.ts` (or equivalent):
- The session detail API now returns `subagents`, `skills`, `worktrees`, `team`, `resumed_from`, `resumed_by`
- Pass these to the relevant panel components
- No new API calls needed — data is inline in the session detail response

#### Integration into SessionDetailView

In `packages/cli/src/tui/views/SessionDetailView.tsx`:
- Add `<SubagentsPanel subagents={session.subagents} />` to the sidebar
- Add `<SkillsPanel skills={session.skills} />` to the sidebar
- Add header badges based on `session.team_name`, `session.resumed_from`, `session.worktrees`
- All panels/badges are conditional — only render when data exists
- Old sessions without new data look identical to before

### Part 2: Session List Badges

In `packages/cli/src/tui/components/SessionRow/` (or equivalent session list row component):

Add subtle badges after the existing session info:

```
abc12...  Implement Phase 2...  claude-opus  45min  [3 agents] [team] [←]
```

- **Sub-agent count**: `[3 agents]` — shown when `subagent_count > 0`. Dim styling.
- **Team badge**: `[team]` — shown when `team_name` is not null. Dim styling.
- **Resume indicator**: `[←]` — shown when `resumed_from_session_id` is not null. Dim styling.

These use data already on the session list response (the `subagent_count`, `team_name`, `resumed_from_session_id` columns added by the migration). No extra API calls.

### Styling Guidelines

- All new elements use **dim** colors by default (not attention-grabbing)
- Match the existing TUI color scheme (check picocolors usage in existing components)
- Sub-agent status colors: green for completed, red for failed, dim for running
- Badges use brackets `[...]` to distinguish from main content
- Panels use the existing panel border/header pattern

## Relevant Files
- Create: `packages/cli/src/tui/components/SubagentsPanel/index.tsx`
- Create: `packages/cli/src/tui/components/SkillsPanel/index.tsx`
- Modify: `packages/cli/src/tui/views/SessionDetailView.tsx`
- Modify: `packages/cli/src/tui/hooks/useSessionDetail.ts`
- Modify: Session header component
- Modify: Session list row component

## Success Criteria
1. SubagentsPanel renders correctly for sessions with sub-agents — grouped by type, status indicators, duration.
2. SubagentsPanel returns null (not shown) for sessions without sub-agents.
3. SkillsPanel renders skill list with user/auto distinction and timestamps.
4. SkillsPanel returns null for sessions without skills.
5. Session chain breadcrumb shows when `resumed_from` is present.
6. Team badge shows team name and role.
7. Session list badges (agent count, team, resume) render dimly.
8. Old sessions (no new data) look identical to pre-Phase-4-2 output.
9. All existing TUI tests pass.
10. Components handle edge cases: empty arrays, null fields, very long names (truncation).
