# Task W10.3: Fix Backfill Creating "unknown-device" Device Record

## Validation Workflow: W10.3

## Problem

The `fuel-code backfill` command creates a device record with name `unknown-device` in the database. The Devices API (`GET /api/devices`) returns 2 device records:

- `Johns-Laptop type=local sessions=354` -- the real device created by normal hook-driven events via `fuel-code emit`
- `unknown-device type=local sessions=2` -- a ghost device created by the backfill process

The backfill process constructs synthetic `session.start` and `session.end` events and POSTs them to the ingest pipeline. These events carry the correct `device_id` from `config.device.id`, but they do NOT include `_device_name` or `_device_type` in their `event.data` payload. When the event processor (`processEvent`) handles these events, it checks `event.data._device_name` to build device hints for `resolveOrCreateDevice()`. Since backfill events lack this field, `deviceHints` is `undefined`, and `resolveOrCreateDevice()` falls back to its hardcoded default: `name = "unknown-device"`.

In most cases, the backfill uses the same `config.device.id` as normal emit events, so the UPSERT's `CASE WHEN` clause would prevent overwriting an already-known name. However, the "unknown-device" record with 2 sessions indicates that the backfill ran with a **different device ID** than the current one. This can happen in at least two scenarios:

1. **`fuel-code init --force` was run** after the initial backfill, and the existing config was corrupted/invalid, causing a new device ID to be generated (line 107 of `init.ts`). The old device ID from the first backfill run remains in the database as "unknown-device" with its 2 sessions, while new events use the new device ID.
2. **Race condition during init**: `init` spawns `fuel-code backfill` in the background (line 225 of `init.ts`) immediately after saving config. If the first event to hit the server with the new device ID comes from backfill (no `_device_name`), the device is created as "unknown-device". A subsequent `emit` event then hits the same device ID with `_device_name`, triggering the CASE WHEN fix -- but only if the device ID matches. If init was re-run before that emit event, the device IDs diverge.

Regardless of which scenario caused the duplicate, **the root bug is that backfill events never include `_device_name`/`_device_type` in their data payload**, so any device created exclusively from backfill events will always be named "unknown-device".

## How to Reproduce

1. Ensure the fuel-code backend is running and `fuel-code init` has been completed.

2. Run the devices API check:
```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/devices" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data.get('devices', []):
    name = d.get('name', '?')
    dtype = d.get('type', '?')
    sid = d.get('session_count', 0)
    print(f'  {name} type={dtype} sessions={sid}')
    if name == 'unknown-device':
        print('    *** FAIL: device still named unknown-device ***')"
```

3. To reproduce from scratch:
```bash
# Reset database (or delete the device row)
# Run init (creates config with device ID and name)
fuel-code init --force --url http://localhost:3020 --api-key fc_local_dev_key_123

# Run backfill (this will create events without _device_name)
fuel-code backfill
```

4. Check for the "unknown-device" record:
```bash
fuel-code status
# Look at the "Device:" line -- it should show the hostname, not "unknown-device"
```

Or query Postgres directly:
```sql
SELECT id, name, type, last_seen_at,
       (SELECT COUNT(*) FROM sessions s WHERE s.device_id = d.id) as session_count
FROM devices d
ORDER BY last_seen_at DESC;
```

## Expected Behavior

- All sessions ingested via backfill should be associated with the same device record as live sessions.
- The device name should be the configured hostname (e.g., `Johns-Laptop`), never `unknown-device`.
- The Devices API should return exactly 1 device (for a single-machine setup), with the correct name and the combined session count from both live and backfilled sessions.

## Root Cause Analysis

The data flow has three stages, and the bug is a missing injection of device hints in the backfill event construction.

### Stage 1: Normal emit path correctly injects device hints

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/emit.ts`, lines 144-149

```typescript
  // Include device hints so the backend can populate the device name on first
  // registration (resolveOrCreateDevice uses these to avoid "unknown-device").
  if (config?.device.name) {
    data._device_name = config.device.name;
    data._device_type = config.device.type;
  }
```

The `emit` command injects `_device_name` and `_device_type` into the event data so the server-side event processor can pass them as hints to `resolveOrCreateDevice()`.

### Stage 2: Backfill constructs events WITHOUT device hints

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/session-backfill.ts`, lines 575-594

```typescript
      const startEvent: Event = {
        id: generateId(),
        type: "session.start" as EventType,
        timestamp: session.firstTimestamp ?? now,
        device_id: deps.deviceId,        // <-- device ID is set correctly
        workspace_id: session.workspaceCanonicalId,
        session_id: null,
        data: {
          cc_session_id: session.sessionId,
          cwd: session.resolvedCwd,
          git_branch: session.gitBranch,
          git_remote: null,
          cc_version: null,
          model: null,
          source: "backfill",
          transcript_path: session.transcriptPath,
          // MISSING: _device_name and _device_type are never set here
        },
        ingested_at: null,
        blob_refs: [],
      };
```

Similarly for the `session.end` event at lines 613-628 -- no `_device_name` or `_device_type` in the data payload.

The `IngestDeps` interface (lines 94-113) accepts `deviceId` but has no field for `deviceName` or `deviceType`, so the backfill command at `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/backfill.ts` line 178 only passes `config.device.id`:

```typescript
      deviceId: config.device.id,
      // config.device.name is available but never passed
```

### Stage 3: Event processor finds no hints, defaults to "unknown-device"

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/event-processor.ts`, lines 151-157

```typescript
  const deviceHints = event.data._device_name
    ? {
        name: event.data._device_name as string,
        type: (event.data._device_type as "local" | "remote") ?? "local",
      }
    : undefined;
  await resolveOrCreateDevice(sql, event.device_id, deviceHints);
```

Since backfill events have no `_device_name` in their data, `deviceHints` is `undefined`.

### Stage 4: Device resolver uses "unknown-device" as default name

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/device-resolver.ts`, line 43

```typescript
  const name = hints?.name || "unknown-device";
```

With no hints, the device is inserted with `name = "unknown-device"`. The UPSERT's CASE WHEN clause (line 54) would fix this on subsequent events **if** a later event for the same device ID carries `_device_name`, but if the backfill used a device ID that only ever receives backfill events, the name stays "unknown-device" permanently.

### Contributing factor: init auto-triggers backfill

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/init.ts`, lines 224-228

```typescript
      Bun.spawn(["fuel-code", "backfill"], {
        stdout: "ignore",
        stderr: "ignore",
      });
```

The `init` command spawns backfill as a detached background process. If init is later re-run with `--force` and a new device ID is generated (due to corrupted config), the background backfill process may have already created events with the old device ID, leaving an orphaned "unknown-device" record.

## Fix Plan

### Step 1: Add device name/type to `IngestDeps` interface

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/session-backfill.ts`

Add `deviceName` and `deviceType` fields to the `IngestDeps` interface (around line 100):

```typescript
export interface IngestDeps {
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  /** Device name to stamp on synthetic events (for device resolver hints) */
  deviceName?: string;
  /** Device type to stamp on synthetic events (defaults to "local") */
  deviceType?: string;
  // ... rest of interface
}
```

### Step 2: Inject `_device_name` and `_device_type` into backfill events

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/session-backfill.ts`

In the `processSession` function, add `_device_name` and `_device_type` to the data payload of both the `session.start` event (around line 583) and the `session.end` event (around line 620):

For `session.start` (line 583):
```typescript
        data: {
          cc_session_id: session.sessionId,
          cwd: session.resolvedCwd,
          git_branch: session.gitBranch,
          git_remote: null,
          cc_version: null,
          model: null,
          source: "backfill",
          transcript_path: session.transcriptPath,
          // Device hints for resolveOrCreateDevice() -- mirrors emit.ts behavior
          ...(deps.deviceName ? { _device_name: deps.deviceName, _device_type: deps.deviceType ?? "local" } : {}),
        },
```

For `session.end` (around line 620):
```typescript
        data: {
          cc_session_id: session.sessionId,
          duration_ms: durationMs,
          end_reason: "exit",
          transcript_path: session.transcriptPath,
          ...(deps.deviceName ? { _device_name: deps.deviceName, _device_type: deps.deviceType ?? "local" } : {}),
        },
```

### Step 3: Pass device name from CLI backfill command

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/backfill.ts`

At line 178, add `deviceName` and `deviceType` to the `ingestBackfillSessions` call:

```typescript
    const result = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: config.backend.url,
      apiKey: config.backend.api_key,
      deviceId: config.device.id,
      deviceName: config.device.name,
      deviceType: config.device.type,
      signal: abortController.signal,
      alreadyIngested,
      concurrency,
      // ...
    });
```

### Step 4: Update tests

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/__tests__/backfill.test.ts`

Update the backfill test to verify that `_device_name` and `_device_type` are included in events sent to the server. Add assertions that the synthetic events include these fields in their data payload.

### Step 5: Clean up the existing "unknown-device" record in Postgres

Run a one-time cleanup to either:

a. Merge sessions from the "unknown-device" record into the real device (if they have different device IDs):
```sql
-- First, identify the device IDs
SELECT id, name, type FROM devices ORDER BY last_seen_at DESC;

-- Reassign sessions from unknown-device to the real device
UPDATE sessions SET device_id = '<real-device-id>'
WHERE device_id = '<unknown-device-id>';

-- Reassign events
UPDATE events SET device_id = '<real-device-id>'
WHERE device_id = '<unknown-device-id>';

-- Reassign workspace_devices links
UPDATE workspace_devices SET device_id = '<real-device-id>'
WHERE device_id = '<unknown-device-id>'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_devices wd2
    WHERE wd2.workspace_id = workspace_devices.workspace_id
      AND wd2.device_id = '<real-device-id>'
  );
DELETE FROM workspace_devices WHERE device_id = '<unknown-device-id>';

-- Delete the orphan device
DELETE FROM devices WHERE id = '<unknown-device-id>';
```

b. Or simply rename it if it has the same device ID:
```sql
UPDATE devices SET name = 'Johns-Laptop'
WHERE name = 'unknown-device';
```

### Verification

After applying the fix, re-run backfill on a clean database and verify:

```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/devices" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data.get('devices', []):
    name = d.get('name', '?')
    dtype = d.get('type', '?')
    sid = d.get('session_count', 0)
    print(f'  {name} type={dtype} sessions={sid}')
    if name == 'unknown-device':
        print('    *** FAIL: device still named unknown-device ***')
    else:
        print('    OK')"
```

Expected: exactly 1 device with the correct hostname and all sessions (live + backfilled) accounted for.

Also run unit tests:
```bash
bun test packages/core/src/__tests__/event-processor.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```
