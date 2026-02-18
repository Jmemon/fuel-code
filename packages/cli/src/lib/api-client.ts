/**
 * HTTP API client for communicating with the fuel-code backend.
 *
 * Provides a thin wrapper around fetch() with:
 *   - Bearer token authentication from config
 *   - Configurable timeouts via AbortSignal.timeout()
 *   - Structured error handling (throws NetworkError on any failure)
 *
 * Used by the `emit` command for event ingestion and by `status`/`init`
 * for health checks.
 */

import {
  NetworkError,
  type Event,
  type IngestResponse,
} from "@fuel-code/shared";
import type { FuelCodeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// ApiClient interface — the public contract
// ---------------------------------------------------------------------------

/** Methods available on the API client */
export interface ApiClient {
  /** POST events to the backend ingest endpoint. Throws NetworkError on failure. */
  ingest(events: Event[]): Promise<IngestResponse>;
  /** GET the backend health endpoint. Returns true if 2xx, false otherwise. */
  health(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create an API client bound to the given config.
 *
 * The client uses the backend URL and API key from config, and respects
 * the post_timeout_ms for ingest calls. Health checks use a fixed 5s timeout.
 */
export function createApiClient(config: FuelCodeConfig): ApiClient {
  /** Strip trailing slashes from the backend URL for clean path joining */
  const baseUrl = config.backend.url.replace(/\/+$/, "");

  return {
    /**
     * POST one or more events to the ingest endpoint.
     *
     * Uses AbortSignal.timeout() to enforce the configured timeout (default 2s
     * for emit calls). On any network error, timeout, or non-2xx response,
     * throws a NetworkError so the caller can fall through to the local queue.
     */
    async ingest(events: Event[]): Promise<IngestResponse> {
      const url = `${baseUrl}/api/events/ingest`;
      const timeoutMs = config.pipeline.post_timeout_ms;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.backend.api_key}`,
          },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network error, DNS failure, timeout, or abort
        throw new NetworkError(
          `Failed to POST to ${url}: ${err instanceof Error ? err.message : String(err)}`,
          "NETWORK_INGEST_FAILED",
          { url, timeoutMs, cause: String(err) },
        );
      }

      // Non-2xx response — treat as a failure
      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        throw new NetworkError(
          `Ingest returned HTTP ${response.status}: ${body}`,
          "NETWORK_INGEST_HTTP_ERROR",
          { url, status: response.status, body },
        );
      }

      // Parse the IngestResponse JSON
      try {
        return (await response.json()) as IngestResponse;
      } catch (err) {
        throw new NetworkError(
          `Failed to parse ingest response as JSON: ${err instanceof Error ? err.message : String(err)}`,
          "NETWORK_INGEST_PARSE_ERROR",
          { url },
        );
      }
    },

    /**
     * Check backend health via GET /api/health.
     * Returns true if the backend responds with 2xx, false on any failure.
     * Never throws — designed for best-effort connectivity checks.
     */
    async health(): Promise<boolean> {
      const url = `${baseUrl}/api/health`;
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(5000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
