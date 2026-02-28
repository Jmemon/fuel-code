# Task 15: Phase 5 E2E Integration Tests

## Parallel Group: F

## Dependencies: Tasks 9, 10, 11, 12, 13, 14

## Description

End-to-end integration tests verifying the complete Phase 5 flow: blueprint detection, provisioning, SSH, listing, termination, auto-cleanup, and TUI updates. All tests use a mock EC2 client — no actual AWS resources. Tests exercise the full stack: CLI commands → API endpoints → DB → event pipeline → handlers → WebSocket broadcasts.

### Test Strategy

- **Mock layer**: `MockEc2Client` (from Task 3) replaces the real EC2 client. A mock S3 client (or the existing test S3 setup) handles SSH key storage. Mock `ssh-keygen` returns fixed key pairs.
- **Real components**: Express server, Postgres (test DB), Redis Stream pipeline, WebSocket server.
- **Time control**: Injectable `now()` in the lifecycle enforcer for deterministic idle/TTL testing.
- **CLI testing**: CLI commands are tested by calling their action functions directly with mocked dependencies, not by spawning subprocesses.

### Test Scenarios

**Scenario 1: Blueprint Detection E2E**

```typescript
test('blueprint detect generates correct env.yaml for Node.js project', async () => {
  // Create temp dir with package.json + bun.lockb
  // Run blueprint detect action
  // Verify .fuel-code/env.yaml created
  // Verify runtime=node, pm=bun, base_image=node:22-bookworm
  // Run blueprint show → verify output matches
  // Run blueprint validate → verify exit code 0
});

test('blueprint detect for Python project', async () => {
  // Create temp dir with pyproject.toml + uv.lock
  // Verify runtime=python, pm=uv
});

test('blueprint validate catches invalid config', async () => {
  // Write env.yaml with invalid instance_type
  // Run blueprint validate → verify exit code 1, errors listed
});
```

**Scenario 2: Full Provisioning Lifecycle (mocked AWS)**

```typescript
test('complete provision → ready → terminate lifecycle', async () => {
  // 1. POST /api/remote with test blueprint
  //    → Verify 202, remote_env created with status=provisioning
  //    → Mock EC2 returns fake instance ID

  // 2. Provisioner generates SSH keys, "launches" mock EC2
  //    → Verify remote_env has instance_id set

  // 3. Simulate ready callback: POST /api/remote/:id/ready
  //    → Verify status=ready, public_ip set, ready_at set
  //    → Verify remote.provision.start and remote.provision.ready events in events table

  // 4. GET /api/remote → verify it appears in list
  // 5. GET /api/remote/:id → verify all fields populated

  // 6. GET /api/remote/:id/ssh-key → verify key returned
  // 7. GET /api/remote/:id/ssh-key again → verify 410 Gone

  // 8. POST /api/remote/:id/terminate → status=terminated
  //    → Verify remote.terminate event emitted
  //    → Verify SSH keys deleted from mock S3
  //    → Verify EC2 instance terminated via mock

  // 9. GET /api/remote (default) → terminated env excluded
  // 10. GET /api/remote?include_terminated=true → env appears
});
```

**Scenario 3: Idle Timeout Auto-Termination**

```typescript
test('idle timeout terminates unused environment', async () => {
  // 1. Create remote_env with status=ready, idle_timeout_minutes=1
  // 2. Set now() to ready_at + 30 seconds
  // 3. Run lifecycle check → no termination (within window)
  // 4. Set now() to ready_at + 90 seconds (past idle timeout)
  // 5. Run lifecycle check → env transitions to 'idle' (first step)
  // 6. Set now() to ready_at + 150 seconds
  // 7. Run lifecycle check → env terminated with reason 'idle' (second step)
});
```

**Scenario 4: TTL Auto-Termination**

```typescript
test('TTL terminates long-running environment', async () => {
  // 1. Create remote_env with ttl_minutes=1, provisioned_at = 2 minutes ago
  // 2. Run lifecycle check → terminated with reason 'ttl'
});
```

**Scenario 5: Provisioning Timeout**

```typescript
test('provisioning timeout marks environment as error', async () => {
  // 1. Create remote_env with status=provisioning, provisioned_at = 15 minutes ago
  // 2. Run lifecycle check → status set to 'error', reason 'provision-timeout'
});
```

**Scenario 6: Orphan Detection**

```typescript
test('orphan detection cleans up untracked AWS instances', async () => {
  // 1. Mock EC2 returns an instance tagged fuel-code:managed=true with no DB record
  // 2. Run orphan sweep → instance terminated via mock EC2
  // 3. Verify sweep result: orphansTerminated = 1
});

test('orphan detection cleans up stale DB records', async () => {
  // 1. Create DB record with status=ready, but mock EC2 says instance is terminated
  // 2. Run orphan sweep → DB record updated to terminated, reason 'orphan-cleanup'
});
```

**Scenario 7: Provisioning Error Handling**

```typescript
test('EC2 launch failure rolls back correctly', async () => {
  // 1. Configure mock EC2 to fail on launchInstance
  // 2. POST /api/remote → provisioner runs, fails at launch
  // 3. Verify: remote_env status=error, error message includes stage
  // 4. Verify: SSH keys deleted from S3 (cleanup)
  // 5. Verify: remote.provision.error event emitted
});
```

**Scenario 8: CLI `remote ls` Output**

```typescript
test('remote ls shows formatted table', async () => {
  // 1. Seed DB with 3 remote envs: 1 ready, 1 active, 1 terminated
  // 2. Run remote ls action with --json → verify 2 envs (excludes terminated)
  // 3. Run remote ls --all --json → verify 3 envs
});
```

**Scenario 9: Remote SSH Command Construction**

```typescript
test('remote ssh constructs correct SSH command', async () => {
  // 1. Create ready remote env with known IP
  // 2. Mock API to return SSH key
  // 3. Run remote ssh action (mock Bun.spawn to capture args)
  // 4. Verify SSH args include -i, -t, StrictHostKeyChecking=no, correct IP
  // 5. Verify docker exec into fuel-code-remote container
});
```

**Scenario 10: WebSocket `remote.update` Broadcasts**

```typescript
test('WebSocket broadcasts remote status changes', async () => {
  // 1. Connect WebSocket client subscribed to workspace
  // 2. POST /api/remote/:id/ready → trigger status change
  // 3. Verify WS client received remote.update with status=ready and public_ip
  // 4. POST /api/remote/:id/terminate → trigger termination
  // 5. Verify WS client received remote.update with status=terminated
});
```

**Scenario 11: Graceful Abort**

```typescript
test('Ctrl-C during remote up triggers cleanup', async () => {
  // 1. Start remote up action with mock API that delays provisioning
  // 2. Simulate abort signal
  // 3. Verify terminate endpoint called
  // 4. Verify cleanup message printed
});
```

**Scenario 12: Session-Device Correlation**

```typescript
test('session.start from remote device transitions env to active', async () => {
  // 1. Create ready remote env with associated device
  // 2. Emit session.start event from that device
  // 3. Verify remote_env status = 'active'
  // 4. Emit session.end event
  // 5. Verify remote_env status = 'ready'
});
```

### Mock Infrastructure

```typescript
// packages/server/src/__tests__/fixtures/phase5-mocks.ts

export function createPhase5TestContext(): {
  ec2Client: MockEc2Client;
  sshKeyManager: SshKeyManager;  // with mock S3
  provisioner: typeof provisionRemoteEnv;
  lifecycleEnforcer: LifecycleEnforcer;
  app: Express;  // configured test server
  sql: postgres.Sql;  // test database
  wsClient: WebSocket;
  cleanup: () => Promise<void>;
};
```

### Relevant Files

**Create:**
- `packages/server/src/__tests__/e2e/phase5-lifecycle.test.ts`
- `packages/server/src/__tests__/e2e/phase5-orphan.test.ts`
- `packages/cli/src/__tests__/e2e/phase5-commands.test.ts`
- `packages/server/src/__tests__/fixtures/phase5-mocks.ts`

### Tests Summary

| # | Scenario | Type | Key Verification |
|---|----------|------|-----------------|
| 1 | Blueprint detection | CLI | env.yaml generated correctly |
| 2 | Full lifecycle | Server | provision → ready → terminate, all events |
| 3 | Idle timeout | Server | Two-step: idle → terminate |
| 4 | TTL timeout | Server | Auto-terminate after TTL |
| 5 | Provisioning timeout | Server | Error after 10 min |
| 6 | Orphan detection | Server | AWS ↔ DB reconciliation |
| 7 | Provisioning error | Server | Rollback on EC2 failure |
| 8 | remote ls | CLI | Table formatting, filters |
| 9 | remote ssh | CLI | SSH command construction |
| 10 | WebSocket | Server | Real-time broadcasts |
| 11 | Graceful abort | CLI | Ctrl-C cleanup |
| 12 | Session correlation | Server | active ↔ ready transitions |

### Success Criteria

1. All 12 test scenarios pass.
2. Tests use mock EC2 — no actual AWS instances launched.
3. Tests exercise the full stack: API → DB → event pipeline → handlers → WebSocket.
4. Blueprint detection E2E creates and validates real env.yaml files.
5. Provisioning lifecycle verifies all status transitions and events.
6. Termination lifecycle verifies cleanup (SSH keys, EC2 instance, DB status).
7. Lifecycle enforcer tests verify idle (two-step), TTL, and provisioning timeout.
8. Orphan detection tests verify bidirectional AWS ↔ DB reconciliation.
9. Error handling tests verify rollback on provisioning failure.
10. WebSocket tests verify real-time broadcast of status updates.
11. Tests are isolated — each creates its own data and cleans up.
12. Tests complete in under 60 seconds total (no real AWS calls, no real timeouts).
