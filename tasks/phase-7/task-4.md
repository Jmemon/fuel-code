# Task 4: Headless CC Invocation over SSH

## Parallel Group: C

## Dependencies: Task 2

## Description

Build the module that SSHs into a remote environment and runs Claude Code in headless mode (`claude --task "<description>"`). This is the core implementation step of the change request workflow — after provisioning, the orchestrator calls this module to have CC actually implement the requested change.

### Files to Create

**`packages/server/src/services/headless-cc.ts`**:

> **Architecture note:** All I/O is injected via the `SshExecutor` interface. The `SshExecutor` interface is defined in `packages/core/src/interfaces/ssh-executor.ts` and the implementation (using `Bun.spawn` + system `ssh` binary) lives in `packages/server/src/services/ssh-executor.ts`. This keeps `packages/core/` free of I/O.

```typescript
// SshExecutor interface — defined in packages/core/src/interfaces/ssh-executor.ts
export interface SshExecutor {
  exec(params: {
    keyPath: string;
    host: string;
    user: string;
    port: number;
    command: string;
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface HeadlessCCConfig {
  // SSH connection params
  sshKeyPath: string;          // Path to private key (local temp file)
  remoteHost: string;          // EC2 public IP
  remoteUser: string;          // Default: 'ubuntu'
  sshPort: number;             // Default: 22

  // CC execution params
  workspacePath: string;       // Path to repo on remote (e.g., /home/ubuntu/workspace)
  requestText: string;         // The change description to pass to CC
  branchName: string;          // Branch to create before running CC

  // Timeouts
  sshTimeoutMs: number;        // SSH connection timeout (default: 30_000)
  ccTimeoutMs: number;         // CC execution timeout (default: 600_000 = 10 min)

  // Injected dependencies
  sshExecutor: SshExecutor;    // Injected at call site from packages/server/
  logger: pino.Logger;
}

export interface HeadlessCCResult {
  success: boolean;
  exitCode: number;
  sessionId: string | null;    // Extracted from CC output if available
  stdout: string;              // Last 10KB of stdout (for diagnostics)
  stderr: string;              // Last 10KB of stderr
  durationMs: number;
}

// Run Claude Code headlessly on a remote environment via SSH.
// Steps:
// 1. SSH into the remote
// 2. cd to workspace, create and checkout branch
// 3. Run `claude --task "<request_text>"`
// 4. If successful, stage all changes, commit, and push the branch
// 5. Return result with exit code, output, and session ID
export async function runHeadlessCC(config: HeadlessCCConfig): Promise<HeadlessCCResult>;
```

### SSH Command Execution

Use `Bun.spawn` to shell out to the system `ssh` binary (same approach as Phase 5's SSH key generation — no ssh2 npm package):

```typescript
// Execute a command on the remote via SSH
async function sshExec(params: {
  keyPath: string;
  host: string;
  user: string;
  port: number;
  command: string;
  timeoutMs: number;
  logger: pino.Logger;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([
    'ssh',
    '-i', params.keyPath,
    '-o', 'StrictHostKeyChecking=no',      // First-time connection to new EC2
    '-o', 'UserKnownHostsFile=/dev/null',   // Don't pollute known_hosts
    '-o', `ConnectTimeout=${Math.ceil(params.timeoutMs / 1000)}`,
    '-o', 'BatchMode=yes',                  // No interactive prompts
    '-p', String(params.port),
    `${params.user}@${params.host}`,
    params.command,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Read output with size limits (last 10KB to avoid memory issues)
  // Use a timeout wrapper to kill the process if it exceeds ccTimeoutMs
  // IMPORTANT: Read streams concurrently with proc.exited to avoid deadlock.
  // Sequential reads after proc.exited can hang if the OS pipe buffer fills up
  // and the child process blocks on write before exiting.
  const timer = setTimeout(() => proc.kill(), params.timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readStream(proc.stdout, 10240),   // Last 10KB
    readStream(proc.stderr, 10240),
  ]);
  clearTimeout(timer);

  return { exitCode, stdout, stderr };
}
```

### Execution Flow

```
runHeadlessCC(config):

1. VERIFY SSH connectivity:
   sshExec('echo "connection test"')
   If fails: return { success: false, exitCode: -1, stderr: 'SSH connection failed' }

2. CREATE branch on remote:
   sshExec(`cd ${workspacePath} && git checkout -b ${branchName}`)
   If fails: return { success: false, ... }

3. RUN Claude Code:
   sshExec(`cd ${workspacePath} && claude --task "${escapedRequestText}"`)
   - Escape the request text for shell safety (single quotes + escape internal quotes)
   - This is the long-running step — may take minutes
   - CC writes to stdout/stderr as it works
   - Extract session ID from CC output if present (CC logs session ID on start)

4. CHECK for changes:
   sshExec(`cd ${workspacePath} && git status --porcelain`)
   If no changes: return { success: false, stderr: 'CC made no changes' }

5. COMMIT and PUSH:
   > **Note:** Do not use `git add -A` — it stages temp files, logs, .env, and build artifacts. Let CC handle its own commits via hooks, or use `git add -A -- ':!.env*' ':!node_modules' ':!*.log'` with a proper .gitignore on the remote. The remote blueprint should include a .gitignore; rely on it.
   sshExec(`cd ${workspacePath} && git add . && git commit -m "feat: ${sanitizedRequestText}" && git push origin ${branchName}`)
   If fails: return { success: false, ... }

6. RETURN success:
   return { success: true, exitCode: 0, sessionId, stdout, stderr, durationMs }
```

### Shell Escaping

```typescript
// Safely escape a string for use in a shell command (single-quote wrapping)
function shellEscape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
```

### Session ID Extraction

```typescript
// Claude Code outputs session ID on startup, e.g., "Session: 01JMF3..."
// Extract it from stdout for linking the CC session to the change request.
function extractSessionId(stdout: string): string | null {
  const match = stdout.match(/Session:\s+([0-9A-Z]{26})/);
  return match ? match[1] : null;
}
```

### Tests

**`packages/server/src/services/__tests__/headless-cc.test.ts`** (unit tests with mocked SshExecutor):

Use a mock `sshExec` that records commands and returns canned responses.

1. Happy path: SSH connects, branch created, CC runs, changes committed, pushed. Returns success with session ID.
2. SSH connection failure: returns { success: false } immediately.
3. CC exits with non-zero: returns { success: false, exitCode, stderr }.
4. CC makes no changes (empty git status): returns { success: false, stderr: 'CC made no changes' }.
5. Git push fails: returns { success: false } with push error.
6. CC timeout: process killed after timeout, returns { success: false }.
7. Request text with special characters (quotes, newlines) is properly escaped.
8. Long stdout/stderr is truncated to 10KB.
9. Session ID extracted from CC output.
10. Session ID not found in output: returns null (not an error).
11. Branch name is used as-is (generated by orchestrator).
12. Commit message includes sanitized request text.

## Relevant Files
- `packages/core/src/interfaces/ssh-executor.ts` (create — SshExecutor interface)
- `packages/server/src/services/headless-cc.ts` (create)
- `packages/server/src/services/ssh-executor.ts` (create — SshExecutor implementation using Bun.spawn)
- `packages/server/src/services/__tests__/headless-cc.test.ts` (create)

## Success Criteria
1. SSH connection uses system `ssh` binary via `Bun.spawn` (no npm ssh packages).
2. Connection uses `-o StrictHostKeyChecking=no` for first-time EC2 connections.
3. Branch is created before CC runs.
4. CC is invoked with `claude --task "<description>"` in headless mode.
5. Request text is properly shell-escaped to prevent injection.
6. Changes are committed and pushed to the branch.
7. If CC makes no changes, the result is { success: false }.
8. Timeout kills the SSH process if CC hangs.
9. stdout/stderr are size-limited to prevent memory issues.
10. Session ID is extracted from CC output when available.
11. All errors return a result object (never throws).
