# Task 9: EC2 Orphan Detection Hardening

## Parallel Group: C

## Dependencies: Task 5

## Description

Harden the orphan detection logic in the lifecycle enforcer (Phase 5, Task 9) to prevent false-positive terminations. The current orphan sweep uses a simple cross-reference between AWS instances and DB records. Phase 6 adds multi-check verification: an instance must satisfy ALL of five conditions before being classified as an orphan. The `fuel-code:created-at` tag (added atomically at launch in Task 5) enables a grace period without additional API calls. Additionally, the orphan sweep now logs a structured audit trail of every decision.

### Current Orphan Detection (Phase 5)

```
For each AWS instance tagged fuel-code:managed=true:
  1. Look up in DB by instance_id
  2. If no DB record → orphan, terminate
  3. If DB says terminated → orphan, terminate
```

### Hardened Orphan Detection (Phase 6)

```
For each AWS instance tagged fuel-code:managed=true:

  CHECK 1: Has fuel-code:managed=true tag
    → Already satisfied by the query filter. Redundant check for clarity.

  CHECK 2: Has fuel-code:remote-env-id tag with valid ULID
    → If tag missing or value is not a valid ULID → log warning, skip (don't terminate).
    → This protects against accidentally-tagged non-fuel-code instances.

  CHECK 3: No matching DB record OR DB record with terminal status
    → Look up by remote_env_id (from tag), not just instance_id.
    → "Terminal status" = status IN ('terminated', 'error').
    → If DB record exists with non-terminal status → NOT an orphan.

  CHECK 4: Running for more than 15 minutes (grace period)
    → Parse fuel-code:created-at tag (ISO timestamp).
    → If now() - created_at < 15 minutes → skip (instance may still be provisioning).
    → This eliminates race conditions during normal provisioning.

  CHECK 5: No active session on matching device_id
    → If DB record exists, get device_id from remote_env.
    → Check sessions table for lifecycle='capturing' on that device_id.
    → If an active session exists → NOT an orphan (actively in use).

  ALL FIVE checks pass → classify as orphan, terminate.
  Any check fails → skip, log the reason.
```

### Audit Trail

Every orphan sweep decision is logged at info level:

```typescript
interface OrphanDecision {
  instanceId: string;
  remoteEnvId: string | null;
  action: 'terminated' | 'skipped';
  reason: string;
  checks: {
    managedTag: boolean;
    validRemoteEnvId: boolean;
    noActiveDbRecord: boolean;
    pastGracePeriod: boolean;
    noActiveSession: boolean;
  };
}
```

### Updated OrphanSweepResult

```typescript
export interface OrphanSweepResult {
  awsInstancesChecked: number;
  orphansTerminated: number;
  dbRecordsCleaned: number;
  skipped: number;         // NEW: instances that passed some but not all checks
  errors: { id: string; error: string }[];
  // Detailed decisions for debugging (logged, not returned to caller in production)
  decisions: OrphanDecision[];
}
```

### DB-Side Orphan Cleanup (also hardened)

The existing DB-side check (DB records with no matching AWS instance) also gets grace period enforcement:

```
For each DB record with status NOT IN ('terminated', 'error'):
  1. Check if instance_id is set.
  2. If instance_id is set, check AWS state.
  3. If instance not found in AWS OR is terminated/shutting-down:
     a. CHECK: provisioned_at + 15 minutes < now()
        → If within grace period → skip (instance may still be launching).
     b. CHECK: No active session on device_id
        → If active session → skip.
     c. Both checks pass → update DB to 'terminated' with reason 'orphan-cleanup'.
```

### ULID Validation

```typescript
// Use the existing ULID validation from packages/shared
import { isValidUlid } from '@fuel-code/shared';

// Check 2: validate the remote-env-id tag value
const remoteEnvId = instance.tags['fuel-code:remote-env-id'];
if (!remoteEnvId || !isValidUlid(remoteEnvId)) {
  decisions.push({
    instanceId: instance.instanceId,
    remoteEnvId: null,
    action: 'skipped',
    reason: 'Invalid or missing fuel-code:remote-env-id tag',
    checks: { managedTag: true, validRemoteEnvId: false, noActiveDbRecord: false, pastGracePeriod: false, noActiveSession: false },
  });
  continue;
}
```

### Changes to Ec2Operations Interface

The `describeInstancesByTag` method needs to return tags so the orphan sweep can read `fuel-code:remote-env-id` and `fuel-code:created-at`:

```typescript
// Update InstanceDescription (from Phase 5, Task 3)
export interface InstanceDescription {
  instanceId: string;
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';
  publicIp: string | null;
  launchTime: Date;
  instanceType: string;
  tags: Record<string, string>;  // NEW: include tags
}
```

If `tags` is not already on `InstanceDescription`, add it. The `describeInstancesByTag` implementation should populate it from the AWS response.

### Relevant Files

**Modify:**
- `packages/server/src/services/lifecycle-enforcer.ts` — replace orphan detection logic with multi-check verification, add audit logging
- `packages/server/src/aws/ec2-client.ts` — ensure `InstanceDescription` includes `tags` field (if not already)
- `packages/server/src/aws/ec2-mock.ts` — update mock responses to include tags

### Tests

`lifecycle-enforcer.test.ts` updates (bun:test):

1. Instance passes all 5 checks → terminated as orphan.
2. Instance missing `fuel-code:remote-env-id` tag → skipped (Check 2 fails).
3. Instance with invalid ULID in `fuel-code:remote-env-id` tag → skipped (Check 2 fails).
4. Instance with matching non-terminal DB record → skipped (Check 3 fails).
5. Instance within 15-minute grace period (`fuel-code:created-at` is recent) → skipped (Check 4 fails).
6. Instance with active session on its device_id → skipped (Check 5 fails).
7. Instance past grace period, no DB record → terminated.
8. Instance past grace period, DB record with status 'terminated' → terminated.
9. Instance past grace period, DB record with status 'error' → terminated.
10. Missing `fuel-code:created-at` tag → treated as past grace period (conservative: still eligible for termination if other checks pass, but logged as warning).
11. DB-side: record with instance not found in AWS, past grace period, no active session → DB updated to terminated.
12. DB-side: record within grace period → skipped.
13. DB-side: record with active session → skipped.
14. Audit trail: every decision logged with all 5 check results.
15. `OrphanSweepResult.skipped` count is accurate.
16. `OrphanSweepResult.decisions` contains one entry per instance checked.
17. One instance fails to terminate (AWS error) → others still processed.
18. EC2 API unreachable → sweep skipped gracefully, error logged.

### Success Criteria

1. Orphan detection requires ALL 5 checks to pass before terminating — no false positives.
2. Grace period (15 minutes) prevents termination during normal provisioning.
3. ULID validation protects against accidentally-tagged non-fuel-code instances.
4. Active session check prevents termination of environments in active use.
5. `fuel-code:created-at` tag (from Task 5) enables grace period without extra API calls.
6. `InstanceDescription` includes tags for orphan sweep to read.
7. Every decision is logged with all check results for debugging.
8. DB-side orphan cleanup also enforces grace period and active session checks.
9. One failed termination does not block processing of other orphans.
10. The hardened sweep is backward-compatible with Phase 5 lifecycle enforcer — same interface, stronger logic.
