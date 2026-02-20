# Task 2: Comprehensive Error Message Framework

## Parallel Group: A

## Dependencies: None

## Description

Implement a structured error formatting system that transforms all user-facing errors into a consistent `Error / Cause / Fix` template. The system has two parts: (1) an error catalog in `packages/shared/` that maps known error codes to human-readable guidance, and (2) an error formatter in `packages/cli/` that renders errors for different output contexts (TTY, piped, JSON). The formatter adapts presentation based on terminal context while the catalog provides the semantic content.

The existing `FuelCodeError` hierarchy (`ConfigError`, `NetworkError`, `ValidationError`, `StorageError`, `AwsError`) is extended with a `code` field. The error catalog maps these codes to structured `{ cause, fix }` entries. Errors not in the catalog still display cleanly — the formatter falls back to the error message with a generic "Unexpected error" cause.

### Error Catalog

```typescript
// packages/shared/src/error-catalog.ts

export interface ErrorGuidance {
  // Human-readable cause explanation
  cause: string;
  // Actionable fix instruction(s)
  fix: string;
}

// Map of error codes to guidance. Codes use dot-separated namespaces.
export const ERROR_CATALOG: Record<string, ErrorGuidance> = {
  // Network errors
  'network.connection_refused': {
    cause: 'The fuel-code server is not reachable.',
    fix: 'Check that the server is running and the backend URL in ~/.fuel-code/config.yaml is correct.',
  },
  'network.timeout': {
    cause: 'The request to the server timed out.',
    fix: 'Check your network connection. The server may be under heavy load — try again in a moment.',
  },
  'network.dns_failed': {
    cause: 'Could not resolve the server hostname.',
    fix: 'Check the backend URL in ~/.fuel-code/config.yaml and your DNS settings.',
  },

  // Auth errors
  'auth.invalid_key': {
    cause: 'The API key is invalid or expired.',
    fix: 'Run `fuel-code config set api_key <your-key>` with a valid API key.',
  },
  'auth.missing_key': {
    cause: 'No API key configured.',
    fix: 'Run `fuel-code config set api_key <your-key>` to configure authentication.',
  },

  // Config errors
  'config.missing': {
    cause: 'Configuration file not found at ~/.fuel-code/config.yaml.',
    fix: 'Run `fuel-code init` to create the configuration file.',
  },
  'config.invalid': {
    cause: 'Configuration file contains invalid values.',
    fix: 'Check ~/.fuel-code/config.yaml for syntax errors or run `fuel-code init` to regenerate.',
  },

  // Queue errors
  'queue.locked': {
    cause: 'Another drain process is already running.',
    fix: 'Wait for the other drain to complete, or remove ~/.fuel-code/.drain.lock if the process crashed.',
  },
  'queue.corrupt_event': {
    cause: 'An event file in the queue contains invalid data.',
    fix: 'Run `fuel-code queue inspect` to identify the corrupt file, then `fuel-code queue purge <id>` to remove it.',
  },

  // AWS errors
  'aws.credentials_missing': {
    cause: 'AWS credentials are not configured.',
    fix: 'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars, or configure an AWS profile.',
  },
  'aws.ec2_launch_failed': {
    cause: 'Failed to launch EC2 instance.',
    fix: 'Check your AWS quota limits, VPC configuration, and that the instance type is available in your region.',
  },
  'aws.ec2_timeout': {
    cause: 'EC2 instance did not reach running state within the timeout.',
    fix: 'Check the AWS console for the instance status. You may need to terminate it manually.',
  },
  'aws.s3_access_denied': {
    cause: 'Access denied when reading/writing to S3.',
    fix: 'Check that your AWS credentials have s3:GetObject, s3:PutObject, and s3:DeleteObject permissions on the fuel-code bucket.',
  },

  // Remote errors
  'remote.not_found': {
    cause: 'The specified remote environment does not exist.',
    fix: 'Run `fuel-code remote ls` to see active environments.',
  },
  'remote.already_terminated': {
    cause: 'The remote environment has already been terminated.',
    fix: 'No action needed. Run `fuel-code remote up` to create a new environment.',
  },
  'remote.ssh_key_expired': {
    cause: 'The SSH key for this environment has already been downloaded and is no longer available from the server.',
    fix: 'Check ~/.fuel-code/ssh-keys/<id>/ for the local copy, or terminate and create a new environment.',
  },

  // Session errors
  'session.not_found': {
    cause: 'The specified session does not exist.',
    fix: 'Run `fuel-code session ls` to see available sessions.',
  },
  'session.already_archived': {
    cause: 'The session is already archived.',
    fix: 'Run `fuel-code session <id> --restore` to restore it from archive.',
  },

  // Blueprint errors
  'blueprint.not_found': {
    cause: 'No .fuel-code/env.yaml file found in the project.',
    fix: 'Run `fuel-code blueprint detect` to auto-generate one.',
  },
  'blueprint.invalid': {
    cause: 'The .fuel-code/env.yaml file contains invalid configuration.',
    fix: 'Run `fuel-code blueprint validate` to see specific validation errors.',
  },

  // Archival errors
  'archival.integrity_mismatch': {
    cause: 'The S3 backup does not match the Postgres data (message count mismatch).',
    fix: 'This is a safety check. Re-run archival — it will create a fresh backup and re-verify.',
  },
  'archival.s3_backup_missing': {
    cause: 'No backup found in S3 for this session.',
    fix: 'The archival engine will create the backup automatically. If this persists, check S3 bucket permissions.',
  },
};

// Look up guidance for an error code. Returns undefined if not in catalog.
export function getErrorGuidance(code: string): ErrorGuidance | undefined;
```

### Error Code on FuelCodeError

> **Phase 3 Downstream Amendment [3→6.C.1]:** The actual `FuelCodeError` constructor
> signature is `(message: string, code: string, context?: Record<string, unknown>)` —
> NOT `(message, options?)`. The `code` field already exists as a required parameter,
> and `context` replaces `cause`. All subclasses follow this pattern. The spec below
> shows the PLANNED change; implementors should reconcile with the actual constructor.

```typescript
// PLANNED — but actual FuelCodeError already has: constructor(message, code, context)
// The `code` field already exists. This task should:
//   1. Keep the existing constructor signature
//   2. Add error catalog lookup using the existing `code` field
//   3. NOT change the constructor — it's already used across Phases 1-3

export class FuelCodeError extends Error {
  readonly code?: string;
  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, { cause: options?.cause });
    this.code = options?.code;
  }
}
```

All existing subclasses (`ConfigError`, `NetworkError`, etc.) gain the `code` parameter. Existing call sites are not required to change — `code` is optional.

### Error Formatter

```typescript
// packages/cli/src/lib/error-formatter.ts

export interface FormatErrorOptions {
  // Force a specific output mode (auto-detected if omitted)
  mode?: 'tty' | 'piped' | 'json';
}

// Format an error for CLI output. Auto-detects output mode from process.stdout.isTTY.
// Returns a formatted string ready for console.error().
export function formatError(error: unknown, options?: FormatErrorOptions): string;

// Detect output mode based on environment.
// Returns 'json' if --json flag detected, 'tty' if stdout is TTY, 'piped' otherwise.
export function detectOutputMode(): 'tty' | 'piped' | 'json';
```

### Output Formats

**TTY mode** (interactive terminal, colored):
```
✗ Error: Failed to connect to fuel-code server
  Cause:  The fuel-code server is not reachable.
  Fix:    Check that the server is running and the backend URL in
          ~/.fuel-code/config.yaml is correct.
```
- "Error:" in red bold, "Cause:" in yellow, "Fix:" in green
- Uses picocolors for coloring
- Multi-line values wrap with indentation alignment

**Piped mode** (non-TTY, no color):
```
Error: Failed to connect to fuel-code server | Cause: The fuel-code server is not reachable. | Fix: Check that the server is running and the backend URL in ~/.fuel-code/config.yaml is correct.
```
- Single line, pipe-delimited
- No colors, no special characters

**JSON mode** (--json flag):
```json
{"error":{"message":"Failed to connect to fuel-code server","code":"network.connection_refused","cause":"The fuel-code server is not reachable.","fix":"Check that the server is running and the backend URL in ~/.fuel-code/config.yaml is correct."}}
```

**Fallback** (error not in catalog):
```
✗ Error: Something unexpected happened
  Cause:  Unexpected error.
  Fix:    If this persists, please report it at https://github.com/user/fuel-code/issues
```

### Wiring into CLI

The top-level error handler in `packages/cli/src/index.ts` (the commander `.action()` error catcher) should be updated to use `formatError()` instead of printing `error.message` directly. This is a one-line change:

```typescript
// Before:
console.error(`Error: ${error.message}`);
// After:
console.error(formatError(error));
```

### Relevant Files

**Create:**
- `packages/shared/src/error-catalog.ts`
- `packages/shared/src/__tests__/error-catalog.test.ts`
- `packages/cli/src/lib/error-formatter.ts`
- `packages/cli/src/lib/__tests__/error-formatter.test.ts`

**Modify:**
- `packages/shared/src/errors.ts` — add `code` field to `FuelCodeError` constructor
- `packages/shared/src/index.ts` — export error catalog
- `packages/cli/src/index.ts` — use `formatError()` in top-level error handler

### Tests

`error-catalog.test.ts` (bun:test):

1. `getErrorGuidance('network.connection_refused')` returns the correct cause and fix strings.
2. `getErrorGuidance('auth.invalid_key')` returns auth-related guidance.
3. `getErrorGuidance('nonexistent.code')` returns `undefined`.
4. Every entry in `ERROR_CATALOG` has non-empty `cause` and `fix` strings.
5. Every error code follows the `namespace.name` dot-separated format.

`error-formatter.test.ts` (bun:test):

6. TTY mode: `FuelCodeError` with known code → includes "Error:", "Cause:", "Fix:" on separate lines.
7. TTY mode: error with unknown code → includes "Unexpected error" as cause.
8. TTY mode: plain `Error` (no code) → formats cleanly with error message and generic guidance.
9. TTY mode: non-Error value (string, number) → converts to string and formats.
10. Piped mode: same error → single-line pipe-delimited format, no ANSI codes.
11. JSON mode: same error → valid JSON with `error.message`, `error.code`, `error.cause`, `error.fix`.
12. JSON mode: error without code → JSON has `null` code and generic cause/fix.
13. `detectOutputMode()` returns `'tty'` when `process.stdout.isTTY` is true.
14. `detectOutputMode()` returns `'piped'` when `process.stdout.isTTY` is false/undefined.
15. `FuelCodeError` with `code` field is correctly picked up by the formatter.
16. Long fix text wraps with proper indentation in TTY mode.
17. Error with nested `cause` (Error chain) includes the cause message in output.

### Success Criteria

1. `ERROR_CATALOG` covers all major error scenarios: network, auth, config, queue, AWS, remote, session, blueprint, archival.
2. `FuelCodeError` gains an optional `code` field without breaking existing usage.
3. `formatError()` auto-detects output mode and renders appropriately.
4. TTY output is colored with picocolors and multi-line with indentation.
5. Piped output is single-line with no ANSI escape codes.
6. JSON output is valid JSON with all fields.
7. Errors not in the catalog still format cleanly with a generic fallback.
8. The CLI top-level error handler uses `formatError()`.
9. The error catalog is in `packages/shared/` so server-side code can also reference it if needed.
10. All catalog entries have actionable, specific fix instructions — not generic "contact support".

> **Known limitation:** Existing error sites from Phases 1-5 will produce generic error messages. Error codes will be added incrementally as errors are encountered and improved. No retrofit task is needed.
