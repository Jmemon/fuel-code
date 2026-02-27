# Task 4: Progress Indicator Utility

## Parallel Group: A

## Dependencies: None

## Description

Implement a shared progress reporting utility at `packages/cli/src/lib/progress.ts`. This utility adapts to the terminal context: spinner with elapsed time for TTY, timestamped log lines for piped output, and no output for `--json` mode. It provides a simple `start(label)` / `update(label)` / `succeed(label)` / `fail(label)` / `stop()` API that commands use without worrying about output detection. The utility is used by `remote up` (provisioning), `drain` (queue processing), `backfill` (transcript parsing), and `session archive` (archival).

### Interface

```typescript
// packages/cli/src/lib/progress.ts

export type ProgressMode = 'spinner' | 'log' | 'silent';

export interface ProgressReporter {
  // Start a new progress operation with a label (e.g., "Provisioning instance...")
  start(label: string): void;

  // Update the current label (e.g., "Waiting for instance to be ready... (45s)")
  update(label: string): void;

  // Mark the current operation as succeeded (e.g., "✓ Instance ready (52s)")
  succeed(label: string): void;

  // Mark the current operation as failed (e.g., "✗ Provisioning failed (30s)")
  fail(label: string): void;

  // Stop the progress indicator and clean up. Idempotent.
  stop(): void;

  // Elapsed time in milliseconds since start() was called
  readonly elapsedMs: number;
}

// Create a progress reporter that auto-detects mode.
// - TTY + no --json → spinner mode
// - Non-TTY + no --json → log mode
// - --json flag → silent mode
export function createProgressReporter(options?: {
  // Force a specific mode (overrides auto-detection)
  mode?: ProgressMode;
  // Stream to write to (default: process.stderr for spinner/log, avoids polluting stdout)
  stream?: NodeJS.WritableStream;
}): ProgressReporter;

// Detect the appropriate progress mode based on environment.
export function detectProgressMode(): ProgressMode;
```

### Mode Behaviors

**Spinner mode** (TTY):
- Uses ANSI escape codes to show a spinner animation on a single line
- Spinner characters: `['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']` (braille dots)
- Updates every 80ms
- Shows elapsed time: `⠙ Provisioning instance... (12s)`
- `succeed()`: replaces spinner with `✓` in green, stops animation
- `fail()`: replaces spinner with `✗` in red, stops animation
- Writes to stderr so it doesn't interfere with piped stdout
- Uses `\r` (carriage return) to overwrite the current line, `\x1b[K` to clear to end of line

**Log mode** (piped / non-TTY):
- Each `start()` / `update()` / `succeed()` / `fail()` prints a timestamped line
- Format: `[HH:MM:SS] label`
- No ANSI codes, no overwriting
- `succeed()`: `[HH:MM:SS] ✓ label`
- `fail()`: `[HH:MM:SS] ✗ label`

**Silent mode** (--json):
- All methods are no-ops
- `elapsedMs` still tracks time (may be useful for JSON output metadata)

### Elapsed Time Formatting

```typescript
// Used internally to format elapsed time for display
// < 60s: "(12s)"
// >= 60s: "(1m 23s)"
// >= 3600s: "(1h 2m 3s)"
function formatElapsed(ms: number): string;
```

### Implementation Details

1. **Spinner animation**: Use `setInterval` at 80ms to cycle through braille characters. Clear interval on `stop()`, `succeed()`, or `fail()`.

2. **Cursor hiding**: On `start()`, hide cursor with `\x1b[?25l`. On `stop()`/`succeed()`/`fail()`, restore cursor with `\x1b[?25h`. Handle process exit to always restore cursor.

3. **No external dependencies**: The spinner is implemented with raw ANSI codes — no `ora` or `cli-spinners` dependency needed. picocolors is used for coloring (already a project dependency).

4. **Process exit safety**: Register a one-time `process.on('exit')` handler that restores cursor visibility if the spinner is still active. This prevents the terminal from being left in a bad state if the process crashes.

5. **Thread safety**: `stop()` is idempotent — calling it multiple times is safe. `start()` after `stop()` resets the elapsed timer and starts a new spinner.

6. **stderr not stdout**: All output goes to `process.stderr` by default. This is critical because CLI commands may pipe stdout to other tools, and spinner output would corrupt the piped data.

### Relevant Files

**Create:**
- `packages/cli/src/lib/progress.ts`
- `packages/cli/src/lib/__tests__/progress.test.ts`

**Modify:**
- `packages/cli/src/lib/index.ts` — export progress utilities (if barrel file exists)

### Tests

`progress.test.ts` (bun:test):

1. `detectProgressMode()` returns `'spinner'` when `process.stderr.isTTY` is true and no `--json`.
2. `detectProgressMode()` returns `'log'` when `process.stderr.isTTY` is false.
3. `detectProgressMode()` returns `'silent'` when `--json` flag is present.
4. Spinner mode: `start()` writes spinner character + label to stream.
5. Spinner mode: `update()` overwrites the current line with new label.
6. Spinner mode: `succeed()` writes `✓` + label + elapsed time, stops spinner.
7. Spinner mode: `fail()` writes `✗` + label + elapsed time, stops spinner.
8. Spinner mode: `stop()` clears the spinner line and restores cursor.
9. Log mode: `start()` writes timestamped line to stream.
10. Log mode: `succeed()` writes timestamped line with `✓`.
11. Log mode: `fail()` writes timestamped line with `✗`.
12. Silent mode: `start()`, `update()`, `succeed()`, `fail()` produce no output.
13. Silent mode: `elapsedMs` still tracks time correctly.
14. `elapsedMs` increases between `start()` and later calls.
15. `formatElapsed(5000)` returns `'(5s)'`.
16. `formatElapsed(75000)` returns `'(1m 15s)'`.
17. `formatElapsed(3723000)` returns `'(1h 2m 3s)'`.
18. `stop()` is idempotent — calling twice does not error.
19. Spinner animation cycles through braille characters (verify via captured writes over ~200ms).
20. Output goes to stderr by default, not stdout (verify by capturing writes to custom stream).

### Success Criteria

1. `createProgressReporter()` auto-detects mode from terminal context.
2. Spinner mode shows animated spinner with elapsed time, replacing the line in-place.
3. Log mode prints timestamped lines suitable for piped output or log files.
4. Silent mode produces no output, suitable for `--json` mode.
5. `succeed()` and `fail()` show final status with total elapsed time.
6. All output goes to stderr, never stdout.
7. Cursor is always restored, even on crash (process exit handler).
8. No external spinner dependencies — implemented with raw ANSI codes + picocolors.
9. `stop()` is idempotent and safe to call multiple times.
10. Elapsed time formatting is human-readable (seconds, minutes+seconds, hours+minutes+seconds).
