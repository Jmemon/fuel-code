# Task 8: Phase 7 E2E Integration Tests

## Parallel Group: E

## Dependencies: Tasks 4, 5, 6, 7

## Description

Build an end-to-end test suite that verifies the complete Phase 7 change request workflow. Due to the external dependencies (Slack API, EC2), these tests use mocks for external services but test the real orchestration logic, API endpoints, and data flow through Postgres.

### Prerequisites
- Docker Compose for local Postgres and Redis
- All Phase 7 tasks (1-7) complete
- Phase 5 infrastructure (or mocks) available

### Test Infrastructure

**`packages/e2e/change-requests.test.ts`**:

Test setup:
- Use existing docker-compose.test.yml (Postgres + Redis + LocalStack)
- Mock the EC2 client (Phase 5's MockEc2Client)
- Mock the SSH execution (no real EC2 instances in tests)
- Mock the Slack client (no real Slack API calls)
- Real Postgres, real Redis, real event pipeline

### Test Suites

**Suite 1: Change Request Lifecycle (API-driven)**

Test 1: Full happy path via API:
1. POST /api/changes with a change description.
2. Assert: 202 response, CR in 'pending' status.
3. Wait for orchestrator to provision (mocked EC2 -> instant ready).
4. Assert: CR transitions through provisioning -> implementing -> deployed.
5. Assert: remote_env_id, session_id, branch_name, preview_url are set.
6. POST /api/changes/:id/approve.
7. Assert: CR transitions through approved -> merging -> merged.
8. Assert: merge_commit_sha set, completed_at set.
9. Assert: remote env terminated.
10. Assert: change.* events in events table (requested, implementing, deployed, approved, merged).

Test 2: Rejection flow:
1. Create CR, wait for 'deployed'.
2. POST /api/changes/:id/reject.
3. Assert: CR status 'rejected', completed_at set.
4. Assert: remote env terminated.
5. Assert: change.rejected event in events table.

Test 3: Failure during implementation:
1. Create CR. Mock CC to fail (non-zero exit).
2. Assert: CR status 'failed', error message set.
3. Assert: remote env terminated (cleanup).
4. Assert: change.failed event in events table.

Test 4: Retry after failure:
1. Create CR that fails during implementation.
2. POST /api/changes/:id/retry.
3. Assert: CR transitions back to 'pending', then re-runs workflow.
4. Mock CC to succeed this time.
5. Assert: CR reaches 'deployed'.

Test 5: Cancel during provisioning:
1. Create CR, immediately POST /api/changes/:id/cancel.
2. Assert: CR status 'failed' with error 'Cancelled by user'.
3. Assert: remote env terminated if it was provisioned.

Test 6: Idempotency:
1. POST /api/changes twice with same idempotency_key.
2. Assert: only one CR created, second request returns the existing one.

**Suite 2: Slack Bot Integration (mocked Slack API)**

Test 7: Bot receives mention -> creates CR via API:
1. Simulate Slack app_mention event with change description.
2. Assert: API called with correct workspace_id, request_text, slack_channel_id.
3. Assert: thread reply sent acknowledging the request.

Test 8: Unauthorized Slack user:
1. Simulate mention from non-allowed user.
2. Assert: "not authorized" reply sent, no CR created.

Test 9: Progress updates:
1. Create CR via mock Slack message.
2. As orchestrator progresses, assert thread replies are sent with correct status messages.
3. When deployed: assert interactive message with Approve/Reject buttons is sent.

Test 10: Approve via Slack button:
1. Create CR, wait for deployed.
2. Simulate Slack action (approve button click).
3. Assert: API approve endpoint called.
4. Assert: Slack message updated to show approved state.

**Suite 3: CLI Integration**

Test 11: `fuel-code changes` lists CRs:
1. Create 3 CRs with different statuses.
2. Run `fuel-code changes`.
3. Assert: output contains all 3 CRs.

Test 12: `fuel-code change <id> --approve`:
1. Create CR, wait for deployed.
2. Run `fuel-code change <id> --approve`.
3. Assert: CR merged.

**Suite 4: Data Integrity**

Test 13: Change events flow through event pipeline:
1. Create CR through full lifecycle.
2. Query events table.
3. Assert: all change.* events present with correct data.

Test 14: Session tracking:
1. Create CR that reaches 'implementing'.
2. Assert: A session record exists linked to the CR.
3. Assert: Session events (session.start, session.end) are captured.

Test 15: Remote env lifecycle:
1. Create CR.
2. Assert: remote_envs record created with change_request_id set.
3. After merge: assert remote env terminated.
4. Assert: lifecycle enforcer skips idle termination for change-request-linked envs.

### Test Runner Configuration

```toml
[test]
timeout = 60000  # 60s timeout for E2E tests (orchestration involves multiple async steps)
```

## Relevant Files
- `packages/e2e/change-requests.test.ts` (create)
- `packages/slack/src/__tests__/e2e/slack-integration.test.ts` (create)
- `packages/cli/src/__tests__/e2e/changes-commands.test.ts` (create)

## Success Criteria
1. Full happy path: create -> provision -> implement -> deploy -> approve -> merge works end-to-end.
2. Rejection flow cleans up remote env and branch.
3. Failure during any stage transitions to 'failed' with cleanup.
4. Retry after failure re-runs the workflow successfully.
5. Cancel stops in-progress work.
6. Idempotency key prevents duplicate change requests.
7. Slack bot correctly creates CRs, posts updates, and handles button clicks.
8. CLI commands display and manage change requests correctly.
9. All change.* events flow through the event pipeline to Postgres.
10. Sessions created by headless CC are tracked normally.
11. Remote envs linked to CRs are not idle-terminated by the lifecycle enforcer.
12. All tests use mocked external services (EC2, Slack) but real Postgres + Redis.
13. Tests are isolated and can run repeatedly without side effects.
