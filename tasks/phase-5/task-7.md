# Task 7: Remote Event Handlers (provision.start/ready/error, terminate)

## Parallel Group: B

## Dependencies: Task 6

## Description

Register event handlers in the existing handler registry for the four remote event types: `remote.provision.start`, `remote.provision.ready`, `remote.provision.error`, and `remote.terminate`. These handlers are invoked by the event processor when remote events flow through the Redis Stream pipeline. They update the `remote_envs` and `devices` tables and broadcast WebSocket updates.

Also add session-device status correlation: when a `session.start` event fires from a remote device, transition the remote_env to `active`. When the last active session on a remote device ends, transition back to `ready`.

### Handlers: `packages/server/src/pipeline/handlers/remote.ts`

```typescript
import { HandlerRegistry } from '../handler-registry';
import type { ProcessedEvent } from '@fuel-code/shared';

export function registerRemoteHandlers(registry: HandlerRegistry, deps: {
  sql: postgres.Sql;
  sshKeyManager: SshKeyManager;
  broadcaster: WsBroadcaster;
  logger: pino.Logger;
}): void;
```

---

**`remote.provision.start`** handler:
- Validates event data against existing Zod schema from `packages/shared`.
- Updates remote_envs metadata with provisioning start timestamp.
- Broadcasts `remote.update` via WebSocket with status=`provisioning`.
- Idempotent — second call is a no-op.

---

**`remote.provision.ready`** handler:
- Validates event data: `{ instance_id, public_ip, ssh_port, device_id }`.
- Updates remote_envs: status → `ready`, sets `public_ip`, `ready_at`, `device_id`.
- Updates associated device record: status → `online`.
- Broadcasts `remote.update` via WebSocket with status=`ready` and public_ip.

---

**`remote.provision.error`** handler:
- Validates event data: `{ error, stage }`.
- Updates remote_envs: status → `error`, stores error details in metadata.
- Broadcasts `remote.update` via WebSocket with status=`error` and error message.

---

**`remote.terminate`** handler:
- Validates event data: `{ instance_id, reason, uptime_seconds, total_cost_usd }`.
- Updates remote_envs: status → `terminated`, sets `terminated_at`, `termination_reason`, `total_cost_usd`.
- Updates associated device status to `terminated`.
- Deletes SSH keys from S3 via `sshKeyManager.deleteKeyPair(remoteEnvId)`.
- Broadcasts `remote.update` via WebSocket with status=`terminated`.

### Session-Device Status Correlation

Modify the existing `session.start` and `session.end` handlers to update remote_env status when the device is remote:

In **`session.start`** handler (after creating session):
```typescript
// If this device is remote, transition the remote_env to 'active'
if (device.type === 'remote') {
  await sql`
    UPDATE remote_envs SET status = 'active'
    WHERE device_id = ${device.id}
    AND status IN ('ready', 'idle')
  `;
  // broadcast remote.update with status=active
}
```

In **`session.end`** handler (after updating session):
```typescript
// If this device is remote and no more active sessions, transition back to 'ready'
if (device.type === 'remote') {
  const activeSessions = await sql`
    SELECT COUNT(*) AS count FROM sessions
    WHERE device_id = ${device.id} AND lifecycle = 'capturing'
  `;
  if (Number(activeSessions[0].count) === 0) {
    await sql`
      UPDATE remote_envs SET status = 'ready'
      WHERE device_id = ${device.id}
      AND status = 'active'
    `;
    // broadcast remote.update with status=ready
  }
}
```

### Relevant Files

**Create:**
- `packages/server/src/pipeline/handlers/remote.ts`
- `packages/server/src/pipeline/handlers/__tests__/remote.test.ts`

**Modify:**
- `packages/server/src/pipeline/handlers/index.ts` (or equivalent registry file) — register remote handlers
- `packages/server/src/pipeline/handlers/session.ts` (or equivalent) — add remote device status updates to session.start and session.end

### Tests

`remote.test.ts` (bun:test, mock DB + mock broadcaster):

1. `remote.provision.start` handler updates remote_envs metadata with start timestamp.
2. `remote.provision.start` broadcasts `remote.update` with status=provisioning.
3. `remote.provision.ready` sets status=ready, public_ip, ready_at, device_id.
4. `remote.provision.ready` updates device status to `online`.
5. `remote.provision.ready` broadcasts `remote.update` with status=ready and public_ip.
6. `remote.provision.error` sets status=error, stores error details in metadata.
7. `remote.provision.error` broadcasts `remote.update` with error status.
8. `remote.terminate` sets status=terminated, terminated_at, termination_reason, total_cost_usd.
9. `remote.terminate` updates device status to `terminated`.
10. `remote.terminate` deletes SSH keys from S3.
11. `remote.terminate` broadcasts `remote.update` with status=terminated.
12. All handlers are idempotent — processing the same event twice produces the same result.
13. All handlers validate event data against Zod schemas.
14. All four handlers are registered in the handler registry with correct event type keys.
15. `session.start` from remote device transitions remote_env to `active`.
16. `session.end` (last active session) from remote device transitions remote_env back to `ready`.
17. `session.end` does NOT transition if other active sessions remain on the device.
18. Handlers log at info level with remote_env_id and instance_id for traceability.

### Success Criteria

1. All four event types have handlers registered in the handler registry.
2. `remote.provision.ready` correctly transitions status and creates device associations.
3. `remote.terminate` handler computes cost, deletes SSH keys, and updates status.
4. WebSocket `remote.update` broadcasts fire for all status transitions (ready, error, terminated, active, idle).
5. Handlers are idempotent — processing the same event twice does not cause errors or incorrect state.
6. Event data is validated against the existing Zod schemas from `packages/shared`.
7. Session start/end on remote devices correctly updates remote_env status (active ↔ ready).
8. Handlers log at info level with remote_env_id for traceability.
