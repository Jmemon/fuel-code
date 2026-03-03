# Task 27: TUI — SessionsView Teammate Grouping

## Phase: G — API + TUI + CLI
## Dependencies: T22, T26
## Parallelizable With: T28

---

## Description

Update the sessions list to show teammates grouped under sessions instead of the current team_name-based grouping.

## Files

- **Modify**: `packages/cli/src/tui/SessionsView.tsx` — update `buildGroupedItems` and `buildDisplayList` to use teammates data
- **Modify**: `packages/cli/src/tui/components/TeamGroupRow.tsx` — update to show teammates (not team_name-grouped sessions)
- **Modify**: `packages/cli/src/tui/components/SessionRow.tsx` — add teammate annotation line

## Display Changes

Current: sessions grouped by `team_name` (lead + members as separate session rows)
New: sessions with teammates show a teammate annotation line:

```
● 2h15m  Session abc123 (claude-opus-4.6)
│  "Implement agent teams support"
│  └─ Teammates: alice, bob, player-a, player-b
│  └─ Other: 10 utility agents
```

The `TeamGroupRow` component is updated to show teammate names instead of session members.

## How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Visual test
cd packages/cli && bun run fuel-code tui
```

## Success Criteria

1. Sessions with teammates show teammate names in annotation
2. Non-team subagents shown as "Other: N agents"
3. Sessions without teams display unchanged
4. Team group expansion shows teammate details
5. Session counts and stats accurate
