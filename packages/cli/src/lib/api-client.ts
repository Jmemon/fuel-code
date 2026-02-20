/**
 * HTTP API client for communicating with the fuel-code backend.
 *
 * Comprehensive API client that wraps all backend endpoints with typed
 * request/response handling. Replaces the Phase 1 minimal client while
 * maintaining backward compatibility for emit.ts and drain.ts via the
 * createApiClient() compat shim and the ApiClient interface alias.
 *
 * Features:
 *   - Bearer token authentication from config
 *   - Configurable timeouts via AbortController
 *   - Structured error handling (ApiError for HTTP errors, ApiConnectionError for network)
 *   - Response envelope unwrapping (server returns wrapped responses)
 *   - Cursor-based pagination
 *   - All endpoint methods return typed responses
 */

import type { Event, IngestResponse, Session, Workspace, Device, GitActivity, TranscriptMessage } from "@fuel-code/shared";
import { NetworkError } from "@fuel-code/shared";
import { loadConfig, type FuelCodeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

/**
 * HTTP 4xx/5xx error from the backend.
 * Contains the status code and optionally the response body for debugging.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly body?: unknown;

  constructor(message: string, statusCode: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Network-level failure: DNS resolution, connection refused, timeout, etc.
 * Wraps the underlying cause for debugging.
 */
export class ApiConnectionError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "ApiConnectionError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

/** Cursor-based paginated response wrapper for list endpoints */
export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Summary of a workspace for list views, extends base Workspace with aggregated fields */
export interface WorkspaceSummary extends Workspace {
  session_count: number;
  active_session_count: number;
  last_session_at: string | null;
  device_count: number;
  total_cost_usd: number;
  total_duration_ms: number;
}

/** Workspace tracking info with device details */
export interface DeviceWithTracking extends Device {
  local_path: string;
  hooks_installed: boolean;
  git_hooks_installed: boolean;
  last_active_at: string;
}

/** Workspace tracking entry for a device's workspaces */
export interface WorkspaceTracking {
  id: string;
  canonical_id: string;
  display_name: string;
  local_path: string;
  hooks_installed: boolean;
  git_hooks_installed: boolean;
  last_active_at: string;
}

/** Git activity summary for workspace detail */
export interface GitSummary {
  total_commits: number;
  total_pushes: number;
  active_branches: string[];
  last_commit_at: string | null;
}

/** Workspace statistics */
export interface WorkspaceStats {
  total_sessions: number;
  total_duration_ms: number;
  total_cost_usd: number;
  first_session_at: string | null;
  last_session_at: string | null;
}

/** Detailed workspace response including sessions, devices, git summary, and stats */
export interface WorkspaceDetailResponse {
  workspace: Workspace;
  recent_sessions: Session[];
  devices: DeviceWithTracking[];
  git_summary: GitSummary;
  stats: WorkspaceStats;
}

/** Summary of a device for list views, extends base Device with aggregated fields */
export interface DeviceSummary extends Device {
  workspace_count: number;
  session_count: number;
  active_session_count: number;
  last_session_at: string | null;
}

/** Detailed device response */
export interface DeviceDetailResponse {
  device: Device;
  workspaces: WorkspaceTracking[];
  recent_sessions: Session[];
}

/** Backend health status response */
export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  postgres: boolean;
  redis: boolean;
  ws_clients: number;
  uptime: number;
  version: string;
}

// ---------------------------------------------------------------------------
// Timeline Types (Phase 3 discriminated union matching server response)
// ---------------------------------------------------------------------------

/** Git activity summary embedded in timeline items */
export interface TimelineGitEvent {
  id: string;
  type: "commit" | "push" | "checkout" | "merge";
  branch: string | null;
  commit_sha: string | null;
  message: string | null;
  files_changed: number | null;
  timestamp: string;
  data: Record<string, unknown>;
}

/** A session item in the timeline — session with embedded git activity */
export interface TimelineSessionItem {
  type: "session";
  session: {
    id: string;
    workspace_id: string;
    workspace_name: string;
    device_id: string;
    device_name: string;
    lifecycle: string;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    summary: string | null;
    cost_estimate_usd: number | null;
    total_messages: number | null;
    tags: string[];
  };
  git_activity: TimelineGitEvent[];
}

/** An orphan git-activity item — git events outside any session */
export interface TimelineOrphanItem {
  type: "git_activity";
  workspace_id: string;
  workspace_name: string;
  device_id: string;
  device_name: string;
  git_activity: TimelineGitEvent[];
  started_at: string;
}

/** Discriminated union of all timeline item types */
export type TimelineItem = TimelineSessionItem | TimelineOrphanItem;

/** Response from GET /api/timeline */
export interface TimelineResponse {
  items: TimelineItem[];
  next_cursor: string | null;
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Request Parameter Types (camelCase, mapped to snake_case for server)
// ---------------------------------------------------------------------------

/** Parameters for listing sessions */
export interface SessionListParams {
  workspaceId?: string;
  deviceId?: string;
  lifecycle?: string;
  after?: string;
  before?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

/** Parameters for the timeline endpoint */
export interface TimelineParams {
  workspaceId?: string;
  after?: string;
  before?: string;
  types?: string;
}

/** Parameters for listing workspaces */
export interface WorkspaceListParams {
  limit?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Parameter Mapping Helpers
// ---------------------------------------------------------------------------

/**
 * Maps camelCase SessionListParams to snake_case query params for the server.
 */
function mapSessionParams(params?: SessionListParams): Record<string, string | undefined> | undefined {
  if (!params) return undefined;
  return {
    workspace_id: params.workspaceId,
    device_id: params.deviceId,
    lifecycle: params.lifecycle,
    after: params.after,
    before: params.before,
    tag: params.tag,
    limit: params.limit ? String(params.limit) : undefined,
    cursor: params.cursor,
  };
}

// ---------------------------------------------------------------------------
// Backward Compatibility — ApiClient interface
// ---------------------------------------------------------------------------

/**
 * The public ApiClient interface — the same contract as Phase 1.
 *
 * Retained as an interface so that drain.ts and its tests can create lightweight
 * mock objects with just ingest() and health(). The full FuelApiClient class
 * below implements this interface (plus many more endpoints).
 */
export interface ApiClient {
  /** POST events to the backend ingest endpoint. */
  ingest(events: Event[]): Promise<IngestResponse>;
  /** GET the backend health endpoint. Returns true if 2xx, false otherwise. */
  health(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// FuelApiClient Class — the full-featured implementation
// ---------------------------------------------------------------------------

/**
 * Full-featured API client for the fuel-code backend.
 *
 * Wraps all backend endpoints with typed request/response handling,
 * authentication, timeout management, and structured error classification.
 * Implements the ApiClient interface for backward compatibility with Phase 1.
 *
 * All methods unwrap server response envelopes so callers get clean typed data.
 */
export class FuelApiClient implements ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;

  constructor(opts: { baseUrl: string; apiKey: string; timeout?: number }) {
    // Strip trailing slashes for clean path joining
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeout = opts.timeout ?? 10_000;
  }

  /**
   * Create a FuelApiClient from the CLI config file (~/.fuel-code/config.yaml).
   * If no config is provided, loads from disk via loadConfig().
   */
  static fromConfig(config?: FuelCodeConfig): FuelApiClient {
    const cfg = config ?? loadConfig();
    return new FuelApiClient({
      baseUrl: cfg.backend.url,
      apiKey: cfg.backend.api_key,
    });
  }

  // -------------------------------------------------------------------------
  // Core HTTP helper
  // -------------------------------------------------------------------------

  /**
   * Execute an HTTP request against the backend.
   *
   * Handles auth headers, query parameter serialization, JSON body encoding,
   * timeout via AbortController, and error classification into ApiError
   * (HTTP errors) or ApiConnectionError (network failures).
   *
   * On non-2xx responses, attempts to parse JSON body first to extract the
   * server's .error field for a better error message, falling back to raw text.
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options?: {
      query?: Record<string, string | undefined>;
      body?: unknown;
    },
  ): Promise<T> {
    // Build URL with query parameters, omitting keys with undefined values
    // baseUrl must be origin-only (no path suffix) — new URL() drops path components from the base
    const url = new URL(path, this.baseUrl);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }

    // Set up headers
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    // Build fetch init
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    // Add JSON body for methods that support it
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    // Execute the request
    let response: Response;
    try {
      response = await fetch(url.toString(), init);
    } catch (err) {
      // Network-level failure: timeout, DNS, connection refused, etc.
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new ApiConnectionError(
        `Failed to ${method} ${path}: ${cause.message}`,
        cause,
      );
    }

    // Handle non-2xx responses: try JSON first for .error field, fall back to text
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? (body as { error: string }).error
          : `HTTP ${response.status}: ${response.statusText}`;
      throw new ApiError(message, response.status, body);
    }

    // Parse JSON response (handle empty 204 responses)
    if (response.status === 204) {
      return undefined as T;
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(
        `Failed to parse response from ${method} ${path} as JSON`,
        response.status,
        undefined,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Session Endpoints (unwrap server response envelopes)
  // -------------------------------------------------------------------------

  /** List sessions with optional filters, returns cursor-based paginated response */
  async listSessions(params?: SessionListParams): Promise<PaginatedResponse<Session>> {
    const query = mapSessionParams(params);
    const res = await this.request<{ sessions: Session[]; next_cursor: string | null; has_more: boolean }>(
      "GET",
      "/api/sessions",
      { query },
    );
    return { data: res.sessions, nextCursor: res.next_cursor, hasMore: res.has_more };
  }

  /** Get a single session by ID, unwraps { session } envelope */
  async getSession(id: string): Promise<Session> {
    const res = await this.request<{ session: Session }>("GET", `/api/sessions/${id}`);
    return res.session;
  }

  /** Get a session's transcript messages, unwraps { messages } envelope */
  async getTranscript(sessionId: string): Promise<TranscriptMessage[]> {
    const res = await this.request<{ messages: TranscriptMessage[] }>(
      "GET",
      `/api/sessions/${sessionId}/transcript`,
    );
    return res.messages;
  }

  /** Get events belonging to a session, unwraps { events } envelope */
  async getSessionEvents(sessionId: string): Promise<Event[]> {
    const res = await this.request<{ events: Event[] }>(
      "GET",
      `/api/sessions/${sessionId}/events`,
    );
    return res.events;
  }

  /** Get git activity associated with a session, unwraps { git_activity } envelope */
  async getSessionGit(sessionId: string): Promise<GitActivity[]> {
    const res = await this.request<{ git_activity: GitActivity[] }>(
      "GET",
      `/api/sessions/${sessionId}/git`,
    );
    return res.git_activity;
  }

  /** Update a session (e.g., tags or summary), unwraps { session } envelope */
  async updateSession(id: string, patch: { tags?: string[]; summary?: string }): Promise<Session> {
    const res = await this.request<{ session: Session }>(
      "PATCH",
      `/api/sessions/${id}`,
      { body: patch },
    );
    return res.session;
  }

  /** Trigger a re-parse of a session's transcript */
  async reparseSession(sessionId: string): Promise<void> {
    await this.request<{ status: string }>("POST", `/api/sessions/${sessionId}/reparse`);
  }

  // -------------------------------------------------------------------------
  // Workspace Endpoints (unwrap server response envelopes)
  // -------------------------------------------------------------------------

  /** List workspaces, returns cursor-based paginated response */
  async listWorkspaces(params?: WorkspaceListParams): Promise<PaginatedResponse<WorkspaceSummary>> {
    const query: Record<string, string | undefined> = {};
    if (params?.limit) query.limit = String(params.limit);
    if (params?.cursor) query.cursor = params.cursor;
    const res = await this.request<{ workspaces: WorkspaceSummary[]; next_cursor: string | null; has_more: boolean }>(
      "GET",
      "/api/workspaces",
      { query },
    );
    return { data: res.workspaces, nextCursor: res.next_cursor, hasMore: res.has_more };
  }

  /** Get detailed workspace info, returns full detail response as-is */
  async getWorkspace(idOrName: string): Promise<WorkspaceDetailResponse> {
    return this.request<WorkspaceDetailResponse>(
      "GET",
      `/api/workspaces/${encodeURIComponent(idOrName)}`,
    );
  }

  /**
   * Resolve a workspace by name prefix. Returns the workspace ULID.
   *
   * Fetches all workspaces and finds matches by display_name:
   * - Exact match (case-insensitive): returns immediately
   * - Single prefix match: returns the match
   * - Multiple prefix matches: throws ApiError 400 with matches listed
   * - No match: throws ApiError 404
   */
  async resolveWorkspaceName(name: string): Promise<string> {
    const { data: workspaces } = await this.listWorkspaces({ limit: 250 });
    const lower = name.toLowerCase();

    // Try exact match first (case-insensitive)
    const exact = workspaces.find(
      (w) => w.display_name.toLowerCase() === lower,
    );
    if (exact) return exact.id;

    // Try prefix match
    const prefixMatches = workspaces.filter((w) =>
      w.display_name.toLowerCase().startsWith(lower),
    );

    if (prefixMatches.length === 1) return prefixMatches[0].id;

    if (prefixMatches.length > 1) {
      const names = prefixMatches.map((w) => w.display_name).join(", ");
      throw new ApiError(
        `Ambiguous workspace name "${name}". Did you mean: ${names}?`,
        400,
      );
    }

    throw new ApiError(`Workspace not found: "${name}"`, 404);
  }

  // -------------------------------------------------------------------------
  // Device Endpoints (unwrap server response envelopes)
  // -------------------------------------------------------------------------

  /** List all devices, returns bare array (not paginated) */
  async listDevices(): Promise<DeviceSummary[]> {
    const res = await this.request<{ devices: DeviceSummary[] }>("GET", "/api/devices");
    return res.devices;
  }

  /** Get detailed device info, returns full detail response as-is */
  async getDevice(id: string): Promise<DeviceDetailResponse> {
    return this.request<DeviceDetailResponse>("GET", `/api/devices/${id}`);
  }

  // -------------------------------------------------------------------------
  // Timeline Endpoint
  // -------------------------------------------------------------------------

  /** Get the unified timeline of sessions and orphan git activity */
  async getTimeline(params?: TimelineParams): Promise<TimelineResponse> {
    const query: Record<string, string | undefined> = {};
    if (params?.workspaceId) query.workspace_id = params.workspaceId;
    if (params?.after) query.after = params.after;
    if (params?.before) query.before = params.before;
    if (params?.types) query.types = params.types;
    return this.request<TimelineResponse>("GET", "/api/timeline", { query });
  }

  // -------------------------------------------------------------------------
  // System Endpoints
  // -------------------------------------------------------------------------

  /** Check backend health. Returns HealthStatus on success. */
  async getHealth(): Promise<HealthStatus> {
    return this.request<HealthStatus>("GET", "/api/health");
  }

  // -------------------------------------------------------------------------
  // ApiClient interface implementation (backward compatibility)
  // -------------------------------------------------------------------------

  /** POST events to the backend ingest endpoint */
  async ingest(events: Event[]): Promise<IngestResponse> {
    return this.request<IngestResponse>("POST", "/api/events/ingest", {
      body: { events },
    });
  }

  /** Check backend health. Returns true if 2xx, false otherwise. Never throws. */
  async health(): Promise<boolean> {
    try {
      await this.request("GET", "/api/health");
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy Factory Function — backward compatibility for Phase 1 consumers
// ---------------------------------------------------------------------------

/**
 * Create an API client bound to the given config.
 *
 * This is the Phase 1 compat shim used by emit.ts, drain.ts, and their tests.
 * Returns an object implementing the ApiClient interface with NetworkError
 * semantics matching the original Phase 1 implementation.
 */
export function createApiClient(config: FuelCodeConfig): ApiClient {
  const baseUrl = config.backend.url.replace(/\/+$/, "");
  const timeoutMs = config.pipeline.post_timeout_ms;

  return {
    async ingest(events: Event[]): Promise<IngestResponse> {
      const url = `${baseUrl}/api/events/ingest`;

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
        throw new NetworkError(
          `Failed to POST to ${url}: ${err instanceof Error ? err.message : String(err)}`,
          "NETWORK_INGEST_FAILED",
          { url, timeoutMs, cause: String(err) },
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        throw new NetworkError(
          `Ingest returned HTTP ${response.status}: ${body}`,
          "NETWORK_INGEST_HTTP_ERROR",
          { url, status: response.status, body },
        );
      }

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
