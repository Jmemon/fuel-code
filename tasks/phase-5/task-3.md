# Task 3: AWS EC2 Client Wrapper with Mock Boundary

## Parallel Group: A

## Dependencies: None

## Description

Create an EC2 client wrapper that defines a clean `Ec2Operations` interface and provides both a real AWS SDK implementation and a mock implementation for testing. All server-side code that touches EC2 depends on this interface, never on the AWS SDK directly. This is the foundation that makes every subsequent task testable without AWS credentials.

### Interface

```typescript
// packages/server/src/aws/ec2-client.ts

export interface LaunchParams {
  instanceType: string;
  amiId: string;
  securityGroupId: string;
  userData: string;        // base64-encoded user-data script
  diskGb: number;
  tags: Record<string, string>;
}

export interface LaunchResult {
  instanceId: string;
  launchTime: Date;
}

export interface InstanceDescription {
  instanceId: string;
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';
  publicIp: string | null;
  launchTime: Date;
  instanceType: string;
}

export interface SecurityGroupParams {
  name: string;
  description: string;
  vpcId?: string;
  tags: Record<string, string>;
}

// The core interface — all server code depends on this, never on @aws-sdk/client-ec2 directly
export interface Ec2Operations {
  // Launch a single EC2 instance. Retries on transient errors (3 attempts, exponential backoff).
  launchInstance(params: LaunchParams): Promise<LaunchResult>;

  // Terminate an EC2 instance. Idempotent — does not error if already terminated.
  terminateInstance(instanceId: string): Promise<void>;

  // Get instance details. Returns null if instance not found.
  describeInstance(instanceId: string): Promise<InstanceDescription | null>;

  // Poll describeInstance every 5s until state is 'running' or timeout (default 120s).
  waitForRunning(instanceId: string, timeoutMs?: number): Promise<InstanceDescription>;

  // Create or get the fuel-code security group. Returns security group ID.
  // Idempotent: returns existing group if already created.
  ensureSecurityGroup(vpcId?: string): Promise<string>;

  // Add SSH ingress rule (TCP port 22 from ip/32). Idempotent — ignores duplicate.
  authorizeIngress(sgId: string, ip: string): Promise<void>;

  // Add a generic ingress rule for any port/CIDR. Idempotent — ignores duplicate.
  authorizeSecurityGroupIngress(params: { groupId: string; port: number; cidr: string }): Promise<void>;

  // Remove SSH ingress rule. Idempotent — ignores missing rule.
  revokeIngress(sgId: string, ip: string): Promise<void>;

  // Look up latest Amazon Linux 2023 AMI for configured region. Caches for 24h.
  getLatestAmiId(): Promise<string>;

  // Get the caller's public IP via https://checkip.amazonaws.com
  getCallerPublicIp(): Promise<string>;

  // Find all EC2 instances with a specific tag (for orphan detection)
  describeInstancesByTag(tagKey: string, tagValue: string): Promise<InstanceDescription[]>;

  // Apply tags to any EC2 resource
  createTags(resourceId: string, tags: Record<string, string>): Promise<void>;
}
```

### Real Implementation

```typescript
// packages/server/src/aws/ec2-client.ts

export class FuelCodeEc2Client implements Ec2Operations {
  constructor(opts: { region: string; logger: pino.Logger }) {
    // Creates @aws-sdk/client-ec2 EC2Client with region
    // Uses default credential chain (env vars, IAM role, AWS profile)
  }
  // ... implements all methods
}
```

Key implementation details:
- **Retry logic**: `ThrottlingException`, `RequestLimitExceeded`, `InternalError` → retry with exponential backoff (1s, 2s, 4s). Max 3 retries.
- **Error mapping**: All AWS errors are caught and re-thrown as `AwsError extends FuelCodeError` with the original error as `cause`.
- **Logging**: debug level for API calls, info level for results, error level for failures.
- **AMI lookup**: `DescribeImages` with filters `owner-alias=amazon`, `name=al2023-ami-*-x86_64`, sort by creation date, take latest. Cache result in-memory for 24 hours. AMI cache TTL is configurable via `ami_cache_ttl_ms` config option with a default of 24 hours.
- **Security group**: Name `fuel-code-remote`, description `SSH access for fuel-code remote dev environments`, tagged `fuel-code:managed=true`.
- **waitForRunning**: Poll every 5 seconds. Throw `TimeoutError` if not running within timeout.

### Mock Implementation

```typescript
// packages/server/src/aws/ec2-mock.ts

export interface MockEc2Call {
  method: string;
  args: unknown[];
  timestamp: number;
}

export class MockEc2Client implements Ec2Operations {
  // Record of all calls made
  calls: MockEc2Call[] = [];

  // Configurable responses per method
  private responses: Map<string, unknown[]> = new Map();

  // Configurable failures: set a method to throw on next call
  private failures: Map<string, Error> = new Map();

  // Configure what a method returns on next call(s)
  mockResponse(method: string, ...responses: unknown[]): void;

  // Configure a method to throw on next call
  mockFailure(method: string, error: Error): void;

  // Reset all mocks
  reset(): void;
}
```

The mock records all calls, supports queueing multiple responses, and can inject failures at specific operations for testing cleanup/rollback logic.

### Tag Constants

```typescript
// packages/server/src/aws/ec2-tags.ts

export const EC2_TAGS = {
  MANAGED: { key: 'fuel-code:managed', value: 'true' },
  REMOTE_ENV_ID: (id: string) => ({ key: 'fuel-code:remote-env-id', value: id }),
  WORKSPACE: (canonicalId: string) => ({ key: 'fuel-code:workspace', value: canonicalId }),
  NAME: (remoteEnvId: string) => ({ key: 'Name', value: `fuel-code-remote-${remoteEnvId}` }),
} as const;
```

### Relevant Files

**Create:**
- `packages/server/src/aws/ec2-client.ts` (interface + real implementation)
- `packages/server/src/aws/ec2-mock.ts` (mock implementation)
- `packages/server/src/aws/ec2-tags.ts` (tag constants)
- `packages/server/src/aws/__tests__/ec2-client.test.ts`

**Modify:**
- `packages/server/src/aws/index.ts` — export ec2 modules
- `packages/server/package.json` — add `@aws-sdk/client-ec2` via `bun add @aws-sdk/client-ec2`

### Tests

`ec2-client.test.ts` (bun:test, mocking AWS SDK):

1. `launchInstance` sends correct `RunInstances` command with all params (instance type, AMI, user-data, SG, disk, tags).
2. `launchInstance` retries on `RequestLimitExceeded`, succeeds on second attempt.
3. `launchInstance` throws `AwsError` after 3 failed retries.
4. `terminateInstance` sends `TerminateInstances` command.
5. `terminateInstance` is idempotent — no error if already terminated.
6. `describeInstance` returns typed `InstanceDescription` with all fields.
7. `describeInstance` returns null for unknown instance.
8. `waitForRunning` polls until state is `running`, returns instance info with public IP.
9. `waitForRunning` throws `TimeoutError` if instance stays in `pending` past timeout.
10. `ensureSecurityGroup` creates the group if it does not exist, returns ID.
11. `ensureSecurityGroup` returns existing group ID on subsequent calls (idempotent).
12. `authorizeIngress` adds /32 CIDR rule for TCP port 22.
13. `authorizeIngress` ignores `InvalidPermission.Duplicate` error.
14. `revokeIngress` removes the rule, ignores `InvalidPermission.NotFound`.
15. `getLatestAmiId` returns an AMI ID matching `al2023-ami-*-x86_64`.
16. `getLatestAmiId` caches result (second call does not hit AWS).
17. `getCallerPublicIp` returns a valid IPv4 address string.
18. `describeInstancesByTag` returns instances matching the tag filter.
19. `createTags` applies tags to any resource ID.
20. MockEc2Client records all calls and supports injectable failures.
21. MockEc2Client `mockFailure` causes the specified method to throw.
22. All AWS errors are wrapped in `AwsError` with original error as `cause`.

### Success Criteria

1. `Ec2Operations` interface defined with all 12 methods.
2. Real implementation wraps `@aws-sdk/client-ec2` v3 with error handling and retry logic.
3. Mock implementation records all calls, supports configurable responses and injectable failures.
4. Retry logic covers `ThrottlingException`, `RequestLimitExceeded`, `InternalError`.
5. `ensureSecurityGroup` is idempotent — creates once, returns existing on subsequent calls.
6. Security group tagged with `fuel-code:managed=true`.
7. `waitForRunning` polls with 5s interval and throws on timeout.
8. `getLatestAmiId` returns a valid AMI ID and caches the result for 24h.
9. Tag constants centralized for consistent tagging across provisioner, lifecycle enforcer, and orphan detection.
10. `@aws-sdk/client-ec2` added to `packages/server` via `bun add`.
