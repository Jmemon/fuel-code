# Task 24: TUI — SubagentsPanel → Teammates Section

## Phase: G — API + TUI + CLI
## Dependencies: T22
## Parallelizable With: T25, T26

---

## Description

Update the SubagentsPanel to show teammates when a session has team-affiliated subagents. Non-team subagents remain in a separate "Other Subagents" section.

## Files

- **Modify**: `packages/cli/src/tui/components/SubagentsPanel.tsx` — split into Teammates section + Other Subagents section
- **Modify**: `packages/cli/src/tui/components/Sidebar.tsx` — pass teammates data to panel

## Display Format (from design §9.2)

```
┌─ Teammates ──────────────────┐
│ ● alice (30 agents) ✓        │
│ ● bob (29 agents) ✓          │
│ ● player-a (11 agents) ✓    │
├─ Other Subagents ────────────┤
│ ● code-executor ✓            │
│ ● researcher ✓               │
│ ...8 more                    │
└──────────────────────────────┘
```

Each teammate row shows:
- Color indicator (from `teammate.color` or assigned based on index — different subagents within a teammate should receive distinct colors for visual distinction, as noted in 04-notes.md)
- Teammate name
- Count of component subagents (subagents with this `teammate_id`)
- Aggregate status icon

Non-team subagents (those without `teammate_id`) are shown in the "Other" section.

## How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Visual test: open TUI for a session with teams
cd packages/cli && bun run fuel-code tui
```

## Success Criteria

1. Teammates section appears when session has team data
2. Each teammate shows name, subagent count, status
3. Non-team subagents shown separately as "Other"
4. No teammates section for non-team sessions (backwards compatible)
5. Color indicators differentiate teammates visually
