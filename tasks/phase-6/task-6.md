# Task 6: Retrofit CLI HTTP Transport with Shared Retry

## Parallel Group: B

## Dependencies: Tasks 1, 2

## Description

Add retry logic to the CLI's HTTP transport layer (`ApiClient`) using the shared `withRetry()` from Task 1 and the error formatter from Task 2. Currently, the CLI makes a single HTTP attempt with a 2-second timeout and falls back to the local queue on failure. Phase 6 adds configurable retries with exponential backoff before falling back to the queue. The error formatter provides structured error messages when all retries are exhausted.

The retry behavior is: attempt the HTTP call up to 3 times with exponential backoff for transient errors (network failures, 429, 5xx). If all retries fail, the existing queue fallback still applies for event ingestion. For non-ingestion endpoints (session list, remote commands, etc.), the error is surfaced to the user via the error formatter.

### Changes to ApiClient

```typescript
// packages/cli/src/lib/api-client.ts

import { withRetry, isRetryableHttpError } from '@fuel-code/shared';
import { formatError } from './error-formatter.js';

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private logger: pino.Logger;

  // New: configurable retry options
  private retryOptions: {
    maxAttempts: number;
    initialDelayMs: number;
    signal?: AbortSignal;
  };

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    logger: pino.Logger;
    // Optional AbortSignal for cancellation (from ShutdownManager)
    signal?: AbortSignal;
    // Override retry defaults (for testing)
    retryOptions?: { maxAttempts?: number; initialDelayMs?: number };
  }) {
    // ... existing constructor logic ...
    this.retryOptions = {
      maxAttempts: opts.retryOptions?.maxAttempts ?? 3,
      initialDelayMs: opts.retryOptions?.initialDelayMs ?? 1000,
      signal: opts.signal,
    };
  }

  // Internal method: make an HTTP request with retry
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<T> {
    const signal = options?.signal ?? this.retryOptions.signal;

    return withRetry(
      async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal,
        });

        if (!response.ok) {
          // Create an error with status code for retry predicate
          const errorBody = await response.text().catch(() => '');
          const error = new NetworkError(
            `HTTP ${response.status}: ${errorBody || response.statusText}`,
            { code: this.httpStatusToErrorCode(response.status) },
          );
          (error as any).status = response.status;
          throw error;
        }

        return response.json() as T;
      },
      {
        maxAttempts: this.retryOptions.maxAttempts,
        initialDelayMs: this.retryOptions.initialDelayMs,
        shouldRetry: isRetryableHttpError,
        onRetry: (err, attempt, delay) => {
          this.logger.debug({ err, attempt, delay, method, path }, 'HTTP request failed, retrying');
        },
        signal,
      },
    );
  }

  // Map HTTP status codes to error catalog codes
  private httpStatusToErrorCode(status: number): string {
    switch (status) {
      case 401: return 'auth.invalid_key';
      case 403: return 'auth.invalid_key';
      case 404: return 'remote.not_found';  // generic, overridden per-endpoint
      case 429: return 'network.timeout';
      default: return 'network.connection_refused';
    }
  }
}
```

### Event Ingestion: Retry Then Queue Fallback

The `emitEvent` / `ingestEvents` method has special behavior: on HTTP failure after all retries, it falls back to the local queue instead of surfacing an error. This preserves the existing guarantee that events are never lost.

```typescript
async ingestEvents(events: FuelCodeEvent[]): Promise<IngestResult> {
  try {
    // Try HTTP with retry
    return await this.request<IngestResult>('POST', '/api/events/ingest', { events });
  } catch (error) {
    // All retries exhausted — fall back to queue
    this.logger.debug({ error, eventCount: events.length }, 'HTTP ingestion failed after retries, queueing locally');
    await this.enqueueLocally(events);
    return { accepted: 0, queued: events.length };
  }
}
```

### Non-Ingestion Endpoints: Retry Then Error

For all other endpoints (sessions, workspaces, remote commands, etc.), the error is thrown after retries are exhausted. The top-level error handler (modified in Task 2) formats it.

```typescript
async getSession(id: string): Promise<Session> {
  return this.request<Session>('GET', `/api/sessions/${id}`);
  // If all retries fail, the error propagates up and gets formatted
}
```

### AbortSignal Threading

The `signal` parameter flows from the constructor through to `withRetry` and `fetch`. This enables Ctrl-C (Task 10) to cancel in-flight HTTP requests during retry waits. When aborted, the retry loop exits immediately without attempting further retries.

### Timeout Changes

Replace the hardcoded 2-second timeout with a more generous default since retries handle transient slowness:

- Default timeout per individual request: 10 seconds (up from 2s)
- Total worst-case for 3 retries: ~10s + 1s delay + 10s + 2s delay + 10s = ~33s
- Event ingestion timeout: 5 seconds (events are small payloads)

### Relevant Files

**Modify:**
- `packages/cli/src/lib/api-client.ts` — add `withRetry` to all HTTP methods, add `signal` support, update timeout defaults

**No new files created.**

### Tests

`api-client.test.ts` updates (bun:test, using mock HTTP server or fetch mock):

1. Successful request: no retries, returns response directly.
2. Transient 503 on first attempt, 200 on second → succeeds after one retry.
3. Transient 429 → retried (rate limiting is transient).
4. Transient `ECONNREFUSED` → retried.
5. Transient `ETIMEDOUT` → retried.
6. Permanent 401 → NOT retried, error thrown immediately with `auth.invalid_key` code.
7. Permanent 404 → NOT retried, error thrown immediately.
8. Permanent 400 → NOT retried, error thrown immediately.
9. All retries exhausted (3x 500) → error thrown with last error preserved.
10. Event ingestion: all retries fail → events queued locally, no error thrown to caller.
11. Event ingestion: queue fallback returns `{ accepted: 0, queued: N }`.
12. AbortSignal aborted before request → throws AbortError, no request made.
13. AbortSignal aborted during retry delay → throws AbortError, remaining retries skipped.
14. `onRetry` callback logs at debug level with method, path, attempt, delay.
15. Per-request timeout is 10 seconds (not 2 seconds).
16. Constructor accepts custom `retryOptions` for testing overrides.
17. Constructor accepts `signal` for external cancellation.

### Success Criteria

1. All HTTP calls in ApiClient use `withRetry` with `isRetryableHttpError` predicate.
2. Transient errors (network failures, 429, 5xx) are retried up to 3 times with exponential backoff.
3. Client errors (4xx except 429) are not retried — they fail immediately.
4. Event ingestion falls back to local queue after all retries are exhausted.
5. Non-ingestion requests surface errors through the error formatter.
6. HTTP errors carry error catalog codes for structured formatting.
7. AbortSignal is threaded through to both fetch and withRetry for cancellation.
8. Default timeout increased from 2s to 10s per individual attempt.
9. Retry logging uses pino at debug level — visible in verbose mode, not in normal output.
10. All existing ApiClient tests still pass with the new retry behavior.
