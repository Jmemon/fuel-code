# Task 11: `fuel-code remote up` + Graceful Abort

## Parallel Group: D

## Dependencies: Tasks 8, 10

## Description

Implement the `fuel-code remote up` command — the main user-facing command for provisioning a remote dev environment. It loads or detects a blueprint, calls the server to create the remote env record and trigger provisioning, shows progress while waiting for readiness, handles Ctrl-C gracefully via an abort handler, and displays connection info on success.

### Command Flow

```
$ fuel-code remote up

1. RESOLVE WORKSPACE
   ├── Get git remote URL and branch from CWD
   └── Compute canonical workspace ID

2. LOAD OR DETECT BLUEPRINT
   ├── Check for .fuel-code/env.yaml
   │   ├── If exists: read and validate
   │   └── If missing: run blueprint detection, show result, ask to proceed
   ├── --blueprint <path> flag overrides with specific file
   └── --instance-type, --region, --ttl, --idle-timeout flags override blueprint values

3. CONFIRM
   ├── Show: blueprint summary, instance type, region, estimated cost/hr, TTL, idle timeout
   ├── Prompt: "Provision? [Y/n]" (--yes skips prompt)
   └── Freeze blueprint via freezeBlueprint()

4. PROVISION
   ├── POST /api/remote with { workspace_id, blueprint, repo_url, repo_branch, ttl_minutes, idle_timeout_minutes }
   └── Receive: { id, status: "provisioning" }

5. WAIT FOR READY (wrapped in abort handler)
   ├── Poll GET /api/remote/:id every 3 seconds
   ├── Or subscribe to WebSocket remote.update if WS is connected
   ├── Show progress with spinner and elapsed time
   │   ├── "Provisioning EC2 instance..."
   │   ├── "Instance running, setting up environment..."
   │   ├── "Environment ready!"
   │   └── "Error: <message>"
   └── Timeout after 10 minutes → suggest checking `fuel-code remote ls`

6. ON READY
   ├── Download SSH key via GET /api/remote/:id/ssh-key
   ├── Save to ~/.fuel-code/ssh-keys/{id}/id_ed25519 with chmod 600
   ├── Display connection info:
   │   │  Remote environment ready!
   │   │  ID:        01JMF3ABC...
   │   │  Instance:  i-0abc123... (t3.xlarge)
   │   │  IP:        54.123.45.67
   │   │  Region:    us-east-1
   │   │  Cost:      ~$0.166/hr
   │   │  TTL:       8h (auto-terminate at 6:23 PM)
   │   │  Idle:      60m timeout
   │   │
   │   │  Connect: fuel-code remote ssh 01JMF3ABC
   └── If --ssh flag: auto-connect via `fuel-code remote ssh <id>`
```

### Graceful Abort Handler

```typescript
// packages/cli/src/lib/abort-handler.ts

// Wraps an async operation with SIGINT handling.
// On Ctrl-C: calls terminate endpoint, prints cleanup status, exits 130.
export async function withAbortHandler<T>(
  remoteEnvId: string,
  apiClient: ApiClient,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T>;
```

Behavior:
- Registers SIGINT handler before provisioning begins.
- On first SIGINT: prints "Aborting... cleaning up remote environment {id}", calls `POST /api/remote/:id/terminate`, prints "Cleaned up." and exits with code 130.
- If terminate call fails: prints "Warning: cleanup failed. Run `fuel-code remote down {id}` to clean up manually." and exits with code 1.
- On second SIGINT (during cleanup): forces immediate exit with warning.
- Restores original SIGINT handler after operation completes (success or abort).
- The wrapped function receives an `AbortSignal` it can check to bail out of polling early.

### CLI Options

```typescript
remote
  .command('up')
  .description('Provision a remote dev environment')
  .option('--repo <url>', 'Git repo URL (default: current directory)')
  .option('--branch <name>', 'Git branch (default: current branch)')
  .option('--blueprint <path>', 'Path to env.yaml (default: .fuel-code/env.yaml)')
  .option('--instance-type <type>', 'Override instance type from blueprint')
  .option('--region <region>', 'Override region from blueprint')
  .option('--ttl <minutes>', 'Time-to-live in minutes (default: 480)', parseInt)
  .option('--idle-timeout <minutes>', 'Idle timeout in minutes (default: 60)', parseInt)
  .option('--yes', 'Skip confirmation prompt')
  .option('--ssh', 'Auto-connect via SSH after provisioning')
  .option('--json', 'Output structured JSON')
  .action(remoteUpAction);
```

### Cost Estimate Lookup

A simple map from instance type to hourly cost (US East prices, approximate):

```typescript
const COST_PER_HOUR: Record<string, number> = {
  't3.medium':  0.0416,
  't3.large':   0.0832,
  't3.xlarge':  0.1664,
  't3.2xlarge': 0.3328,
  'm5.xlarge':  0.192,
  'm5.2xlarge': 0.384,
  'c5.xlarge':  0.17,
  'c5.2xlarge': 0.34,
  'g4dn.xlarge': 0.526,
};
```

### Relevant Files

**Create:**
- `packages/cli/src/commands/remote-up.ts`
- `packages/cli/src/lib/abort-handler.ts`
- `packages/cli/src/commands/__tests__/remote-up.test.ts`
- `packages/cli/src/lib/__tests__/abort-handler.test.ts`

**Modify:**
- `packages/cli/src/index.ts` — register `remote up` command

### Tests

`remote-up.test.ts` (bun:test, mocked ApiClient):

1. With existing env.yaml → loads blueprint, shows summary, calls POST /api/remote.
2. Without env.yaml → runs detection, shows result, asks to proceed.
3. `--yes` → skips confirmation prompt.
4. `--instance-type t3.medium` → overrides blueprint's instance type.
5. `--region eu-west-1` → overrides blueprint's region.
6. `--json` → outputs structured JSON, no interactive elements.
7. `--dry-run` or `--blueprint <path>` → uses specified blueprint file.
8. Polling shows progress with elapsed time.
9. On ready status → displays connection info with ID, IP, cost, TTL.
10. On error status → displays error message, exit 1.
11. On timeout (10 min) → displays timeout message, suggests `remote ls`.
12. Cost estimate displayed for known instance types.
13. SSH key downloaded and saved on success.

`abort-handler.test.ts` (bun:test):

1. Normal completion → handler removed cleanly, original SIGINT restored.
2. SIGINT triggers → terminate API called, cleanup message printed, exit 130.
3. Terminate API fails → manual cleanup message printed, exit 1.
4. AbortSignal is set when SIGINT fires.
5. Second SIGINT during cleanup → forces immediate exit.

### Success Criteria

1. `fuel-code remote up` provisions a complete remote environment from blueprint.
2. User sees progress with spinner and elapsed time during provisioning.
3. On success: connection info displayed (ID, IP, cost, TTL, idle timeout).
4. On failure: clear error message with the specific failure.
5. Blueprint overrides (--instance-type, --region, --ttl, --idle-timeout) work.
6. Ctrl-C during provisioning triggers server-side cleanup.
7. SSH key is downloaded and cached locally on success.
8. `--ssh` flag auto-connects after provisioning.
9. `--json` flag outputs structured result.
10. Exit code 0 on success, 1 on failure, 130 on abort.
