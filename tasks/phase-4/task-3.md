# Task 3: CLI: API Client + Output Formatting Utilities

## Parallel Group: A

## Dependencies: None

## Description

Create two foundational CLI modules that all query commands and TUI views depend on:

1. **`packages/cli/src/lib/api-client.ts`** -- **REPLACES** the existing basic `api-client.ts` from Phase 1. The Phase 1 version has a `createApiClient()` factory that returns an object with only an `ingest()` method — used by `emit.ts` and `drain.ts`. This task replaces it with a comprehensive `ApiClient` class wrapping `fetch()`. Handles auth headers, base URL from config, pagination cursors, error classification, and timeout. Every CLI command and TUI component uses this instead of raw `fetch()`.

   > **IMPORTANT (Phase 1 backward compatibility):** `emit.ts` and `drain.ts` import from `api-client.ts`. The new `ApiClient` class MUST either: (a) export a `createApiClient()` compat shim that wraps the new class, or (b) the new class itself must have an `ingest()` method matching the old signature. Verify `emit.ts` and `drain.ts` still work after replacement. Search for all imports of `api-client` before replacing.

2. **`packages/cli/src/lib/formatters.ts`** -- Table renderer, value formatters (duration, cost, relative time, lifecycle badges), and color coding with `picocolors`. Used by all CLI query commands for consistent stdout output. NOT used by TUI (TUI renders via Ink components). Designed for pipeable, scriptable output.

---

### Module 1: API Client

**File: `packages/cli/src/lib/api-client.ts`**

#### Error Classes

```typescript
// Thrown on HTTP 4xx/5xx responses from the server
export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Thrown on network failures (connection refused, DNS failure, timeout)
export class ApiConnectionError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'ApiConnectionError';
  }
}
```

#### Pagination Interface

```typescript
// Generic paginated response matching the server's response shape
export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

#### Query Parameter Types

```typescript
export interface SessionListParams {
  workspaceId?: string;
  deviceId?: string;
  lifecycle?: string;         // comma-separated for multiple, e.g., "parsed,summarized"
  after?: string;             // ISO-8601
  before?: string;            // ISO-8601
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface TimelineParams {
  workspaceId?: string;
  after?: string;
  before?: string;
  types?: string;             // comma-separated event types
}

export interface WorkspaceListParams {
  limit?: number;
  cursor?: string;
}
```

#### ApiClient Class

```typescript
import { loadConfig, type FuelCodeConfig } from './config';

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: { baseUrl: string; apiKey: string; timeout?: number }) {
    // Strip trailing slash from base URL for consistent path joining
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 10_000;
  }

  // Factory: create from CLI config file (~/.fuel-code/config.yaml)
  static fromConfig(config?: FuelCodeConfig): ApiClient {
    const cfg = config ?? loadConfig();
    return new ApiClient({
      baseUrl: cfg.backend.url,
      apiKey: cfg.backend.api_key,
    });
  }

  // --- Sessions ---

  async listSessions(params?: SessionListParams): Promise<PaginatedResponse<Session>> {
    // Maps to GET /api/sessions
    // Translates camelCase params to snake_case query params:
    //   workspaceId → workspace_id, deviceId → device_id
    const query = mapSessionParams(params);
    const res = await this.request<{ sessions: Session[]; next_cursor: string | null; has_more: boolean }>(
      'GET', '/api/sessions', { query }
    );
    return { data: res.sessions, nextCursor: res.next_cursor, hasMore: res.has_more };
  }

  async getSession(id: string): Promise<Session> {
    // Maps to GET /api/sessions/:id
    const res = await this.request<{ session: Session }>('GET', `/api/sessions/${id}`);
    return res.session;
  }

  async getTranscript(sessionId: string): Promise<TranscriptMessage[]> {
    // Maps to GET /api/sessions/:id/transcript
    const res = await this.request<{ messages: TranscriptMessage[] }>(
      'GET', `/api/sessions/${sessionId}/transcript`
    );
    return res.messages;
  }

  async getSessionEvents(sessionId: string): Promise<Event[]> {
    // Maps to GET /api/sessions/:id/events
    const res = await this.request<{ events: Event[] }>(
      'GET', `/api/sessions/${sessionId}/events`
    );
    return res.events;
  }

  async getSessionGit(sessionId: string): Promise<GitActivity[]> {
    // Maps to GET /api/sessions/:id/git
    const res = await this.request<{ git_activity: GitActivity[] }>(
      'GET', `/api/sessions/${sessionId}/git`
    );
    return res.git_activity;
  }

  async updateSession(id: string, patch: { tags?: string[]; summary?: string }): Promise<Session> {
    // Maps to PATCH /api/sessions/:id
    const res = await this.request<{ session: Session }>(
      'PATCH', `/api/sessions/${id}`, { body: patch }
    );
    return res.session;
  }

  async reparseSession(id: string): Promise<void> {
    // Maps to POST /api/sessions/:id/reparse
    await this.request<{ status: string }>('POST', `/api/sessions/${id}/reparse`);
  }

  // --- Workspaces ---

  async listWorkspaces(params?: WorkspaceListParams): Promise<PaginatedResponse<WorkspaceSummary>> {
    // Maps to GET /api/workspaces
    const query: Record<string, string | undefined> = {};
    if (params?.limit) query.limit = String(params.limit);
    if (params?.cursor) query.cursor = params.cursor;
    const res = await this.request<{ workspaces: WorkspaceSummary[]; next_cursor: string | null; has_more: boolean }>(
      'GET', '/api/workspaces', { query }
    );
    return { data: res.workspaces, nextCursor: res.next_cursor, hasMore: res.has_more };
  }

  async getWorkspace(idOrName: string): Promise<WorkspaceDetail> {
    // Maps to GET /api/workspaces/:id
    // The server accepts ULID, canonical_id, or display_name
    const res = await this.request<WorkspaceDetailResponse>(
      'GET', `/api/workspaces/${encodeURIComponent(idOrName)}`
    );
    return res;
  }

  // Resolve a workspace display name to its ULID.
  // Fetches workspace list, finds by name (case-insensitive).
  // Exact match wins. If no exact match, tries prefix match.
  // Throws ApiError if not found or ambiguous.
  async resolveWorkspaceName(name: string): Promise<string> {
    const { data: workspaces } = await this.listWorkspaces({ limit: 250 });
    const lower = name.toLowerCase();

    // Try exact match first (case-insensitive)
    const exact = workspaces.find(w => w.display_name.toLowerCase() === lower);
    if (exact) return exact.id;

    // Try prefix match
    const prefixMatches = workspaces.filter(w =>
      w.display_name.toLowerCase().startsWith(lower)
    );

    if (prefixMatches.length === 1) return prefixMatches[0].id;
    if (prefixMatches.length > 1) {
      const names = prefixMatches.map(w => w.display_name).join(', ');
      throw new ApiError(
        `Ambiguous workspace name "${name}". Did you mean: ${names}?`,
        400
      );
    }

    throw new ApiError(`Workspace not found: "${name}"`, 404);
  }

  // --- Devices ---

  async listDevices(): Promise<DeviceSummary[]> {
    // Maps to GET /api/devices
    const res = await this.request<{ devices: DeviceSummary[] }>('GET', '/api/devices');
    return res.devices;
  }

  async getDevice(id: string): Promise<DeviceDetail> {
    // Maps to GET /api/devices/:id
    const res = await this.request<DeviceDetailResponse>('GET', `/api/devices/${id}`);
    return res;
  }

  // --- Timeline ---

  // > **Phase 3 Downstream Amendment [3->4.A.1]:** The actual timeline API
  // > returns `{ items, next_cursor, has_more }` where `items` is a
  // > discriminated union of session items and orphan git-activity items —
  // > NOT `{ timeline: TimelineEntry[] }` with flat objects. See the
  // > TimelineResponse / TimelineItem types below.

  async getTimeline(params?: TimelineParams): Promise<TimelineResponse> {
    // Maps to GET /api/timeline
    const query: Record<string, string | undefined> = {};
    if (params?.workspaceId) query.workspace_id = params.workspaceId;
    if (params?.after) query.after = params.after;
    if (params?.before) query.before = params.before;
    if (params?.types) query.types = params.types;
    return this.request<TimelineResponse>('GET', '/api/timeline', { query });
  }

  // --- System ---

  async getHealth(): Promise<HealthStatus> {
    // Maps to GET /api/health
    return this.request<HealthStatus>('GET', '/api/health');
  }

  // --- Internal request helper ---

  private async request<T>(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | undefined>;
      body?: unknown;
      timeout?: number;
    }
  ): Promise<T> {
    // 1. Build URL with query params (omit keys with undefined values)
    const url = new URL(path, this.baseUrl);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }

    // 2. Set up headers
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
    };
    if (options?.body) {
      headers['Content-Type'] = 'application/json';
    }

    // 3. Set up timeout via AbortController
    const controller = new AbortController();
    const timeoutMs = options?.timeout ?? this.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // 4. Execute fetch
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiConnectionError(
          `Request timed out after ${timeoutMs}ms: ${method} ${path}`,
          err
        );
      }
      throw new ApiConnectionError(
        `Cannot connect to backend at ${this.baseUrl}: ${(err as Error).message}`,
        err as Error
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // 5. Handle non-2xx responses
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }
      const message = typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error: string }).error
        : `HTTP ${response.status}: ${response.statusText}`;
      throw new ApiError(message, response.status, body);
    }

    // 6. Parse and return JSON
    return response.json() as Promise<T>;
  }
}
```

#### Helper: Parameter Mapping

```typescript
// Maps camelCase SessionListParams to snake_case query params for the server
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
```

#### Response Types

These types represent the server's response shapes, used internally by the ApiClient methods. They import shared types from `@fuel-code/shared` where possible and define API-specific aggregation fields inline:

```typescript
import type {
  Session, Workspace, Device, Event,
  GitActivity, TranscriptMessage
} from '@fuel-code/shared';

// Extended types with aggregated fields from API responses
export interface WorkspaceSummary extends Workspace {
  session_count: number;
  active_session_count: number;
  last_session_at: string | null;
  device_count: number;
  total_cost_usd: number;
  total_duration_ms: number;
}

export interface WorkspaceDetailResponse {
  workspace: Workspace;
  recent_sessions: Session[];
  devices: DeviceWithTracking[];
  git_summary: GitSummary;
  stats: WorkspaceStats;
}

export interface DeviceSummary extends Device {
  workspace_count: number;
  session_count: number;
  active_session_count: number;
  last_session_at: string | null;
}

export interface DeviceDetailResponse {
  device: Device;
  workspaces: WorkspaceTracking[];
  recent_sessions: Session[];
}

export interface DeviceWithTracking extends Device {
  local_path: string;
  hooks_installed: boolean;
  git_hooks_installed: boolean;
  last_active_at: string;
}

export interface WorkspaceTracking {
  id: string;
  canonical_id: string;
  display_name: string;
  local_path: string;
  hooks_installed: boolean;
  git_hooks_installed: boolean;
  last_active_at: string;
}

export interface GitSummary {
  total_commits: number;
  total_pushes: number;
  active_branches: string[];
  last_commit_at: string | null;
}

export interface WorkspaceStats {
  total_sessions: number;
  total_duration_ms: number;
  total_cost_usd: number;
  first_session_at: string | null;
  last_session_at: string | null;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  postgres: boolean;
  redis: boolean;
  ws_clients: number;
  uptime: number;
  version: string;
}

// > **Phase 3 Downstream Amendment [3->4.A.1]:** The timeline API returns a
// > discriminated union of session items and orphan git-activity items, NOT a
// > flat TimelineEntry. The types below match the actual API at
// > packages/server/src/routes/timeline.ts.

/** Git activity summary embedded in timeline items */
export interface TimelineGitEvent {
  id: string;
  type: 'commit' | 'push' | 'checkout' | 'merge';
  branch: string | null;
  commit_sha: string | null;
  message: string | null;
  files_changed: number | null;
  timestamp: string;
  data: Record<string, unknown>;
}

/** A session item in the timeline — session with embedded git activity */
export interface TimelineSessionItem {
  type: 'session';
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
  type: 'git_activity';
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
```

---

### Module 2: Output Formatters

**File: `packages/cli/src/lib/formatters.ts`**

Uses `picocolors` for terminal colors (3.5KB, zero dependencies, supports NO_COLOR env var). NOT chalk -- chalk is ESM-only since v5, heavier, and has dependencies.

#### Duration Formatting

```typescript
import pc from 'picocolors';

// Formats milliseconds into a human-readable duration string.
// 0 → "0s", 999 → "0s", 30000 → "30s", 60000 → "1m",
// 720000 → "12m", 4920000 → "1h22m", 90000000 → "1d1h"
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === 0) return '-';
  if (ms < 1000) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d${hours % 24 > 0 ? `${hours % 24}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes % 60 > 0 ? `${String(minutes % 60).padStart(2, '0')}m` : ''}`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
```

#### Cost Formatting

```typescript
// Formats USD cost to a display string.
// null → "—", 0 → "$0.00", 0.005 → "<$0.01", 0.42 → "$0.42", 1.999 → "$2.00"
export function formatCost(usd: number | null): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
```

#### Relative Time Formatting

```typescript
// Formats an ISO-8601 timestamp into a relative or calendar string.
// "just now" (< 60s), "30s ago", "5m ago", "2h ago",
// "yesterday 3:45pm", "Monday 3:45pm", "Feb 10", "Feb 10, 2025" (different year)
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;

  // Check if yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `yesterday ${formatTime(date)}`;
  }

  // Check if this week (within last 7 days)
  const daysAgo = Math.floor(diffHr / 24);
  if (daysAgo < 7) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${dayNames[date.getDay()]} ${formatTime(date)}`;
  }

  // Same year: "Feb 10"
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (date.getFullYear() === now.getFullYear()) {
    return `${months[date.getMonth()]} ${date.getDate()}`;
  }

  // Different year: "Feb 10, 2025"
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

// Helper: format time as "3:45pm"
function formatTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  return `${hours}:${String(minutes).padStart(2, '0')}${ampm}`;
}
```

#### Lifecycle Badge Formatting

```typescript
// Returns a colored lifecycle status string with icon.
// Color scheme follows traffic-light convention:
//   green = active/good, yellow/blue = in-progress, red = error, dim = inactive
export function formatLifecycle(lifecycle: string): string {
  switch (lifecycle) {
    case 'detected':    return pc.dim('○ DETECTED');
    case 'capturing':   return pc.green('● LIVE');
    case 'ended':       return pc.yellow('◐ ENDED');
    case 'parsed':      return pc.yellow('◑ PARSED');
    case 'summarized':  return pc.green('✓ DONE');
    case 'archived':    return pc.dim('▪ ARCHIVED');
    case 'failed':      return pc.red('✗ FAILED');
    default:            return pc.dim(lifecycle.toUpperCase());
  }
}
```

#### Table Renderer

```typescript
export interface ColumnDef {
  header: string;                // Column header text
  width?: number;                // Fixed width (truncates/pads). If omitted, auto-sized.
  align?: 'left' | 'right';     // Default: 'left'
}

// Renders a table with headers and rows for stdout.
// Auto-sizes columns based on content and terminal width.
// Truncates values that exceed column width.
export function renderTable(opts: {
  columns: ColumnDef[];
  rows: string[][];              // Each row is an array of cell values, one per column
  maxWidth?: number;             // Default: process.stdout.columns || 120
}): string {
  const { columns, rows, maxWidth = process.stdout.columns || 120 } = opts;

  if (rows.length === 0) {
    return '';
  }

  // 1. Calculate column widths
  //    Start with header lengths, then expand to fit the widest cell in each column.
  //    If total exceeds maxWidth, shrink the widest columns proportionally.
  const gap = 2; // 2-space gap between columns
  const widths = columns.map((col, i) => {
    if (col.width) return col.width;
    const headerLen = col.header.length;
    const maxCell = Math.max(headerLen, ...rows.map(row => stripAnsi(row[i] ?? '').length));
    return maxCell;
  });

  // 2. If total width exceeds maxWidth, shrink the widest column(s)
  const totalGaps = (columns.length - 1) * gap;
  let totalWidth = widths.reduce((a, b) => a + b, 0) + totalGaps;
  while (totalWidth > maxWidth && widths.some(w => w > 10)) {
    // Find widest column and shrink it by 1
    const maxIdx = widths.indexOf(Math.max(...widths));
    widths[maxIdx]--;
    totalWidth--;
  }

  // 3. Render header row
  const headerLine = columns.map((col, i) =>
    pc.bold(pad(col.header, widths[i], col.align ?? 'left'))
  ).join('  ');

  // 4. Render data rows
  const dataLines = rows.map(row =>
    columns.map((col, i) => {
      const value = row[i] ?? '';
      return pad(truncate(value, widths[i]), widths[i], col.align ?? 'left');
    }).join('  ')
  );

  return [headerLine, ...dataLines].join('\n');
}

// Pad/align a string to a given width
function pad(str: string, width: number, align: 'left' | 'right'): string {
  const visibleLen = stripAnsi(str).length;
  if (visibleLen >= width) return str;
  const padding = ' '.repeat(width - visibleLen);
  return align === 'right' ? padding + str : str + padding;
}

// Strip ANSI escape codes for length calculation
// Regex covers standard ANSI color/style sequences
function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}
```

#### Truncation

```typescript
// Truncates a string to maxLen characters, adding "..." suffix if truncated.
// maxLen includes the ellipsis (so truncate("hello world", 8) → "hello...")
// Accounts for ANSI escape codes (counts visible chars only).
export function truncate(text: string, maxLen: number): string {
  if (maxLen < 4) return text.slice(0, maxLen);
  const visible = stripAnsi(text);
  if (visible.length <= maxLen) return text;
  // Simple approach: slice visible text, re-apply no styling
  // For styled text, strip ANSI first then truncate to avoid splitting escape codes
  return visible.slice(0, maxLen - 3) + '...';
}
```

#### Token Formatting

```typescript
// Formats token counts with K abbreviation.
// formatTokens(125000, 48000, 890000) → "125K in / 48K out / 890K cache"
export function formatTokens(tokensIn: number, tokensOut: number, cacheRead?: number): string {
  const parts = [
    `${formatNumber(tokensIn)} in`,
    `${formatNumber(tokensOut)} out`,
  ];
  if (cacheRead && cacheRead > 0) {
    parts.push(`${formatNumber(cacheRead)} cache`);
  }
  return parts.join(' / ');
}

// Abbreviates large numbers: 500 → "500", 1500 → "1.5K", 125000 → "125K"
export function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}
```

#### Pre-Configured Row Formatters

```typescript
// Formats a session into a row array for the sessions table.
// Order: STATUS, WORKSPACE, DEVICE, DURATION, COST, STARTED, SUMMARY
export function formatSessionRow(session: Session): string[] {
  return [
    formatLifecycle(session.lifecycle),
    session.workspace_name ?? session.workspace_id,
    session.device_name ?? session.device_id,
    formatDuration(session.duration_ms),
    formatCost(session.cost_estimate_usd),
    formatRelativeTime(session.started_at),
    session.summary ?? session.initial_prompt ?? pc.dim('(no summary)'),
  ];
}

// Formats a workspace into a row array for the workspaces table.
// Order: WORKSPACE, SESSIONS, ACTIVE, DEVICES, COST, LAST ACTIVITY
export function formatWorkspaceRow(workspace: WorkspaceSummary): string[] {
  return [
    workspace.display_name,
    String(workspace.session_count),
    workspace.active_session_count > 0
      ? pc.green(String(workspace.active_session_count))
      : '0',
    String(workspace.device_count),
    formatCost(workspace.total_cost_usd),
    workspace.last_session_at
      ? formatRelativeTime(workspace.last_session_at)
      : pc.dim('never'),
  ];
}
```

#### Empty State and Error Formatting

```typescript
// Formats an empty-state message for a given entity type.
export function formatEmpty(entity: string): string {
  return pc.dim(`No ${entity} found.`);
}

// Formats an error for user display (no stack traces).
// ApiError → "Error: <server message> (HTTP <code>)"
// ApiConnectionError → "Connection error: Cannot connect to backend at <url>"
// Other → "Error: <message>"
export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return pc.red(`Error: ${error.message} (HTTP ${error.statusCode})`);
  }
  if (error instanceof ApiConnectionError) {
    return pc.red(`Connection error: ${error.message}`);
  }
  if (error instanceof Error) {
    return pc.red(`Error: ${error.message}`);
  }
  return pc.red(`Error: ${String(error)}`);
}
```

#### JSON Output Helper

```typescript
// Helper for --json flag support on all query commands.
// If json=true, stringify data to stdout.
// Otherwise, call the format function and print its result.
export function outputResult(data: unknown, options: { json?: boolean; format: () => string }): void {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(options.format());
  }
}
```

---

### Dependencies

```bash
cd packages/cli && bun add picocolors
```

`picocolors` is 3.5KB, zero dependencies, supports the `NO_COLOR` and `FORCE_COLOR` environment variables, and is widely used (10M+ weekly downloads). Do NOT use chalk (ESM-only since v5, heavier, has deps).

---

### Tests

**`packages/cli/src/lib/__tests__/api-client.test.ts`**:

Use `Bun.serve()` to create a local mock HTTP server in tests. No external mocking library needed. Each test starts a mock server, creates an `ApiClient` pointing at it, and asserts behavior.

1. `request()` constructs correct URL with path appended to baseUrl.
2. `request()` sends `Authorization: Bearer <apiKey>` header on every request.
3. `request()` with query params: omits keys with `undefined` values, includes others.
4. `request()` with body: sets `Content-Type: application/json`, serializes body.
5. `request()` on 200 response: returns parsed JSON.
6. `request()` on 401 response: throws `ApiError` with statusCode 401.
7. `request()` on 404 response: throws `ApiError` with statusCode 404 and server error message.
8. `request()` on 500 response: throws `ApiError` with statusCode 500.
9. `request()` on network failure (connection refused): throws `ApiConnectionError`.
10. `request()` on timeout: throws `ApiConnectionError` with timeout message.
11. `listSessions()` with no params: sends `GET /api/sessions`.
12. `listSessions({ workspaceId: 'abc', lifecycle: 'parsed' })`: sends `?workspace_id=abc&lifecycle=parsed`.
13. `listSessions()` returns `PaginatedResponse` with data, nextCursor, hasMore.
14. `getSession(id)`: sends `GET /api/sessions/<id>`, returns session.
15. `getTranscript(id)`: sends `GET /api/sessions/<id>/transcript`, returns messages array.
16. `getSessionEvents(id)`: sends `GET /api/sessions/<id>/events`, returns events array.
17. `getSessionGit(id)`: sends `GET /api/sessions/<id>/git`, returns git_activity array.
18. `updateSession(id, { tags: ['test'] })`: sends `PATCH /api/sessions/<id>` with body.
19. `reparseSession(id)`: sends `POST /api/sessions/<id>/reparse`.
20. `listWorkspaces()`: sends `GET /api/workspaces`, returns PaginatedResponse.
21. `getWorkspace(id)`: sends `GET /api/workspaces/<id>`, returns workspace detail.
22. `getWorkspace('canonical/id')`: correctly URL-encodes the path segment.
23. `resolveWorkspaceName('fuel-code')`: exact match returns ULID.
24. `resolveWorkspaceName('fuel')`: single prefix match returns ULID.
25. `resolveWorkspaceName('nonexistent')`: throws ApiError with 404.
26. `resolveWorkspaceName('f')`: multiple prefix matches throws ApiError with 400 and candidate list.
27. `listDevices()`: sends `GET /api/devices`, returns devices array.
28. `getDevice(id)`: sends `GET /api/devices/<id>`, returns device detail.
29. `getTimeline()`: sends `GET /api/timeline`, returns `TimelineResponse` with `items`, `next_cursor`, `has_more`. Items are a discriminated union (`type: 'session'` or `type: 'git_activity'`).
30. `getTimeline({ workspaceId, after, before })`: sends correct query params, reads from `items` key (not `timeline`).
31. `getHealth()`: sends `GET /api/health`, returns health status.
32. `fromConfig()`: creates client with baseUrl and apiKey from config.

**`packages/cli/src/lib/__tests__/formatters.test.ts`**:

Pure unit tests with no external dependencies.

1. `formatDuration(null)` returns `"-"`.
2. `formatDuration(0)` returns `"-"`.
3. `formatDuration(500)` returns `"0s"`.
4. `formatDuration(1000)` returns `"1s"`.
5. `formatDuration(30000)` returns `"30s"`.
6. `formatDuration(60000)` returns `"1m"`.
7. `formatDuration(720000)` returns `"12m"`.
8. `formatDuration(4920000)` returns `"1h22m"`.
9. `formatDuration(90000000)` returns `"1d1h"`.
10. `formatCost(null)` returns `"—"`.
11. `formatCost(0)` returns `"$0.00"`.
12. `formatCost(0.005)` returns `"<$0.01"`.
13. `formatCost(0.42)` returns `"$0.42"`.
14. `formatCost(1.999)` returns `"$2.00"`.
15. `formatCost(12.345)` returns `"$12.35"`.
16. `formatRelativeTime` with timestamp < 60s ago returns `"just now"`.
17. `formatRelativeTime` with timestamp 5 minutes ago returns `"5m ago"`.
18. `formatRelativeTime` with timestamp 2 hours ago returns `"2h ago"`.
19. `formatRelativeTime` with yesterday's timestamp returns `"yesterday <time>"`.
20. `formatRelativeTime` with timestamp 3 days ago returns `"<day-name> <time>"`.
21. `formatRelativeTime` with timestamp > 7 days ago (same year) returns `"Feb 10"` format.
22. `formatRelativeTime` with timestamp from a different year returns `"Feb 10, 2025"` format.
23. `formatLifecycle('detected')` returns dimmed `"○ DETECTED"`.
24. `formatLifecycle('capturing')` returns green `"● LIVE"`.
25. `formatLifecycle('ended')` returns yellow `"◐ ENDED"`.
26. `formatLifecycle('parsed')` returns yellow `"◑ PARSED"`.
27. `formatLifecycle('summarized')` returns green `"✓ DONE"`.
28. `formatLifecycle('archived')` returns dimmed `"▪ ARCHIVED"`.
29. `formatLifecycle('failed')` returns red `"✗ FAILED"`.
30. `formatLifecycle('unknown')` returns dimmed uppercase of the input.
31. `renderTable` with headers and rows: produces aligned output.
32. `renderTable` auto-sizes columns based on content.
33. `renderTable` respects maxWidth by shrinking the widest column.
34. `renderTable` with empty rows: returns empty string.
35. `renderTable` with right-aligned column: numbers are right-aligned.
36. `truncate('hello world', 8)` returns `"hello..."`.
37. `truncate('short', 10)` returns `"short"` (no truncation).
38. `truncate('hi', 2)` returns `"hi"` (too short for ellipsis).
39. `formatTokens(125000, 48000, 890000)` returns `"125K in / 48K out / 890K cache"`.
40. `formatTokens(500, 200)` returns `"500 in / 200 out"` (no cache).
41. `formatNumber(500)` returns `"500"`.
42. `formatNumber(1500)` returns `"1.5K"`.
43. `formatNumber(125000)` returns `"125K"`.
44. `formatSessionRow` returns array with 7 elements in correct order.
45. `formatWorkspaceRow` returns array with 6 elements in correct order.
46. `formatEmpty('sessions')` returns `"No sessions found."`.
47. `formatError(new ApiError('Not found', 404))` includes HTTP code.
48. `formatError(new ApiConnectionError('timeout'))` includes connection error prefix.
49. `outputResult` with `json: true` outputs JSON.stringify to stdout.
50. `outputResult` with `json: false` calls format function and outputs result.

## Relevant Files

- `packages/cli/src/lib/api-client.ts` (**replace** — Phase 1 version exists with basic createApiClient()/ingest(); must be fully replaced with ApiClient class while preserving backward compat for emit.ts and drain.ts)
- `packages/cli/src/lib/formatters.ts` (create)
- `packages/cli/src/lib/__tests__/api-client.test.ts` (create)
- `packages/cli/src/lib/__tests__/formatters.test.ts` (create)
- `packages/cli/package.json` (modify -- add `picocolors` dependency)

## Success Criteria

1. `ApiClient` constructor accepts `{ baseUrl, apiKey, timeout }` and strips trailing slash from baseUrl.
2. `ApiClient.fromConfig()` factory reads `~/.fuel-code/config.yaml` and creates a configured client.
3. `request()` sends `Authorization: Bearer <apiKey>` header on every request.
4. `request()` correctly serializes query params (omits undefined values).
5. `request()` sets `Content-Type: application/json` for requests with body.
6. `request()` uses `AbortController` with configurable timeout (default 10 seconds).
7. Network errors (connection refused, DNS failure) throw `ApiConnectionError`.
8. Timeout errors throw `ApiConnectionError` with descriptive message.
9. HTTP 4xx/5xx responses throw `ApiError` with statusCode, message from server error body, and raw body.
10. All session endpoints wrapped: list, detail, transcript, events, git, update, reparse.
11. All workspace endpoints wrapped: list (with pagination), detail (with URL-encoding), resolveWorkspaceName.
12. `resolveWorkspaceName` resolves by exact match (case-insensitive), then prefix match, throws on ambiguous/not-found.
13. All device endpoints wrapped: list, detail.
14. Timeline and health endpoints wrapped with correct parameter mapping.
15. `formatDuration` handles null, 0, sub-second, seconds, minutes, hours, days.
16. `formatCost` handles null, 0, sub-cent, normal values, rounding.
17. `formatRelativeTime` produces "just now", "Nm ago", "Nh ago", "yesterday", day names, month/date, year formats.
18. `formatLifecycle` color-codes all 7 lifecycle states with correct icons.
19. `renderTable` auto-sizes columns, respects terminal width, handles empty input.
20. `renderTable` correctly handles ANSI-styled cell values (counts visible chars for width calculation).
21. `truncate` adds "..." suffix when text exceeds maxLen (accounting for visible char length).
22. `formatTokens` and `formatNumber` abbreviate with K suffix.
23. `formatSessionRow` and `formatWorkspaceRow` produce correctly ordered arrays.
24. `formatEmpty` and `formatError` produce user-friendly messages.
25. `outputResult` supports `--json` flag pattern for all query commands.
26. `picocolors` is used for terminal colors (not chalk).
27. All formatters are pure functions with no side effects (except `outputResult` which writes to stdout).
28. All 82 tests pass (`bun test`).
