# Task 9: Lifecycle Enforcer — Idle/TTL + Orphan Detection

## Parallel Group: C

## Dependencies: Tasks 3, 6

## Description

Implement a periodic server-side job that handles three lifecycle concerns: TTL auto-termination, idle timeout detection with two-step warning, provisioning timeout, and orphaned instance cleanup. This runs as `setInterval` loops inside the Express server process.

### Interface

```typescript
// packages/server/src/services/lifecycle-enforcer.ts

export interface LifecycleEnforcerDeps {
  ec2Client: Ec2Operations;
  sshKeyManager: SshKeyManager;
  sql: postgres.Sql;
  logger: pino.Logger;
  broadcaster: WsBroadcaster;
  // Injectable for testing — defaults to () => Date.now()
  now?: () => number;
  // Interval for lifecycle checks (default: 60_000 ms = 1 minute)
  lifecycleIntervalMs?: number;
  // Interval for orphan sweep (default: 300_000 ms = 5 minutes)
  orphanIntervalMs?: number;
}

export interface LifecycleEnforcer {
  // Start both periodic checks
  start(): void;
  // Stop both periodic checks and wait for in-flight operations
  stop(): Promise<void>;
  // Run one lifecycle check cycle (for testing)
  runLifecycleCheck(): Promise<LifecycleCheckResult>;
  // Run one orphan sweep (for testing)
  runOrphanSweep(): Promise<OrphanSweepResult>;
}

export interface LifecycleCheckResult {
  checked: number;
  terminated: { id: string; reason: 'idle' | 'ttl' | 'provision-timeout' }[];
  transitioned: { id: string; from: string; to: string }[];
  errors: { id: string; error: string }[];
}

export interface OrphanSweepResult {
  awsInstancesChecked: number;
  orphansTerminated: number;
  dbRecordsCleaned: number;
  errors: { id: string; error: string }[];
}

export function createLifecycleEnforcer(deps: LifecycleEnforcerDeps): LifecycleEnforcer;
```

### Lifecycle Check Logic (every 60 seconds)

```
runLifecycleCheck():

1. Query all remote_envs with status IN ('provisioning', 'ready', 'active', 'idle')
2. For each environment:

   a. PROVISIONING TIMEOUT:
      If status = 'provisioning' and now() - provisioned_at > 10 minutes:
        → Set status to 'error' with reason 'provision-timeout'
        → Call terminateRemoteEnv(id, 'provision-timeout')
        → Log at warn level

   b. TTL CHECK:
      If now() - provisioned_at > ttl_minutes * 60_000:
        → Call terminateRemoteEnv(id, 'ttl')
        → Log at info level

   c. IDLE CHECK (two-step):
      Query: SELECT MAX(timestamp) FROM events WHERE device_id = env.device_id

      If no events AND now() - ready_at > idle_timeout_minutes * 60_000:
        → Environment was provisioned but never used
        → Call terminateRemoteEnv(id, 'idle')

      Else if last_event + idle_timeout_minutes * 60_000 < now():
        If status is NOT 'idle':
          → First step: transition to 'idle', broadcast remote.update
          → Do NOT terminate yet — give user a warning window
        Else (status is already 'idle'):
          → Second step: already warned, now terminate
          → Call terminateRemoteEnv(id, 'idle')

3. If an environment receives a session.start (handled in Task 7), it transitions
   from 'idle' back to 'active', resetting the idle timer.

4. Log summary: "Lifecycle check: checked N, terminated M, transitioned K, errors E"
```

### Orphan Detection Logic (every 5 minutes)

```
runOrphanSweep():

1. Call ec2Client.describeInstancesByTag('fuel-code:managed', 'true')
   → Get all fuel-code-managed EC2 instances currently in AWS

2. For each AWS instance:
   a. Extract remote_env_id from 'fuel-code:remote-env-id' tag
   b. Look up in DB: getRemoteEnvByInstanceId(instance.instanceId) OR by remote_env_id

   CASE 1: Instance in AWS, no matching DB record
     → Orphan: terminate via EC2, log at warn

   CASE 2: Instance running in AWS, DB says 'terminated' or 'error'
     → Stale instance: terminate via EC2, log at warn

   CASE 3: Both agree (running + non-terminated DB) → no action
   CASE 4: Both terminated → no action

3. For each DB record with status NOT IN ('terminated', 'error'):
   a. If instance_id is set, check AWS state
   b. If instance not found in AWS (or is terminated/shutting-down):
     → Stale DB record: update to 'terminated' with reason 'orphan-cleanup', log at warn

4. Log summary: "Orphan sweep: checked N instances, terminated M orphans, cleaned K DB records"
```

### Error Resilience

- Each individual environment check/termination is wrapped in try/catch. One failure does not block processing of other environments.
- The lifecycle enforcer and orphan detector log errors but never crash the server process.
- If the EC2 API is unreachable, the orphan sweep logs the error and skips the cycle.

### Wiring into Server Startup

In `packages/server/src/index.ts`:

```typescript
const lifecycleEnforcer = createLifecycleEnforcer({
  ec2Client,
  sshKeyManager,
  sql,
  logger: logger.child({ component: 'lifecycle-enforcer' }),
  broadcaster,
});
lifecycleEnforcer.start();

// On graceful shutdown:
process.on('SIGTERM', async () => {
  await lifecycleEnforcer.stop();
  // ... other cleanup ...
});
```

### Relevant Files

**Create:**
- `packages/server/src/services/lifecycle-enforcer.ts`
- `packages/server/src/services/__tests__/lifecycle-enforcer.test.ts`

**Modify:**
- `packages/server/src/index.ts` — start lifecycle enforcer on server boot, stop on shutdown

### Tests

`lifecycle-enforcer.test.ts` (bun:test, MockEc2Client + injectable `now()`):

**TTL tests:**
1. Environment older than ttl_minutes → terminated with reason `ttl`.
2. Environment within ttl_minutes → not terminated.

**Idle tests (two-step):**
3. Environment with no events for idle_timeout_minutes, status=ready → transitions to `idle`.
4. Environment with status=idle, still no events → terminated with reason `idle`.
5. Environment with recent events → not terminated, not transitioned.
6. Environment that was idle, then got a session.start → back to `active` (tested via DB state, not the enforcer itself — enforcer just skips it).

**Provisioning timeout tests:**
7. Environment stuck in `provisioning` for >10 minutes → set to `error`, terminated with reason `provision-timeout`.
8. Environment in `provisioning` for <10 minutes → not touched.

**Orphan tests:**
9. AWS instance tagged as fuel-code-managed, no DB record → terminated via EC2.
10. AWS instance running, DB says terminated → terminated via EC2.
11. DB says ready, instance not found in AWS → DB updated to terminated with reason `orphan-cleanup`.
12. Both agree (running + active DB) → no action.
13. Both terminated → no action.

**Resilience tests:**
14. One environment fails to terminate → others still processed, error logged.
15. EC2 API unreachable during orphan sweep → error logged, sweep skipped gracefully.

**Lifecycle tests:**
16. `start()` begins both intervals.
17. `stop()` clears both intervals.
18. `runLifecycleCheck()` and `runOrphanSweep()` work as one-shot calls for testing.
19. Injectable `now()` allows deterministic time-based testing without real delays.

### Success Criteria

1. TTL termination: environments older than `ttl_minutes` from provisioning are terminated.
2. Idle detection uses two steps: first → `idle` (warning), next cycle → terminate.
3. Provisioning timeout: environments stuck in `provisioning` for >10 min are marked `error`.
4. Orphan detection cross-references AWS instances with DB records and cleans up discrepancies.
5. Each check is resilient: one failed termination does not block others.
6. `runLifecycleCheck()` and `runOrphanSweep()` enable deterministic testing.
7. Injectable `now()` eliminates flaky time-based tests.
8. Lifecycle enforcer is started on server boot and stopped on graceful shutdown.
9. All terminations use `terminateRemoteEnv()` from Task 8 for consistent cleanup.
10. Summaries are logged after each cycle at info level.
