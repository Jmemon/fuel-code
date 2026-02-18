# Task 10: Graceful Ctrl-C Hardening for All Long Operations

## Parallel Group: D

## Dependencies: Task 6

## Description

Replace the existing `withAbortHandler()` utility (Phase 5, used only by `remote up`) with a general-purpose `ShutdownManager` that provides a LIFO cleanup action stack. Commands push cleanup functions onto the stack when they acquire resources (e.g., "terminate EC2 instance", "release drain lock", "stop archival") and pop them on successful completion. On SIGINT, the stack unwinds in reverse order. On double SIGINT, force exit. The shutdown manager is wired into all long-running CLI commands: `remote up`, `remote down`, `drain`, `backfill`, and `session archive`.

### Interface

```typescript
// packages/cli/src/lib/shutdown-manager.ts

export interface CleanupAction {
  // Human-readable description (logged during cleanup)
  label: string;
  // Async cleanup function
  fn: () => Promise<void>;
}

export interface ShutdownManager {
  // Push a cleanup action onto the stack. Returns a dispose function
  // that removes the action (call on successful completion).
  push(action: CleanupAction): () => void;

  // Get the AbortSignal that fires on first SIGINT.
  // Pass this to withRetry(), fetch(), etc. for cooperative cancellation.
  readonly signal: AbortSignal;

  // Whether shutdown has been requested (first SIGINT received)
  readonly isShuttingDown: boolean;

  // Start listening for SIGINT. Call once at CLI startup.
  install(): void;

  // Stop listening for SIGINT and clear the cleanup stack.
  uninstall(): void;
}

export function createShutdownManager(options?: {
  // Logger for cleanup status messages
  logger?: pino.Logger;
  // Stream for user-facing messages (default: process.stderr)
  stream?: NodeJS.WritableStream;
}): ShutdownManager;
```

### Behavior

**First SIGINT**:
1. Set `isShuttingDown = true`.
2. Abort the `AbortController` (fires the `signal`).
3. Print: `"\nShutting down gracefully... (press Ctrl-C again to force quit)"`
4. Unwind the cleanup stack in LIFO order:
   - For each action, print: `"  Cleaning up: {label}..."` then call `fn()`.
   - If `fn()` throws, log the error and continue to the next action.
   - After all actions: print `"Cleanup complete."` and exit with code 130.

**Second SIGINT** (during cleanup):
1. Print: `"\nForce quitting."`
2. `process.exit(1)` immediately.

**Normal completion** (no SIGINT):
- Command pushes cleanup actions as it acquires resources.
- As each resource is properly released, the command calls the dispose function returned by `push()`.
- When the command finishes, the stack is empty (or has only non-critical entries).
- `uninstall()` is called to remove the SIGINT listener.

### Usage Example: remote up

```typescript
// packages/cli/src/commands/remote-up.ts

async function remoteUp(shutdownManager: ShutdownManager) {
  const apiClient = new ApiClient({ signal: shutdownManager.signal, ... });

  // Start provisioning
  const env = await apiClient.provisionRemote(blueprint);

  // Push cleanup: if Ctrl-C, terminate the environment
  const disposeTerminate = shutdownManager.push({
    label: `Terminate remote environment ${env.id}`,
    fn: async () => {
      await apiClient.terminateRemoteEnv(env.id).catch(() => {
        // Cleanup failure — log manual command
        console.error(`  Manual cleanup: fuel-code remote down ${env.id}`);
      });
    },
  });

  // Poll for ready...
  await pollForReady(apiClient, env.id, shutdownManager.signal);

  // Download SSH key
  await downloadSshKey(apiClient, env.id);

  // Remove cleanup action — provisioning succeeded, user now owns the env
  disposeTerminate();

  console.log(`Remote environment ${env.id} is ready.`);
}
```

### Usage Example: drain

```typescript
// packages/cli/src/commands/drain.ts

async function drain(shutdownManager: ShutdownManager) {
  // NOTE: Acquire the lock BEFORE pushing cleanup, so we don't release
  // a lock we never acquired if Ctrl-C fires between push and acquire.
  await acquireDrainLock();

  const lockDispose = shutdownManager.push({
    label: 'Release drain lock',
    fn: async () => { await releaseDrainLock(); },
  });

  try {
    await drainWithBackoff(apiClient, queue, logger);
  } finally {
    await releaseDrainLock();
    lockDispose();
  }
}
```

### Migration from withAbortHandler

The existing `packages/cli/src/lib/abort-handler.ts` with `withAbortHandler()` is replaced by the shutdown manager. All references to `withAbortHandler` are removed. The behavior difference:

- `withAbortHandler` was a one-shot wrapper: you passed a single cleanup function.
- `ShutdownManager` supports multiple stacked cleanup actions and is reusable across commands.
- `ShutdownManager` provides an `AbortSignal` for cooperative cancellation.
- `ShutdownManager` is instantiated once at CLI startup and passed to commands.

### Wiring into CLI Entry Point

```typescript
// packages/cli/src/index.ts

const shutdownManager = createShutdownManager({ logger });
shutdownManager.install();

// Pass to commands that need it
program.command('remote up').action(async () => {
  await remoteUp(shutdownManager);
});

program.command('drain').action(async () => {
  await drain(shutdownManager);
});

// ... other long commands ...

// On normal exit
process.on('exit', () => { shutdownManager.uninstall(); });
```

### Relevant Files

**Create:**
- `packages/cli/src/lib/shutdown-manager.ts`
- `packages/cli/src/lib/__tests__/shutdown-manager.test.ts`

**Modify:**
- `packages/cli/src/index.ts` — create ShutdownManager, pass to commands
- `packages/cli/src/commands/remote-up.ts` — replace `withAbortHandler` with `shutdownManager.push`
- `packages/cli/src/commands/drain.ts` — add shutdown manager integration (if drain command exists)

**Delete:**
- `packages/cli/src/lib/abort-handler.ts` — replaced by shutdown manager

### Tests

`shutdown-manager.test.ts` (bun:test):

1. `push()` adds action to stack, returns dispose function.
2. Dispose function removes the action from the stack.
3. SIGINT fires → `signal` is aborted.
4. SIGINT fires → `isShuttingDown` is true.
5. SIGINT fires → cleanup stack unwinds in LIFO order (last pushed = first cleaned).
6. Three actions pushed (A, B, C) → SIGINT → cleanup order: C, B, A.
7. Cleanup action throws → error logged, next action still runs.
8. All cleanup actions complete → process exits with code 130.
9. Second SIGINT during cleanup → process exits immediately with code 1.
10. No SIGINT, all disposed → stack is empty at end.
11. `install()` registers SIGINT listener, `uninstall()` removes it.
12. `signal` can be passed to `fetch` and `withRetry` for cooperative cancellation.
13. Push after shutdown started → action runs immediately (cleanup of late resources).
14. Cleanup messages printed to stderr with action labels.
15. Multiple `uninstall()` calls are safe (idempotent).
16. Cleanup failure prints manual cleanup command hint.

### Success Criteria

1. `ShutdownManager` provides a LIFO cleanup action stack for graceful Ctrl-C handling.
2. First SIGINT triggers cooperative shutdown: aborts signal, unwinds cleanup stack.
3. Second SIGINT forces immediate exit.
4. `AbortSignal` is exposed for integration with `withRetry` and `fetch`.
5. Commands push/dispose cleanup actions as they acquire/release resources.
6. Cleanup failures are logged but don't prevent other cleanups from running.
7. The existing `withAbortHandler` utility is fully replaced.
8. All long-running commands (`remote up`, `drain`, `backfill`) use the shutdown manager.
9. User sees clear status messages during cleanup ("Shutting down...", "Cleaning up: ...", "Cleanup complete.").
10. The shutdown manager is instantiated once at CLI startup and shared across commands.
