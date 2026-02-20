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
  readonly body?: string;

  constructor(message: string, statusCode: number, body?: string) {
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

/** Paginated response wrapper for list endpoints */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Summary of a workspace for list views */
export interface WorkspaceSummary {
  id: string;
  canonical_id: string;
  display_name: string;
  default_branch: string | null;
  session_count: number;
  active_session_count: number;
  device_count: number;
  total_cost_usd: number;
  last_activity_at: string | null;
  first_seen_at: string;
  updated_at: string;
}

/** Workspace tracking info (active sessions and recent git) */
export interface WorkspaceTracking {
  active_sessions: Array<{
    id: string;
    lifecycle: string;
    started_at: string;
    device_name: string;
  }>;
  recent_git: GitSummary[];
}

/** Git activity summary */
export interface GitSummary {
  id: string;
  type: string;
  branch: string | null;
  commit_sha: string | null;
  message: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  timestamp: string;
}

/** Workspace statistics */
export interface WorkspaceStats {
  total_sessions: number;
  total_events: number;
  total_cost_usd: number;
  total_duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  top_tools: Array<{ name: string; count: number }>;
}

/** Detailed workspace response including tracking and stats */
export interface WorkspaceDetailResponse {
  workspace: Workspace;
  tracking: WorkspaceTracking;
  stats: WorkspaceStats;
}

/** Summary of a device for list views */
export interface DeviceSummary {
  id: string;
  name: string;
  type: string;
  status: string;
  platform: string;
  os_version: string;
  session_count: number;
  last_seen_at: string;
  first_seen_at: string;
}

/** Device with active tracking info */
export interface DeviceWithTracking {
  device: Device;
  active_sessions: Array<{
    id: string;
    workspace_name: string;
    lifecycle: string;
    started_at: string;
  }>;
}

/** Detailed device response */
export interface DeviceDetailResponse {
  device: Device;
  tracking: DeviceWithTracking;
  stats: {
    total_sessions: number;
    total_events: number;
    last_seen_at: string;
  };
}

/** Backend health status response */
export interface HealthStatus {
  status: string;
  version?: string;
  uptime?: number;
  services?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Timeline Types (Phase 3 discriminated union)
// ---------------------------------------------------------------------------

/** A git event in the timeline */
export interface TimelineGitEvent {
  kind: "git";
  id: string;
  type: string;
  branch: string | null;
  commit_sha: string | null;
  message: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  timestamp: string;
  session_id: string | null;
  device_id: string;
}

/** A session item in the timeline */
export interface TimelineSessionItem {
  kind: "session";
  id: string;
  lifecycle: string;
  workspace_id: string;
  workspace_name: string;
  device_id: string;
  device_name: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  summary: string | null;
  git_branch: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
}

/** An orphan event in the timeline (git event without a session) */
export interface TimelineOrphanItem {
  kind: "orphan";
  id: string;
  event_type: string;
  workspace_id: string;
  workspace_name: string;
  device_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** Discriminated union of all timeline item types */
export type TimelineItem = TimelineGitEvent | TimelineSessionItem | TimelineOrphanItem;

/** Timeline endpoint response */
export interface TimelineResponse {
  items: TimelineItem[];
  total: number;
  has_more: boolean;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Request Parameter Types
// ---------------------------------------------------------------------------

/** Parameters for listing sessions */
export interface SessionListParams {
  workspace_id?: string;
  device_id?: string;
  lifecycle?: string;
  limit?: number;
  offset?: number;
  order_by?: string;
  order_dir?: "asc" | "desc";
}

/** Parameters for the timeline endpoint */
export interface TimelineParams {
  workspace_id?: string;
  device_id?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  kinds?: string[];
}

/** Parameters for listing workspaces */
export interface WorkspaceListParams {
  limit?: number;
  offset?: number;
  order_by?: string;
  order_dir?: "asc" | "desc";
  search?: string;
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

/** Options for individual HTTP requests */
interface RequestOptions {
  params?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
}

/**
 * Full-featured API client for the fuel-code backend.
 *
 * Wraps all backend endpoints with typed request/response handling,
 * authentication, timeout management, and structured error classification.
 * Implements the ApiClient interface for backward compatibility with Phase 1.
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
   */
  private async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    // Build URL with query parameters
    const url = new URL(`${this.baseUrl}${path}`);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          // Join arrays as comma-separated for query params
          url.searchParams.set(key, value.join(","));
        } else {
          url.searchParams.set(key, String(value));
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

    // Handle non-2xx responses
    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable>");
      throw new ApiError(
        `${method} ${path} returned HTTP ${response.status}: ${body}`,
        response.status,
        body,
      );
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
  // Session Endpoints
  // -------------------------------------------------------------------------

  /** List sessions with optional filters */
  async listSessions(params?: SessionListParams): Promise<PaginatedResponse<Session>> {
    return this.request<PaginatedResponse<Session>>("GET", "/api/sessions", {
      params: params as Record<string, string | number | boolean | undefined>,
    });
  }

  /** Get a single session by ID */
  async getSession(id: string): Promise<Session> {
    return this.request<Session>("GET", `/api/sessions/${id}`);
  }

  /** Get a session's transcript messages */
  async getTranscript(sessionId: string): Promise<TranscriptMessage[]> {
    return this.request<TranscriptMessage[]>("GET", `/api/sessions/${sessionId}/transcript`);
  }

  /** Get events belonging to a session */
  async getSessionEvents(sessionId: string): Promise<Event[]> {
    return this.request<Event[]>("GET", `/api/sessions/${sessionId}/events`);
  }

  /** Get git activity associated with a session */
  async getSessionGit(sessionId: string): Promise<GitActivity[]> {
    return this.request<GitActivity[]>("GET", `/api/sessions/${sessionId}/git`);
  }

  /** Update a session (e.g., change lifecycle state) */
  async updateSession(id: string, updates: Partial<Session>): Promise<Session> {
    return this.request<Session>("PATCH", `/api/sessions/${id}`, {
      body: updates,
    });
  }

  /** Trigger a re-parse of a session's transcript */
  async reparseSession(sessionId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>("POST", `/api/sessions/${sessionId}/reparse`);
  }

  // -------------------------------------------------------------------------
  // Workspace Endpoints
  // -------------------------------------------------------------------------

  /** List workspaces with optional filters */
  async listWorkspaces(params?: WorkspaceListParams): Promise<PaginatedResponse<WorkspaceSummary>> {
    return this.request<PaginatedResponse<WorkspaceSummary>>("GET", "/api/workspaces", {
      params: params as Record<string, string | number | boolean | undefined>,
    });
  }

  /** Get detailed workspace info including tracking and stats */
  async getWorkspace(id: string): Promise<WorkspaceDetailResponse> {
    return this.request<WorkspaceDetailResponse>("GET", `/api/workspaces/${id}`);
  }

  /**
   * Resolve a workspace by name prefix.
   *
   * Fetches all workspaces and finds matches by display_name:
   * - Exact match: returns immediately
   * - Single prefix match: returns the match
   * - Multiple prefix matches: throws ApiError with matches listed
   * - No match: throws ApiError 404
   */
  async resolveWorkspaceName(name: string): Promise<WorkspaceSummary> {
    const response = await this.listWorkspaces({ limit: 250 });
    const workspaces = response.data;

    // Check for exact match first (case-insensitive)
    const exact = workspaces.find(
      (w) => w.display_name.toLowerCase() === name.toLowerCase(),
    );
    if (exact) return exact;

    // Check for prefix matches
    const lowerName = name.toLowerCase();
    const prefixMatches = workspaces.filter((w) =>
      w.display_name.toLowerCase().startsWith(lowerName),
    );

    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }

    if (prefixMatches.length > 1) {
      const names = prefixMatches.map((w) => w.display_name).join(", ");
      throw new ApiError(
        `Ambiguous workspace name "${name}" matches: ${names}`,
        400,
      );
    }

    throw new ApiError(
      `Workspace "${name}" not found`,
      404,
    );
  }

  // -------------------------------------------------------------------------
  // Device Endpoints
  // -------------------------------------------------------------------------

  /** List all devices */
  async listDevices(): Promise<PaginatedResponse<DeviceSummary>> {
    return this.request<PaginatedResponse<DeviceSummary>>("GET", "/api/devices");
  }

  /** Get detailed device info */
  async getDevice(id: string): Promise<DeviceDetailResponse> {
    return this.request<DeviceDetailResponse>("GET", `/api/devices/${id}`);
  }

  // -------------------------------------------------------------------------
  // Timeline Endpoints
  // -------------------------------------------------------------------------

  /** Get the unified timeline of sessions, git events, and orphan events */
  async getTimeline(params?: TimelineParams): Promise<TimelineResponse> {
    return this.request<TimelineResponse>("GET", "/api/timeline", {
      params: params as Record<string, string | number | boolean | string[] | undefined>,
    });
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
