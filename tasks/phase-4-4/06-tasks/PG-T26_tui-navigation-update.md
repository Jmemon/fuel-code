# Task 26: TUI — Navigation State Machine Update

## Phase: G — API + TUI + CLI
## Dependencies: T24, T25
## Parallelizable With: None

---

## Description

Add `teammate-detail` to the navigation state machine in `App.tsx`.

## Files

- **Modify**: `packages/cli/src/tui/App.tsx` — add `teammate-detail` view type and navigation handlers

## Key Changes

```typescript
type View =
  | { name: "workspaces" }
  | { name: "sessions"; workspace: WorkspaceSummary }
  | { name: "session-detail"; sessionId: string; fromView: "sessions" | "team-detail"; workspace?: WorkspaceSummary; teamName?: string }
  | { name: "teams-list"; fromView: "workspaces" | "sessions"; workspace?: WorkspaceSummary }
  | { name: "team-detail"; teamName: string; fromView: "workspaces" | "sessions"; workspace?: WorkspaceSummary }
  | { name: "teammate-detail"; teammateId: string; sessionId: string; fromView: "session-detail"; workspace?: WorkspaceSummary }  // NEW
```

Navigation flow:
- From session-detail sidebar → click teammate → `teammate-detail`
- From teammate-detail → press `b` → back to `session-detail`

## How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. `teammate-detail` view renders `TeammateDetailView`
2. Navigation from session-detail to teammate-detail works
3. Back navigation from teammate-detail returns to session-detail
4. `fromView` context properly preserved through navigation chain
