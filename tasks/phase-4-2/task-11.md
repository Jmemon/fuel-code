# Task 11: WebSocket Broadcast Extensions

## Parallel Group: C

## Dependencies: Task 4 (handlers trigger broadcasts)

## Description

Add `subagent.update` and `team.update` server-to-client WebSocket message types. Integrate broadcasting into the event handlers so that connected clients receive real-time notifications when sub-agents start/stop or teams are created.

### New WS Message Types

Add to `packages/shared/src/types/ws.ts`:

```typescript
// Add to the existing server→client message type union
interface SubagentUpdateMessage {
  type: 'subagent.update';
  session_id: string;
  workspace_id: string;
  subagent: {
    agent_id: string;
    agent_type: string;
    agent_name?: string;
    status: 'running' | 'completed' | 'failed';
  };
}

interface TeamUpdateMessage {
  type: 'team.update';
  team_name: string;
  lead_session_id?: string;
  workspace_id?: string;
  member_count: number;
}
```

### Broadcaster Changes

In `packages/server/src/ws/broadcaster.ts`, add methods to `WsBroadcaster`:

```typescript
broadcastSubagentUpdate(
  sessionId: string,
  workspaceId: string,
  subagent: { agent_id: string; agent_type: string; agent_name?: string; status: string }
): void

broadcastTeamUpdate(
  teamName: string,
  leadSessionId?: string,
  workspaceId?: string,
  memberCount?: number
): void
```

These follow the existing pattern: construct the message, iterate connected clients, check subscription match (session:id or workspace:id or "all"), send non-blocking.

### Handler Integration

The event handlers from Task 4 should call the broadcaster after successful DB operations. The broadcaster is already injected into the event processor context (check `EventHandlerContext` for the existing pattern — `ctx.broadcaster` or similar).

- `subagent-start` handler: after INSERT, call `broadcastSubagentUpdate(sessionId, workspaceId, { agent_id, agent_type, agent_name, status: 'running' })`
- `subagent-stop` handler: after UPDATE, call `broadcastSubagentUpdate(sessionId, workspaceId, { agent_id, agent_type, agent_name, status: 'completed' })`
- `team-create` handler: after INSERT, call `broadcastTeamUpdate(teamName, sessionId, workspaceId, 1)`

**Note**: If the broadcaster is not yet available in `EventHandlerContext`, add it. Check how `broadcastSessionUpdate()` is called from existing handlers (likely it's called from the consumer/processor level, not directly in handlers). Follow the same pattern.

### Subscription Matching

Existing subscriptions: `"all"`, `"workspace:<id>"`, `"session:<id>"`.

- `subagent.update` matches `"all"`, `"workspace:<workspace_id>"`, `"session:<session_id>"`
- `team.update` matches `"all"`, `"workspace:<workspace_id>"` (if workspace_id available)

## Relevant Files
- Modify: `packages/shared/src/types/ws.ts`
- Modify: `packages/server/src/ws/broadcaster.ts`
- Modify: `packages/server/src/ws/types.ts` (if separate from shared)
- Modify: Event handlers from Task 4 (add broadcast calls) — or the consumer/processor layer

## Success Criteria
1. Connected WS client subscribed to `"all"` receives `subagent.update` when a sub-agent starts.
2. Connected WS client subscribed to `"session:<id>"` receives `subagent.update` for that session only.
3. `team.update` broadcast on team creation.
4. Existing WS messages (`session.update`, `remote.update`) unaffected.
5. Broadcasts are non-blocking (fire-and-forget, no await).
6. Disconnected clients don't cause errors.
