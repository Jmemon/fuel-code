# Task 25: TUI — TeammateDetailView (Stitched Message Feed)

## Phase: G — API + TUI + CLI
## Dependencies: T22
## Parallelizable With: T24, T26

---

## Description

Create a new view showing the stitched message feed for a single teammate, pulled from all subagents belonging to that teammate. This is the teammate equivalent of the transcript viewer.

## Files

- **Create**: `packages/cli/src/tui/TeammateDetailView.tsx` — new view component
- **Create**: `packages/cli/src/tui/hooks/useTeammateDetail.ts` — data fetching hook

## Display Format (from design §9.3)

```
┌─ Teammate: alice (Team: ping-pong) ─────────────────────┐
│ Summary: Played 15 rounds of ping-pong, escalating...   │
├──────────────────────────────────────────────────────────┤
│ [1] User (agent-a113f) 18:42:28                         │
│   ├─ <teammate-message from bob>: "Round 1..."          │
│   └─ Tool uses:                                         │
│       ├─ SendMessage → bob                              │
│       └─ Write: /test/round-1.txt                       │
│                                                          │
│ [2] Assistant (agent-a113f) 18:42:35                     │
│   ├─ "I'll respond with 42891..."                       │
│   └─ SendMessage → bob: "Round 1 response"              │
│                                                          │
│ Message 1 of 142  │  [b]ack  [j/k] scroll               │
└──────────────────────────────────────────────────────────┘
```

Each message shows the `agent_id` of the subagent that emitted it.

## Key Implementation

```typescript
// useTeammateDetail hook
function useTeammateDetail(api: FuelApiClient, sessionId: string, teammateId: string) {
  // GET /api/sessions/:sessionId/teammates/:teammateId (for summary, team info)
  // GET /api/sessions/:sessionId/teammates/:teammateId/messages (stitched feed)
  return { teammate, messages, loading, error };
}
```

## How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Visual test
cd packages/cli && bun run fuel-code tui
# Navigate to a session with teammates → click a teammate
```

## Success Criteria

1. Shows teammate summary at top
2. Shows stitched message feed across all subagents for that teammate
3. Each message shows the source subagent's `agent_id`
4. Scrollable with j/k keys
5. Back button returns to session detail
6. Handles empty message feeds gracefully
