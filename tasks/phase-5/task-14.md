# Task 14: TUI Remote Panel + WebSocket Integration

## Parallel Group: E

## Dependencies: Tasks 7, 13

## Description

Add a "REMOTES" section to the TUI dashboard sidebar showing active remote environments with live status updates via WebSocket. This reuses the data-fetching pattern from `remote ls` (Task 13) and subscribes to `remote.update` WebSocket events for real-time state changes.

### TUI Dashboard Changes: `packages/cli/src/tui/Dashboard.tsx`

Add a "REMOTES" section below the workspace list in the left sidebar:

```
WORKSPACES
──────────
● fuel-code (3 sessions)
  api-service (1 session)

REMOTES
───────
● fuel-code
  t3.xl  $0.42  ready
  54.123.45.67

● api-service
  t3.lg  $0.12  active (live)
  54.234.56.78
```

The remotes section is hidden when there are no remote environments.

### Remote Panel Component

```tsx
// packages/cli/src/tui/components/RemotePanel.tsx

interface RemotePanelProps {
  remotes: RemoteEnv[];
}

function RemotePanel({ remotes }: RemotePanelProps): JSX.Element | null {
  if (remotes.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Text bold>REMOTES</Text>
      <Text dimColor>{'─'.repeat(20)}</Text>
      {remotes.map(remote => (
        <RemoteEntry key={remote.id} remote={remote} />
      ))}
    </Box>
  );
}
```

Each remote entry shows:
- Status indicator: green dot for ready/active, yellow dot for idle, dim dot for provisioning, red dot for error.
- Workspace name.
- Instance type (abbreviated: t3.xlarge → t3.xl, t3.large → t3.lg) and running cost.
- Status text: "ready", "active (live)", "idle 12m", "provisioning...", "error: <msg>".
- Public IP (when available).

### Hook: `useRemotes`

```typescript
// packages/cli/src/tui/hooks/useRemotes.ts

export function useRemotes(apiClient: ApiClient, wsClient: WsClient): {
  remotes: RemoteEnv[];
  loading: boolean;
  error: string | null;
} {
  // 1. Fetch initial data via GET /api/remote?status=provisioning,ready,active,idle
  // 2. Subscribe to wsClient 'remote.update' events
  // 3. On remote.update:
  //    - status=ready/active/idle: upsert in list
  //    - status=terminated: remove from list
  //    - status=provisioning: add or update with spinner indication
  // 4. Poll every 30s as fallback if WS is disconnected
}
```

### WebSocket Integration

The WsClient (from Phase 4) already handles incoming messages. Add handling for `remote.update` message type:

```typescript
// In WsClient or wherever incoming messages are dispatched:
case 'remote.update':
  this.emit('remote.update', {
    remote_env_id: message.remote_env_id,
    status: message.status,
    public_ip: message.public_ip,
    // ... other fields
  });
  break;
```

The Dashboard component listens for these events via the `useRemotes` hook and updates the sidebar in real-time.

### Dashboard Wiring

In `Dashboard.tsx`:

```tsx
function Dashboard() {
  const { remotes, loading: remotesLoading } = useRemotes(apiClient, wsClient);
  // ... existing workspace/session state ...

  return (
    <Box flexDirection="row">
      {/* Left sidebar */}
      <Box flexDirection="column" width={30}>
        <WorkspaceList workspaces={workspaces} />
        <RemotePanel remotes={remotes} />
      </Box>

      {/* Main content */}
      <Box flexDirection="column" flexGrow={1}>
        {/* ... session list, detail, etc. ... */}
      </Box>
    </Box>
  );
}
```

### Relevant Files

**Create:**
- `packages/cli/src/tui/components/RemotePanel.tsx`
- `packages/cli/src/tui/hooks/useRemotes.ts`
- `packages/cli/src/tui/components/__tests__/RemotePanel.test.tsx`

**Modify:**
- `packages/cli/src/tui/Dashboard.tsx` — add RemotePanel to sidebar, use useRemotes hook
- `packages/cli/src/lib/ws-client.ts` — ensure `remote.update` messages are emitted (may already be handled by generic message dispatching)

### Tests

`RemotePanel.test.tsx` (bun:test + ink-testing-library):

1. Renders list of remote environments with status indicators.
2. Ready remote: green dot, workspace name, cost.
3. Active remote with live session: bright green, "active (live)" label.
4. Idle remote: yellow dot, idle duration.
5. Provisioning remote: dim, "provisioning..." text.
6. Error remote: red dot, error message truncated.
7. Empty list: component returns null (section hidden).
8. Instance type abbreviated correctly (t3.xlarge → t3.xl).
9. Cost displayed as dollar amount (e.g., $0.42).
10. Public IP shown when available.
11. WebSocket `remote.update` with status=ready → remote appears in list.
12. WebSocket `remote.update` with status=terminated → remote removed from list.
13. WebSocket `remote.update` with status change (ready → active) → status updated.
14. Initial data loaded from API on mount.
15. Polling fallback works when WS is disconnected.

### Success Criteria

1. TUI dashboard sidebar shows a REMOTES section below workspaces.
2. Active/ready/idle remote environments listed with colored status indicators.
3. Status changes via WebSocket reflected in real-time (no manual refresh).
4. Provisioning remotes show a "provisioning..." indicator.
5. Terminated remotes removed from the list.
6. REMOTES section hidden when no remote environments exist.
7. Remote panel does not interfere with workspace list navigation.
8. Cost and uptime displayed accurately.
9. Polling fallback when WebSocket is unavailable.
