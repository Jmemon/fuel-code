# Task 1: Shared Retry Utility with Exponential Backoff

## Parallel Group: A

## Dependencies: None

## Description

Implement a shared `withRetry()` higher-order function in `packages/shared/src/retry.ts`. This is the single retry abstraction used by both CLI (HTTP transport, queue drain) and server (EC2 client, S3 client, archival engine). It wraps any async operation with configurable exponential backoff, jitter, a `shouldRetry` predicate, an `onRetry` callback for logging, and `AbortSignal` support for cancellation. Pre-built retry predicates are exported for AWS errors, HTTP errors, and network errors.

The utility is a pure higher-order function with zero side effects — it has no knowledge of pino, picocolors, or any I/O. Callers provide logging via the `onRetry` callback.

### Interface

```typescript
// packages/shared/src/retry.ts

export interface RetryOptions {
  // Maximum number of retry attempts (not counting the initial attempt).
  // Default: 3
  maxAttempts?: number;

  // Initial delay in milliseconds before the first retry.
  // Default: 1000 (1 second)
  initialDelayMs?: number;

  // Multiplier applied to the delay after each retry.
  // Default: 2 (doubles each time: 1s, 2s, 4s, ...)
  backoffMultiplier?: number;

  // Maximum delay in milliseconds (cap on exponential growth).
  // Default: 30_000 (30 seconds)
  maxDelayMs?: number;

  // Jitter factor (0 to 1). Applied as random ±jitter of the computed delay.
  // Default: 0.25 (±25% jitter)
  jitterFactor?: number;

  // Predicate: given the error, should this operation be retried?
  // Default: () => true (retry all errors)
  shouldRetry?: (error: unknown) => boolean;

  // Callback invoked before each retry. Use for logging.
  // Receives the error, the attempt number (1-indexed), and the delay before retry.
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;

  // AbortSignal for cancellation. If aborted, throws immediately without retry.
  signal?: AbortSignal;
}

// Wraps an async function with retry logic.
// Returns the result of fn() on success, or throws the last error after all retries exhausted.
export function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T>;

// Computes the delay for a given attempt (exported for testing).
// delay = min(initialDelayMs * backoffMultiplier^attempt, maxDelayMs) * (1 ± random*jitter)
export function computeDelay(
  attempt: number,
  initialDelayMs: number,
  backoffMultiplier: number,
  maxDelayMs: number,
  jitterFactor: number,
): number;
```

### Pre-Built Retry Predicates

```typescript
// packages/shared/src/retry.ts (same file, exported)

// AWS SDK errors that are safe to retry
export function isRetryableAwsError(error: unknown): boolean;
// Checks: error.name in ['ThrottlingException', 'RequestLimitExceeded',
//   'InternalError', 'ServiceUnavailableException', 'TooManyRequestsException']
// Also checks: error.$metadata?.httpStatusCode in [429, 500, 502, 503, 504]

// HTTP fetch errors that are safe to retry (network failures + server errors)
export function isRetryableHttpError(error: unknown): boolean;
// Checks: error.code in ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
//   'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'FETCH_ERROR']
// Also checks: error.status in [429, 500, 502, 503, 504]
// Does NOT retry: 400, 401, 403, 404, 409, 422 (client errors are not transient)

// Network-level errors (subset used by queue drain)
export function isNetworkError(error: unknown): boolean;
// Checks: error.code in ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
//   'EPIPE', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']
```

### Implementation Details

1. **Exponential backoff with jitter**: delay = `min(initialDelayMs * backoffMultiplier^attempt, maxDelayMs)`, then apply `±(jitterFactor * delay * random())`. This prevents thundering-herd when multiple clients retry simultaneously.

2. **AbortSignal integration**: Before each retry attempt, check `signal?.aborted`. If aborted, throw an `AbortError` immediately. Also use `AbortSignal.timeout()` or a setTimeout-based delay that clears on abort, so the wait between retries is interruptible.

3. **Error preservation**: The final thrown error is the last error from the last attempt, not a wrapper. This preserves the original error type and stack trace for callers.

4. **Attempt counting**: `attempt` in `onRetry` is 1-indexed (first retry = attempt 1). The initial call is attempt 0 (not reported via onRetry).

5. **Sleep implementation**: Use a promise-based sleep that respects AbortSignal:
```typescript
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
```

### Relevant Files

**Create:**
- `packages/shared/src/retry.ts`
- `packages/shared/src/__tests__/retry.test.ts`

**Modify:**
- `packages/shared/src/index.ts` — export `withRetry`, `computeDelay`, `RetryOptions`, and all predicate functions

### Tests

`retry.test.ts` (bun:test):

1. `withRetry` calls `fn` once on success — no retries.
2. `withRetry` retries up to `maxAttempts` times on failure, then throws the last error.
3. `withRetry` succeeds if `fn` fails initially but succeeds on a retry attempt.
4. `onRetry` callback is called with correct `(error, attempt, delayMs)` for each retry.
5. `shouldRetry` predicate returning `false` stops retries immediately and throws.
6. Default `shouldRetry` retries all errors (when not provided).
7. Exponential backoff: delays increase by `backoffMultiplier` each attempt (mock timers to verify).
8. Delay is capped at `maxDelayMs` — does not grow beyond it.
9. Jitter: computed delays vary within ±`jitterFactor` range (run many times, check statistical bounds).
10. `computeDelay` returns correct values for known inputs (deterministic when jitter is 0).
11. `signal` abort before first call → throws `AbortError`, `fn` never called.
12. `signal` abort during retry delay → throws `AbortError`, remaining retries skipped.
13. `signal` abort during `fn` execution → error from `fn` propagated (abort doesn't swallow fn errors).
14. `isRetryableAwsError` returns `true` for `ThrottlingException`, `RequestLimitExceeded`, `InternalError`, `ServiceUnavailableException`.
15. `isRetryableAwsError` returns `true` for errors with `$metadata.httpStatusCode` of 429, 500, 503.
16. `isRetryableAwsError` returns `false` for `ValidationException`, `AccessDeniedException`.
17. `isRetryableHttpError` returns `true` for `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`.
18. `isRetryableHttpError` returns `true` for HTTP status 429, 500, 502, 503, 504.
19. `isRetryableHttpError` returns `false` for HTTP status 400, 401, 403, 404, 422.
20. `isNetworkError` returns `true` for `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`.
21. `isNetworkError` returns `false` for non-network errors (e.g., `TypeError`).
22. Default options: `maxAttempts=3`, `initialDelayMs=1000`, `backoffMultiplier=2`, `maxDelayMs=30000`, `jitterFactor=0.25`.
23. Zero `maxAttempts` means no retries — `fn` called exactly once.

### Success Criteria

1. `withRetry()` correctly retries async operations with configurable exponential backoff.
2. Jitter prevents thundering-herd — delays are randomized within the configured factor.
3. `shouldRetry` predicate allows callers to control which errors trigger retries.
4. `onRetry` callback enables logging without the retry utility importing any logger.
5. `AbortSignal` integration allows clean cancellation of retry loops (for Ctrl-C support).
6. Pre-built predicates correctly classify AWS, HTTP, and network errors.
7. The utility is pure — no I/O, no side effects, no dependencies beyond standard lib.
8. Exported from `packages/shared/` so both CLI and server can import it.
9. `computeDelay` is exported and tested independently for deterministic verification.
10. Error preservation: the thrown error after all retries is the original last error, not a wrapper.
