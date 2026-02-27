# Task W10.4: Strip _device_name/_device_type from Persisted Event Data

## Validation Workflow: W10.4

## Problem

The CLI `emit` command injects `_device_name` and `_device_type` into the event's `data` JSON payload as transport hints so the event processor can populate the device name on first registration. However, the event processor extracts these fields for device resolution but never removes them from `event.data` before inserting the event row into Postgres. As a result, every event emitted via `fuel-code emit` (git hooks, Claude Code hooks) permanently stores these internal transport fields in the `events.data` JSONB column.

**Example**: Events `01KJ6678` and `01KJ667K` in session `92ea6704` contain:
```json
{
  "_device_name": "Johns-Laptop",
  "_device_type": "local",
  "cc_session_id": "...",
  "cwd": "...",
  ...
}
```

These underscore-prefixed fields are internal transport metadata that should never be visible to API consumers, CLI displays, exports, or any downstream analysis (Phase 5 embeddings/clustering).

## How to Reproduce

1. Ensure the fuel-code backend is running and a session has been recorded via hooks.

2. Get a recent session ID:
```bash
SESS_ID=$(curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions?limit=1" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'][0]['id'])")
```

3. Fetch events for the session and check for leaked fields:
```bash
curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions/${SESS_ID}/events" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for e in data.get('events', []):
    d = e.get('data', {})
    if '_device_name' in d or '_device_type' in d:
        print(f'  *** FAIL: event {e[\"id\"][:8]} has _device_name={d.get(\"_device_name\")} _device_type={d.get(\"_device_type\")} ***')
    else:
        print(f'  OK: event {e[\"id\"][:8]} type={e[\"type\"]} -- no leakage')"
```

4. Or query Postgres directly:
```sql
SELECT id, type, data->'_device_name' as leaked_name, data->'_device_type' as leaked_type
FROM events
WHERE data ? '_device_name'
LIMIT 10;
```

**Expected**: No events have `_device_name` or `_device_type` in their data field.
**Actual**: Most events emitted via the CLI contain both fields.

## Expected Behavior

- The `_device_name` and `_device_type` fields should be used transiently by the event processor to pass device hints to `resolveOrCreateDevice()`, then stripped from `event.data` before the INSERT into the events table.
- API responses (GET /api/sessions/:id/events) should never expose these internal transport fields.
- Only domain-relevant data (e.g., `cc_session_id`, `cwd`, `git_branch`, `sha`, `message`) should be persisted in the `data` column.

## Root Cause Analysis

The data flow has three stages, and the bug is a missing cleanup step between stages 2 and 3:

### Stage 1: CLI injects transport hints into event.data

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/emit.ts`, lines 146-149

```typescript
  // Include device hints so the backend can populate the device name on first
  // registration (resolveOrCreateDevice uses these to avoid "unknown-device").
  if (config?.device.name) {
    data._device_name = config.device.name;
    data._device_type = config.device.type;
  }
```

The emit command adds `_device_name` and `_device_type` directly into the event's `data` object. This data object becomes `event.data` in the Event payload sent to the ingest endpoint.

### Stage 2: Event processor reads hints but does not strip them

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/event-processor.ts`, lines 148-157

```typescript
  // 2. Resolve device: ensure device row exists.
  // Extract device hints from the event data (injected by the CLI emit command)
  // so the device name is populated on first registration.
  const deviceHints = event.data._device_name
    ? {
        name: event.data._device_name as string,
        type: (event.data._device_type as "local" | "remote") ?? "local",
      }
    : undefined;
  await resolveOrCreateDevice(sql, event.device_id, deviceHints);
```

The processor correctly reads `_device_name` and `_device_type` from `event.data` and passes them as hints to `resolveOrCreateDevice()`. However, **it never deletes these fields from `event.data`** after extracting them.

### Stage 3: event.data is persisted as-is (including leaked fields)

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/event-processor.ts`, line 175

```typescript
  const insertResult = await sql`
    INSERT INTO events (id, type, timestamp, device_id, workspace_id, session_id, data, blob_refs, ingested_at)
    VALUES (
      ...
      ${JSON.stringify(event.data)},     // <-- _device_name and _device_type are still here
      ...
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
```

`event.data` is serialized via `JSON.stringify()` and stored in the `data` JSONB column, including the transport hints that should have been stripped.

### Additional context

- The event travels through the Redis Stream (serialize in `stream.ts:101-113`, deserialize in `stream.ts:121-133`) as `JSON.stringify(event.data)` / `JSON.parse(fields.data)`, so the fields survive the stream round-trip.
- The ingest endpoint (`events.ts`) does not strip these fields either -- it passes the event as-is to the Redis Stream.
- Backfill events (from `session-backfill.ts`) do NOT have this issue because they construct events directly without injecting `_device_name`/`_device_type`.
- The emit test (`emit.test.ts`) actually **asserts** that these fields are present in event.data (line 312, 397, 439), which means the test expectations will need to be updated.

## Fix Plan

### Step 1: Strip transport fields in the event processor after extraction

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/event-processor.ts`

After line 157 (after `resolveOrCreateDevice` call), add cleanup code to remove the transport hints from `event.data` before persistence:

```typescript
  await resolveOrCreateDevice(sql, event.device_id, deviceHints);

  // Strip internal transport hints from event.data before persistence.
  // These fields are injected by the CLI emit command solely for device
  // resolution and should not leak into the persisted event record.
  delete event.data._device_name;
  delete event.data._device_type;
```

This must happen BEFORE line 175 where `JSON.stringify(event.data)` is called for the INSERT.

### Step 2: Update event processor tests

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/__tests__/event-processor.test.ts`

The test at line 485 ("passes device hints from event.data to resolveOrCreateDevice") should additionally verify that `_device_name` and `_device_type` are no longer present in the persisted data. Add an assertion after the existing ones:

```typescript
  // Verify the transport hints were stripped before persistence
  const insertCall = calls[3]; // The INSERT call (index 3 after workspace, device, link)
  const persistedData = JSON.parse(insertCall.values[6]); // data is the 7th value
  expect(persistedData._device_name).toBeUndefined();
  expect(persistedData._device_type).toBeUndefined();
```

### Step 3: Update emit command tests

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/__tests__/emit.test.ts`

The tests that assert `_device_name` and `_device_type` are in event.data (lines 312, 397, 439) are testing the CLI emit behavior, not the processor. These assertions are correct for the emit stage -- the CLI **should** include these fields in the data it sends. The stripping happens server-side in the event processor. No changes needed here.

### Step 4: Add a dedicated unit test for stripping behavior

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/__tests__/event-processor.test.ts`

Add a new test case in the "processEvent" describe block:

```typescript
test("strips _device_name and _device_type from event.data before persisting", async () => {
  const event = makeSessionStartEvent({
    data: {
      ...makeSessionStartEvent().data,
      _device_name: "my-laptop",
      _device_type: "local",
    },
  });
  const registry = new EventHandlerRegistry();
  const logger = createMockLogger();
  const { sql, calls } = createMockSql(standardResultSets([{ id: event.id }]));

  await processEvent(sql, event, registry, logger);

  // The INSERT call (index 3) should have data without transport hints
  const insertCall = calls[3];
  const persistedData = JSON.parse(insertCall.values[6]);
  expect(persistedData._device_name).toBeUndefined();
  expect(persistedData._device_type).toBeUndefined();
  // Domain data should still be present
  expect(persistedData.cc_session_id).toBeDefined();
  expect(persistedData.cwd).toBeDefined();
});
```

### Step 5 (optional): Clean up existing leaked data in Postgres

For already-persisted events, a one-time SQL migration or manual query can strip the leaked fields:

```sql
UPDATE events
SET data = data - '_device_name' - '_device_type'
WHERE data ? '_device_name' OR data ? '_device_type';
```

This is safe because these fields are never consumed after persistence. This step is optional and can be done as a follow-up.

### Verification

After applying the fix, re-run the W10.4 validation check:

```bash
SESS_ID=$(curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions?limit=1" | python3 -c "import sys,json; print(json.load(sys.stdin)['sessions'][0]['id'])")

curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
  "http://localhost:3020/api/sessions/${SESS_ID}/events" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for e in data.get('events', []):
    d = e.get('data', {})
    if '_device_name' in d or '_device_type' in d:
        print(f'  *** FAIL: event {e[\"id\"][:8]} has _device_name={d.get(\"_device_name\")} _device_type={d.get(\"_device_type\")} ***')
    else:
        print(f'  OK: event {e[\"id\"][:8]} type={e[\"type\"]} -- no leakage')"
```

All events should report "OK: ... -- no leakage".

Also run the unit tests:
```bash
bun test packages/core/src/__tests__/event-processor.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```
