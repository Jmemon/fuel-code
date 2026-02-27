# Task 5: Retrofit AWS EC2+S3 Clients with Shared Retry + Atomic Tagging

## Parallel Group: B

## Dependencies: Task 1

## Description

Replace the inline retry logic in the EC2 client and the opaque AWS SDK retries in the S3 client with the shared `withRetry()` utility from Task 1. Additionally, move EC2 instance tagging from a separate `createTags` call to the atomic `TagSpecifications` parameter in `RunInstances`, eliminating the window where a newly-launched instance has no tags. Add a `fuel-code:created-at` tag with ISO timestamp to support grace-period enforcement in orphan detection (Task 9).

### EC2 Client Changes

The existing `FuelCodeEc2Client` (from Phase 5, Task 3) has inline retry logic:

```typescript
// BEFORE (Phase 5): inline 3-attempt retry in each method
async launchInstance(params: LaunchParams): Promise<LaunchResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // ... RunInstances call ...
    } catch (e) {
      if (isThrottling(e) && attempt < 2) { await sleep(1000 * 2**attempt); continue; }
      throw e;
    }
  }
}
```

Replace with:

```typescript
// AFTER (Phase 6): shared retry utility
import { withRetry, isRetryableAwsError } from '@fuel-code/shared';

async launchInstance(params: LaunchParams): Promise<LaunchResult> {
  return withRetry(
    async () => {
      const result = await this.ec2.send(new RunInstancesCommand({
        // ... all existing params ...
        TagSpecifications: [{
          ResourceType: 'instance',
          Tags: Object.entries(params.tags).map(([Key, Value]) => ({ Key, Value })),
        }],
      }));
      // ... parse result ...
    },
    {
      maxAttempts: 3,
      initialDelayMs: 1000,
      shouldRetry: isRetryableAwsError,
      onRetry: (err, attempt, delay) => {
        this.logger.warn({ err, attempt, delay }, 'EC2 API call failed, retrying');
      },
    },
  );
}
```

### Atomic Tagging via TagSpecifications

**What changes**: The `launchInstance` method no longer calls `createTags` separately. Instead, tags are passed in `TagSpecifications` within the `RunInstances` API call itself. This makes tagging atomic with launch — the instance is born with tags.

**New tag**: Add `'fuel-code:created-at': new Date().toISOString()` to the tags passed at launch. This timestamp enables orphan detection to enforce a grace period (Task 9) without querying instance launch time.

**LaunchParams update**: The existing `tags: Record<string, string>` field on `LaunchParams` already supports this. The provisioner (Phase 5, Task 8) already passes tags — no provisioner changes needed. The `fuel-code:created-at` tag is added inside `launchInstance` itself (not by the caller), since it's an infrastructure concern.

### Methods to Retrofit with withRetry

All EC2 client methods that make AWS API calls should use `withRetry`:

1. `launchInstance` — RunInstances (+ atomic TagSpecifications)
2. `terminateInstance` — TerminateInstances
3. `describeInstance` — DescribeInstances
4. `waitForRunning` — uses `describeInstance` internally (already retried), keep polling logic as-is
5. `ensureSecurityGroup` — CreateSecurityGroup / DescribeSecurityGroups
6. `authorizeIngress` — AuthorizeSecurityGroupIngress
7. `revokeIngress` — RevokeSecurityGroupIngress
8. `getLatestAmiId` — DescribeImages
9. `describeInstancesByTag` — DescribeInstances with tag filter
10. `createTags` — CreateTags (kept for non-launch tagging use cases, but no longer called during launch)

### S3 Client Changes

The existing S3 client (Phase 1+5) relies on AWS SDK's built-in retry mechanism, which is opaque and not configurable. Wrap S3 operations with `withRetry`:

```typescript
// packages/server/src/aws/s3-client.ts

import { withRetry, isRetryableAwsError } from '@fuel-code/shared';

// Disable AWS SDK built-in retries (set maxAttempts: 1 in S3Client config)
// Use withRetry for all operations instead

async putObject(bucket: string, key: string, body: Buffer | string): Promise<void> {
  return withRetry(
    () => this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body })),
    {
      maxAttempts: 3,
      shouldRetry: isRetryableAwsError,
      onRetry: (err, attempt, delay) => {
        this.logger.warn({ err, attempt, delay, key }, 'S3 put failed, retrying');
      },
    },
  );
}
```

Apply the same pattern to `getObject`, `deleteObject`, `headObject`, and any other S3 operations.

### Relevant Files

**Modify:**
- `packages/server/src/aws/ec2-client.ts` — replace inline retry with `withRetry`, add TagSpecifications to `launchInstance`, add `fuel-code:created-at` tag
- `packages/server/src/aws/s3-client.ts` — disable SDK retries, wrap operations with `withRetry`
- `packages/server/src/aws/ec2-mock.ts` — update mock to verify TagSpecifications structure if needed

**No new files created** — this task modifies existing files only.

### Tests

`ec2-client.test.ts` updates (bun:test):

1. `launchInstance` uses `TagSpecifications` in the RunInstances command (not separate createTags call).
2. `launchInstance` includes `fuel-code:created-at` tag with ISO timestamp in TagSpecifications.
3. `launchInstance` retries on `ThrottlingException` using shared retry (verify onRetry callback called).
4. `launchInstance` retries on `RequestLimitExceeded`, succeeds on second attempt.
5. `launchInstance` does NOT retry on `ValidationException` (not retryable).
6. `terminateInstance` retries on transient errors.
7. `describeInstance` retries on transient errors.
8. `describeInstancesByTag` retries on transient errors.
9. `ensureSecurityGroup` retries on transient errors.
10. All methods throw the original AWS error after retries exhausted (error not wrapped).

`s3-client.test.ts` updates (bun:test):

11. `putObject` retries on transient S3 errors (e.g., `InternalError`, 500).
12. `getObject` retries on transient S3 errors.
13. `deleteObject` retries on transient S3 errors.
14. S3 operations do NOT retry on `AccessDenied` or `NoSuchKey`.
15. AWS SDK built-in retries are disabled (maxAttempts: 1 in S3Client config).

### Success Criteria

1. All EC2 API calls use `withRetry` with `isRetryableAwsError` predicate — no inline retry loops remain.
2. All S3 API calls use `withRetry` with `isRetryableAwsError` predicate — SDK built-in retries disabled.
3. `launchInstance` uses `TagSpecifications` for atomic tagging — no separate `createTags` call during launch.
4. Every launched instance has a `fuel-code:created-at` ISO timestamp tag from birth.
5. `onRetry` callbacks log retries at warn level via pino.
6. Non-retryable errors (validation, access denied) fail immediately without retry.
7. The `createTags` method still exists on the interface for non-launch use cases.
8. All existing tests still pass — behavior is preserved, only retry mechanism changed.
