# Task 13: `fuel-code remote ls` + `fuel-code remote down`

## Parallel Group: D

## Dependencies: Task 6

## Description

Implement the list and terminate commands for remote environments, plus a `remote status` detail command.

### Command: `fuel-code remote ls`

```
$ fuel-code remote ls

ID        WORKSPACE     STATUS   TYPE       IP              REGION      UPTIME   COST    IDLE
01JMF3..  fuel-code     ready    t3.xlarge  54.123.45.67    us-east-1   2h 15m   $0.37   12m
01JMF4..  api-service   active   t3.large   54.234.56.78    us-east-1   45m      $0.06   0m

2 remote environments ($0.43 total)
```

Implementation:
1. Call `apiClient.getRemoteEnvs()` (default: exclude terminated).
2. Display as a formatted table using the existing output formatting utils from Phase 4.
3. Columns: ID (first 8 chars), workspace display_name, status, instance_type, public_ip, region, uptime, estimated cost, idle time.
4. Color coding: `ready` = green, `active` = bright green, `idle` = yellow, `provisioning` = dim, `error` = red, `terminated` = dim.
5. Footer: count of environments and total estimated cost.
6. If no active environments: print "No active remote environments." and exit 0.

Options:
- `--all` → includes terminated and error environments.
- `--json` → outputs JSON array.
- `--workspace <name>` → filter by workspace.

### Command: `fuel-code remote down <id>`

```
$ fuel-code remote down 01JMF3

Terminating remote environment 01JMF3ABC...
  Workspace: fuel-code
  Instance:  i-0abc123... (t3.xlarge, us-east-1)
  Uptime:    2h 15m
  Cost:      ~$0.37

Terminate? [y/N] y

Terminated. EC2 instance shutting down.
```

Implementation:
1. Resolve remote env by ID (prefix matching, same as `remote ssh`).
2. Show env details and prompt: "Terminate? [y/N]" (default no for safety).
3. Call `apiClient.terminateRemoteEnv(id, 'manual')`.
4. Poll `GET /api/remote/:id` until status is `terminated` (or timeout).
5. Print "Terminated. EC2 instance shutting down."
6. Clean up local SSH key: delete `~/.fuel-code/ssh-keys/{id}/`.

Options:
- `--force` → skips confirmation prompt.
- `--all` → terminates ALL active environments:
  1. List all non-terminated environments.
  2. Show them in a compact table.
  3. Prompt: "Terminate all N environments? [y/N]" (`--force` skips).
  4. Terminate each, showing progress.
  5. Clean up all local SSH keys.

### Command: `fuel-code remote status <id>`

A detail view for a single environment:

```
$ fuel-code remote status 01JMF3

Remote Environment: 01JMF3ABC...
  Workspace:  fuel-code (github.com/user/fuel-code)
  Status:     ready (since 2h 15m ago)
  Instance:   i-0abc123... (t3.xlarge)
  Region:     us-east-1
  IP:         54.123.45.67
  Cost:       ~$0.37 ($0.166/hr)
  TTL:        8h (auto-terminate at 6:23 PM)
  Idle:       12m (timeout at 60m)

  Blueprint:  node:22 / bun / 50GB
  Branch:     main

  Connect:    fuel-code remote ssh 01JMF3
  Terminate:  fuel-code remote down 01JMF3
```

Implementation:
1. Resolve by ID or prefix.
2. Call `apiClient.getRemoteEnv(id)`.
3. Display all fields with formatting.
4. `--json` flag for machine-readable output.

### CLI Registration

```typescript
// In packages/cli/src/index.ts or commands registration file:
const remote = program.command('remote').description('Manage remote dev environments');

remote
  .command('ls')
  .description('List remote environments')
  .option('--all', 'Include terminated environments')
  .option('--workspace <name>', 'Filter by workspace')
  .option('--json', 'Output as JSON')
  .action(remoteLsAction);

remote
  .command('down [id]')
  .description('Terminate a remote environment')
  .option('--force', 'Skip confirmation')
  .option('--all', 'Terminate all environments')
  .action(remoteDownAction);

remote
  .command('status <id>')
  .description('Show detailed status for a remote environment')
  .option('--json', 'Output as JSON')
  .action(remoteStatusAction);
```

### Uptime and Cost Calculation

```typescript
function computeUptime(env: RemoteEnv): number {
  const start = new Date(env.provisioned_at).getTime();
  const end = env.terminated_at
    ? new Date(env.terminated_at).getTime()
    : Date.now();
  return end - start;
}

function computeCost(env: RemoteEnv): number {
  const uptimeHours = computeUptime(env) / 3_600_000;
  return uptimeHours * (env.cost_per_hour_usd || 0);
}
```

### Local SSH Key Cleanup

On `remote down`, delete the local key cache:

```typescript
const keyDir = path.join(os.homedir(), '.fuel-code', 'ssh-keys', remoteEnvId);
await fs.rm(keyDir, { recursive: true, force: true });
```

### Relevant Files

**Create:**
- `packages/cli/src/commands/remote-ls.ts`
- `packages/cli/src/commands/remote-down.ts`
- `packages/cli/src/commands/__tests__/remote-ls.test.ts`
- `packages/cli/src/commands/__tests__/remote-down.test.ts`

**Modify:**
- `packages/cli/src/index.ts` — register `remote ls`, `remote down`, `remote status` commands

### Tests

`remote-ls.test.ts` (bun:test, mocked ApiClient):

1. Lists non-terminated environments in table format with correct columns.
2. `--all` includes terminated and error environments.
3. `--json` outputs JSON array.
4. `--workspace fuel-code` filters by workspace.
5. No active environments → "No active remote environments." message.
6. Status colors: ready=green, active=bright green, idle=yellow, error=red.
7. Uptime calculated correctly from provisioned_at.
8. Cost calculated as uptime_hours * cost_per_hour.
9. Footer shows count and total cost.
10. `remote status <id>` shows detailed single-environment view.
11. `remote status --json` outputs full JSON.

`remote-down.test.ts` (bun:test, mocked ApiClient):

1. With valid ID → shows details, asks confirmation, terminates on "y".
2. Confirmation declined ("n") → does not terminate, exits 0.
3. `--force` → skips confirmation.
4. `--all` → lists all, asks confirmation, terminates all.
5. `--all --force` → terminates all without confirmation.
6. Unknown ID → "Remote environment not found."
7. Already terminated → "Environment already terminated."
8. Local SSH key directory deleted after termination.
9. Prefix matching works for IDs.
10. `remote down` with no ID and one active env → auto-selects.

### Success Criteria

1. `fuel-code remote ls` lists active environments with accurate stats.
2. Table includes workspace name, status, IP, uptime, cost, idle time.
3. Status is color-coded for quick visual scanning.
4. `fuel-code remote down <id>` terminates with confirmation prompt (default no).
5. `--force` skips confirmation for scripting.
6. `--all` terminates all environments with safety confirmation.
7. `fuel-code remote status <id>` shows detailed info including connect/terminate commands.
8. Local SSH keys cleaned up on termination.
9. ID prefix matching works on all commands.
10. `--json` works on ls and status.
