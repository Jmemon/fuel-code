/**
 * Integration tests for the GET /api/timeline endpoint.
 *
 * Uses a real Express app with mock SQL dependencies.
 * The mock SQL is a proxy that intercepts postgres.js tagged template calls
 * and returns canned data based on query patterns.
 *
 * Test coverage:
 *   1. Empty database: valid empty response
 *   2. Sessions without git activity: session items with empty git_activity arrays
 *   3. Session with commits: embedded commit data in git_activity array
 *   4. Orphan git events (no session): returned as type='git_activity' items
 *   5. Interleaving: ordered by timestamp (session, orphan, session)
 *   6. workspace_id filter works
 *   7. device_id filter works
 *   8. after filter works
 *   9. before filter works
 *   10. types=commit filter: only commits in git_activity
 *   11. Pagination: limit=2, cursor, has_more, no duplicates
 *   12. Invalid cursor: 400 error
 *   13. Session with multiple git events: all in git_activity, ordered by timestamp
 *   14. Git activity data field is populated
 *   15. Auth required: 401 without Bearer token
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { logger } from "../../logger.js";
import { createAuthMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createTimelineRouter } from "../timeline.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_timeline";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// ---------------------------------------------------------------------------
// Sample test data — sessions
// ---------------------------------------------------------------------------

/** Session 1: newest, workspace ws-01, device dev-01 */
const SESSION_1 = {
  id: "sess-01",
  workspace_id: "ws-01",
  device_id: "dev-01",
  lifecycle: "parsed",
  started_at: "2025-01-15T14:00:00.000Z",
  ended_at: "2025-01-15T15:00:00.000Z",
  duration_ms: 3600000,
  summary: "Added dashboard feature",
  cost_estimate_usd: "0.50",
  total_messages: 20,
  tags: ["feature"],
  workspace_name: "user/repo",
  device_name: "macbook-pro",
};

/** Session 2: middle, workspace ws-01, device dev-01 */
const SESSION_2 = {
  id: "sess-02",
  workspace_id: "ws-01",
  device_id: "dev-01",
  lifecycle: "summarized",
  started_at: "2025-01-15T10:00:00.000Z",
  ended_at: "2025-01-15T11:00:00.000Z",
  duration_ms: 3600000,
  summary: "Fixed CSS bug",
  cost_estimate_usd: "0.25",
  total_messages: 10,
  tags: ["bugfix"],
  workspace_name: "user/repo",
  device_name: "macbook-pro",
};

/** Session 3: oldest, workspace ws-02, device dev-02 */
const SESSION_3 = {
  id: "sess-03",
  workspace_id: "ws-02",
  device_id: "dev-02",
  lifecycle: "ended",
  started_at: "2025-01-15T08:00:00.000Z",
  ended_at: "2025-01-15T09:00:00.000Z",
  duration_ms: 3600000,
  summary: null,
  cost_estimate_usd: null,
  total_messages: 5,
  tags: [],
  workspace_name: "user/other-repo",
  device_name: "linux-desktop",
};

const ALL_SESSIONS = [SESSION_1, SESSION_2, SESSION_3]; // newest first

// ---------------------------------------------------------------------------
// Sample test data — git activity linked to sessions
// ---------------------------------------------------------------------------

/** Commit linked to session 1 */
const GIT_COMMIT_S1 = {
  id: "ga-01",
  type: "commit",
  branch: "main",
  commit_sha: "abc123",
  message: "feat: add dashboard",
  files_changed: 3,
  insertions: 50,
  deletions: 10,
  timestamp: "2025-01-15T14:30:00.000Z",
  data: { author_name: "John", author_email: "john@example.com" },
  session_id: "sess-01",
};

/** Push linked to session 1 (later than the commit) */
const GIT_PUSH_S1 = {
  id: "ga-02",
  type: "push",
  branch: "main",
  commit_sha: "abc123",
  message: null,
  files_changed: null,
  insertions: null,
  deletions: null,
  timestamp: "2025-01-15T14:35:00.000Z",
  data: { remote: "origin", ref: "refs/heads/main" },
  session_id: "sess-01",
};

/** Checkout linked to session 2 */
const GIT_CHECKOUT_S2 = {
  id: "ga-03",
  type: "checkout",
  branch: "feature/fix-css",
  commit_sha: null,
  message: null,
  files_changed: null,
  insertions: null,
  deletions: null,
  timestamp: "2025-01-15T10:05:00.000Z",
  data: { previous_branch: "main" },
  session_id: "sess-02",
};

const ALL_SESSION_GIT = [GIT_COMMIT_S1, GIT_PUSH_S1, GIT_CHECKOUT_S2];

// ---------------------------------------------------------------------------
// Sample test data — orphan git activity (no session)
// ---------------------------------------------------------------------------

/** Orphan commit at 12:00 — between session 1 (14:00) and session 2 (10:00) */
const GIT_ORPHAN_COMMIT = {
  id: "ga-04",
  type: "commit",
  branch: "hotfix",
  commit_sha: "def456",
  message: "hotfix: fix typo",
  files_changed: 1,
  insertions: 1,
  deletions: 1,
  timestamp: "2025-01-15T12:00:00.000Z",
  data: { author_name: "John" },
  session_id: null,
  workspace_id: "ws-01",
  device_id: "dev-01",
  workspace_name: "user/repo",
  device_name: "macbook-pro",
};

/** Orphan merge at 12:05 — same group as orphan commit */
const GIT_ORPHAN_MERGE = {
  id: "ga-05",
  type: "merge",
  branch: "main",
  commit_sha: "ghi789",
  message: "Merge hotfix into main",
  files_changed: 1,
  insertions: 1,
  deletions: 1,
  timestamp: "2025-01-15T12:05:00.000Z",
  data: { source_branch: "hotfix" },
  session_id: null,
  workspace_id: "ws-01",
  device_id: "dev-01",
  workspace_name: "user/repo",
  device_name: "macbook-pro",
};

const ALL_ORPHAN_GIT = [GIT_ORPHAN_COMMIT, GIT_ORPHAN_MERGE];

// ---------------------------------------------------------------------------
// Mock SQL factory
// ---------------------------------------------------------------------------

/**
 * Build a mock postgres.js sql tagged template function.
 *
 * The real postgres.js sql is a function that acts as both:
 *   1. A tagged template literal: sql`SELECT * FROM ...`
 *   2. A helper function: sql({ col: val }) for SET, sql([a,b]) for IN
 *
 * Key difference from the sessions.test.ts mock: this version collects
 * ALL interpolated values from fragment composition, not just the outer
 * template values. This is needed because timeline queries compose WHERE
 * clause fragments via reduce, and the handler needs to see all values
 * (including those from inner fragments).
 *
 * Fragment calls (short template strings that are part of WHERE conditions)
 * return a marker object with the fragment text and values. These markers
 * are detected when they appear as values in the outer query, and their
 * text/values are merged into the outer query's text/values for matching.
 */
function buildMockSql(
  queryHandler: (queryText: string, values: unknown[]) => unknown[],
) {
  // Marker symbol to identify composed fragments
  const FRAGMENT_MARKER = Symbol("sql-fragment");

  interface SqlFragment {
    [key: symbol]: true;
    text: string;
    values: unknown[];
  }

  function isFragment(val: unknown): val is SqlFragment {
    return typeof val === "object" && val !== null && FRAGMENT_MARKER in val;
  }

  function sqlHelper(...args: unknown[]): unknown {
    return args[0];
  }

  function sqlTaggedTemplate(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): unknown {
    const rawText = strings.join("$");

    // Collect all values, flattening any fragments
    const allValues: unknown[] = [];
    let fullText = rawText;

    for (const v of values) {
      if (isFragment(v)) {
        // Merge fragment text and values into the outer query
        fullText += " " + v.text;
        allValues.push(...v.values);
      } else {
        allValues.push(v);
      }
    }

    // Heuristic: if this looks like a short fragment (not a full SELECT query),
    // return a fragment marker instead of executing the handler.
    // Full queries contain SELECT or UPDATE keywords.
    const isFullQuery = /SELECT|UPDATE|INSERT|DELETE/i.test(rawText);

    if (!isFullQuery) {
      // This is a fragment (e.g., sql`s.workspace_id = ${val}`)
      // Return a marker object so the outer query can collect it.
      const fragment: SqlFragment = {
        [FRAGMENT_MARKER]: true,
        text: fullText,
        values: allValues,
      };
      return fragment;
    }

    // This is a full query — execute the handler with collected text and values
    return Promise.resolve(queryHandler(fullText, allValues));
  }

  const proxy = new Proxy(sqlTaggedTemplate, {
    apply(_target, _thisArg, args) {
      if (args[0] && Array.isArray(args[0]) && "raw" in args[0]) {
        return sqlTaggedTemplate(
          args[0] as TemplateStringsArray,
          ...args.slice(1),
        );
      }
      return sqlHelper(...args);
    },
  });

  return proxy;
}

// ---------------------------------------------------------------------------
// Query handler — returns canned data based on SQL patterns
// ---------------------------------------------------------------------------

/**
 * Default query handler for the timeline tests.
 *
 * With the fragment-aware mock SQL, the queryText now includes merged text
 * from all composed fragments. This means WHERE conditions like
 * "s.workspace_id = $" and "ga.session_id IS NULL" appear in the text
 * even when they were composed via reduce.
 */
function defaultQueryHandler(queryText: string, values: unknown[]): unknown[] {
  // Step 1: Session list query
  if (
    queryText.includes("FROM sessions s") &&
    queryText.includes("JOIN workspaces w") &&
    queryText.includes("ORDER BY s.started_at DESC")
  ) {
    let result = [...ALL_SESSIONS];

    // Apply workspace_id filter
    if (queryText.includes("s.workspace_id =")) {
      const wsId = values.find((v) => typeof v === "string" && v.startsWith("ws-"));
      if (wsId) result = result.filter((s) => s.workspace_id === wsId);
    }
    // Apply device_id filter
    if (queryText.includes("s.device_id =")) {
      const devId = values.find((v) => typeof v === "string" && v.startsWith("dev-"));
      if (devId) result = result.filter((s) => s.device_id === devId);
    }
    // Apply after filter
    if (queryText.includes("s.started_at >")) {
      const afterTs = values.find(
        (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v),
      ) as string | undefined;
      if (afterTs) result = result.filter((s) => s.started_at > afterTs);
    }
    // Apply before filter
    if (queryText.includes("s.started_at <") && !queryText.includes("(s.started_at, s.id) <")) {
      // Find the before timestamp — skip the "after" timestamp if both are present
      const tsValues = values.filter(
        (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v),
      ) as string[];
      const beforeTs = queryText.includes("s.started_at >") ? tsValues[1] : tsValues[0];
      if (beforeTs) result = result.filter((s) => s.started_at < beforeTs);
    }

    return result;
  }

  // Step 2: Session git activity — has ga.session_id IN, no ga.workspace_id
  if (
    queryText.includes("FROM git_activity ga") &&
    queryText.includes("ga.session_id") &&
    !queryText.includes("ga.workspace_id")
  ) {
    // Find the types filter array — it contains git activity type names
    // (commit, push, checkout, merge), NOT session IDs. The sessionIds array
    // also appears in values, so we distinguish by checking array contents.
    const validTypes = new Set(["commit", "push", "checkout", "merge"]);
    const typeFilter = values.find(
      (v) => Array.isArray(v) && v.length > 0 && v.every((t) => validTypes.has(t)),
    ) as string[] | undefined;
    if (typeFilter) {
      return ALL_SESSION_GIT.filter((ga) => typeFilter.includes(ga.type));
    }
    return ALL_SESSION_GIT;
  }

  // Step 3: Orphan git activity — has ga.session_id IS NULL and ga.workspace_id
  if (
    queryText.includes("FROM git_activity ga") &&
    queryText.includes("ga.workspace_id")
  ) {
    let result = [...ALL_ORPHAN_GIT];

    const wsId = values.find((v) => typeof v === "string" && v.startsWith("ws-"));
    const devId = values.find((v) => typeof v === "string" && v.startsWith("dev-"));
    const typeFilter = values.find((v) => Array.isArray(v)) as string[] | undefined;

    if (wsId) result = result.filter((g) => g.workspace_id === wsId);
    if (devId) result = result.filter((g) => g.device_id === devId);
    if (typeFilter) result = result.filter((g) => typeFilter.includes(g.type));

    return result;
  }

  return [];
}

/**
 * Query handler that returns no sessions (empty database).
 */
function emptyQueryHandler(_queryText: string, _values: unknown[]): unknown[] {
  return [];
}

/**
 * Query handler for pagination tests — returns limit+1 to trigger has_more.
 * With the fragment-aware mock, cursor detection works via the merged text
 * containing "(s.started_at, s.id) <" from the keyset condition fragment.
 */
function paginationQueryHandler(queryText: string, values: unknown[]): unknown[] {
  // Session query
  if (
    queryText.includes("FROM sessions s") &&
    queryText.includes("ORDER BY s.started_at DESC")
  ) {
    // If cursor is present (keyset condition fragment merged into text), return next page
    if (queryText.includes("(s.started_at, s.id) <")) {
      return [SESSION_3];
    }
    // First page: return 3 sessions (limit is 2, so 3 = limit+1 triggers has_more)
    return [SESSION_1, SESSION_2, SESSION_3];
  }

  // Session git activity — has ga.session_id, no ga.workspace_id
  if (
    queryText.includes("FROM git_activity ga") &&
    queryText.includes("ga.session_id") &&
    !queryText.includes("ga.workspace_id")
  ) {
    return ALL_SESSION_GIT;
  }

  // Orphan git activity — has ga.workspace_id
  if (
    queryText.includes("FROM git_activity ga") &&
    queryText.includes("ga.workspace_id")
  ) {
    return ALL_ORPHAN_GIT;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function buildTestApp(
  queryHandler: (queryText: string, values: unknown[]) => unknown[],
) {
  const sql = buildMockSql(queryHandler);
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createAuthMiddleware(TEST_API_KEY));
  app.use(
    "/api",
    createTimelineRouter({
      sql: sql as any,
      logger,
    }),
  );
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// Test server lifecycle — default scenario (sessions + git activity)
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = buildTestApp(defaultQueryHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

async function get(
  path: string,
  headers: Record<string, string> = {},
  url?: string,
) {
  return fetch(`${url || baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: AUTH_HEADER, ...headers },
  });
}

/**
 * Helper to start a temporary server with a custom query handler.
 * Returns the base URL and a cleanup function.
 */
async function withCustomServer(
  handler: (queryText: string, values: unknown[]) => unknown[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = buildTestApp(handler);
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const addr = srv.address();
      const url = addr && typeof addr === "object"
        ? `http://127.0.0.1:${addr.port}`
        : "";
      resolve({
        url,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Empty database
// ---------------------------------------------------------------------------

describe("GET /api/timeline — empty database", () => {
  test("returns valid empty response", async () => {
    const { url, close } = await withCustomServer(emptyQueryHandler);
    try {
      const res = await get("/api/timeline", {}, url);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.items).toEqual([]);
      expect(body.next_cursor).toBeNull();
      expect(body.has_more).toBe(false);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Sessions without git activity
// ---------------------------------------------------------------------------

describe("GET /api/timeline — sessions without git activity", () => {
  test("returns session items with empty git_activity arrays", async () => {
    // Use a handler that returns sessions but no git activity
    const noGitHandler = (queryText: string, values: unknown[]): unknown[] => {
      if (
        queryText.includes("FROM sessions s") &&
        queryText.includes("ORDER BY s.started_at DESC")
      ) {
        return ALL_SESSIONS;
      }
      // No git activity
      return [];
    };

    const { url, close } = await withCustomServer(noGitHandler);
    try {
      const res = await get("/api/timeline", {}, url);
      expect(res.status).toBe(200);

      const body = await res.json();
      // Should have 3 session items (no orphans since no orphan git activity)
      const sessionItems = body.items.filter((i: any) => i.type === "session");
      expect(sessionItems.length).toBe(3);

      // Each session should have an empty git_activity array
      for (const item of sessionItems) {
        expect(item.git_activity).toEqual([]);
      }
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Session with commits
// ---------------------------------------------------------------------------

describe("GET /api/timeline — session with commits", () => {
  test("embeds commit data in session git_activity array", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Find session 1 which has commits and a push
    const sess1Item = body.items.find(
      (i: any) => i.type === "session" && i.session.id === "sess-01",
    );
    expect(sess1Item).toBeDefined();
    expect(sess1Item.git_activity.length).toBe(2);

    // First git activity should be the commit (earlier timestamp)
    const commit = sess1Item.git_activity.find((g: any) => g.type === "commit");
    expect(commit).toBeDefined();
    expect(commit.commit_sha).toBe("abc123");
    expect(commit.message).toBe("feat: add dashboard");
    expect(commit.branch).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// 4. Orphan git events
// ---------------------------------------------------------------------------

describe("GET /api/timeline — orphan git events", () => {
  test("returns orphan events as type=git_activity items", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();

    const orphanItems = body.items.filter((i: any) => i.type === "git_activity");
    expect(orphanItems.length).toBeGreaterThanOrEqual(1);

    const orphanItem = orphanItems[0];
    expect(orphanItem.workspace_id).toBe("ws-01");
    expect(orphanItem.workspace_name).toBe("user/repo");
    expect(orphanItem.device_id).toBe("dev-01");
    expect(orphanItem.device_name).toBe("macbook-pro");
    expect(orphanItem.git_activity.length).toBe(2);
    expect(orphanItem.started_at).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Interleaving: ordered by timestamp
// ---------------------------------------------------------------------------

describe("GET /api/timeline — interleaving", () => {
  test("items are ordered by timestamp newest first", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Extract sort timestamps from items
    const timestamps = body.items.map((item: any) => {
      if (item.type === "session") {
        return new Date(item.session.started_at).getTime();
      }
      return new Date(item.started_at).getTime();
    });

    // Verify descending order
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1]);
    }
  });

  test("orphan items appear between sessions based on timestamp", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Session 1 at 14:00, orphan at 12:00, session 2 at 10:00, session 3 at 08:00
    // Order should be: sess-01, orphan, sess-02, sess-03
    expect(body.items.length).toBeGreaterThanOrEqual(4);

    // First should be session 1 (14:00)
    expect(body.items[0].type).toBe("session");
    expect(body.items[0].session.id).toBe("sess-01");

    // Second should be orphan git activity (12:00)
    expect(body.items[1].type).toBe("git_activity");

    // Third should be session 2 (10:00)
    expect(body.items[2].type).toBe("session");
    expect(body.items[2].session.id).toBe("sess-02");
  });
});

// ---------------------------------------------------------------------------
// 6. workspace_id filter
// ---------------------------------------------------------------------------

describe("GET /api/timeline — workspace_id filter", () => {
  test("filters sessions and orphans by workspace_id", async () => {
    const res = await get("/api/timeline?workspace_id=ws-02");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Only session 3 is in ws-02
    const sessionItems = body.items.filter((i: any) => i.type === "session");
    expect(sessionItems.length).toBe(1);
    expect(sessionItems[0].session.workspace_id).toBe("ws-02");
  });
});

// ---------------------------------------------------------------------------
// 7. device_id filter
// ---------------------------------------------------------------------------

describe("GET /api/timeline — device_id filter", () => {
  test("filters sessions by device_id", async () => {
    const res = await get("/api/timeline?device_id=dev-02");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Only session 3 is on dev-02
    const sessionItems = body.items.filter((i: any) => i.type === "session");
    expect(sessionItems.length).toBe(1);
    expect(sessionItems[0].session.device_id).toBe("dev-02");
  });
});

// ---------------------------------------------------------------------------
// 8. after filter
// ---------------------------------------------------------------------------

describe("GET /api/timeline — after filter", () => {
  test("only returns sessions started after the given timestamp", async () => {
    const res = await get("/api/timeline?after=2025-01-15T11:00:00.000Z");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Only session 1 (14:00) started after 11:00
    const sessionItems = body.items.filter((i: any) => i.type === "session");
    expect(sessionItems.length).toBe(1);
    expect(sessionItems[0].session.id).toBe("sess-01");
  });
});

// ---------------------------------------------------------------------------
// 9. before filter
// ---------------------------------------------------------------------------

describe("GET /api/timeline — before filter", () => {
  test("only returns sessions started before the given timestamp", async () => {
    const res = await get("/api/timeline?before=2025-01-15T09:00:00.000Z");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Only session 3 (08:00) started before 09:00
    const sessionItems = body.items.filter((i: any) => i.type === "session");
    expect(sessionItems.length).toBe(1);
    expect(sessionItems[0].session.id).toBe("sess-03");
  });
});

// ---------------------------------------------------------------------------
// 10. types=commit filter
// ---------------------------------------------------------------------------

describe("GET /api/timeline — types filter", () => {
  test("only includes matching git activity types", async () => {
    const res = await get("/api/timeline?types=commit");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Session 1 has a commit and a push; with types=commit, only commit should appear
    const sess1 = body.items.find(
      (i: any) => i.type === "session" && i.session.id === "sess-01",
    );
    if (sess1) {
      // All git activity in session items should be commits only
      for (const ga of sess1.git_activity) {
        expect(ga.type).toBe("commit");
      }
    }

    // Orphan items should also only include commits (no merges)
    const orphans = body.items.filter((i: any) => i.type === "git_activity");
    for (const orphan of orphans) {
      for (const ga of orphan.git_activity) {
        expect(ga.type).toBe("commit");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Pagination
// ---------------------------------------------------------------------------

describe("GET /api/timeline — pagination", () => {
  test("limit=2 returns has_more=true and a cursor", async () => {
    const { url, close } = await withCustomServer(paginationQueryHandler);
    try {
      const res = await get("/api/timeline?limit=2", {}, url);
      expect(res.status).toBe(200);

      const body = await res.json();

      // Should have exactly 2 session items (limit=2, handler returns 3)
      const sessionItems = body.items.filter((i: any) => i.type === "session");
      expect(sessionItems.length).toBe(2);
      expect(body.has_more).toBe(true);
      expect(body.next_cursor).not.toBeNull();

      // Decode the cursor and verify it contains the last session's data
      const decoded = JSON.parse(
        Buffer.from(body.next_cursor, "base64").toString("utf-8"),
      );
      expect(decoded.s).toBe(SESSION_2.started_at);
      expect(decoded.i).toBe(SESSION_2.id);
    } finally {
      await close();
    }
  });

  test("using cursor returns next page with no duplicates", async () => {
    const { url, close } = await withCustomServer(paginationQueryHandler);
    try {
      // First page
      const res1 = await get("/api/timeline?limit=2", {}, url);
      const body1 = await res1.json();
      const firstPageIds = body1.items
        .filter((i: any) => i.type === "session")
        .map((i: any) => i.session.id);

      // Second page using cursor
      const res2 = await get(
        `/api/timeline?limit=2&cursor=${body1.next_cursor}`,
        {},
        url,
      );
      expect(res2.status).toBe(200);

      const body2 = await res2.json();
      const secondPageIds = body2.items
        .filter((i: any) => i.type === "session")
        .map((i: any) => i.session.id);

      // No overlap between pages
      for (const id of secondPageIds) {
        expect(firstPageIds).not.toContain(id);
      }

      // Second page should have session 3 and has_more=false
      expect(secondPageIds).toContain("sess-03");
      expect(body2.has_more).toBe(false);
      expect(body2.next_cursor).toBeNull();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Invalid cursor
// ---------------------------------------------------------------------------

describe("GET /api/timeline — invalid cursor", () => {
  test("returns 400 for invalid cursor", async () => {
    const res = await get("/api/timeline?cursor=not-valid-json");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid cursor");
  });

  test("returns 400 for cursor with missing fields", async () => {
    const badCursor = Buffer.from(JSON.stringify({ x: "y" })).toString("base64");
    const res = await get(`/api/timeline?cursor=${badCursor}`);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid cursor");
  });
});

// ---------------------------------------------------------------------------
// 13. Session with multiple git events
// ---------------------------------------------------------------------------

describe("GET /api/timeline — multiple git events per session", () => {
  test("all git events appear in session git_activity ordered by timestamp", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Session 1 has both a commit and a push
    const sess1 = body.items.find(
      (i: any) => i.type === "session" && i.session.id === "sess-01",
    );
    expect(sess1).toBeDefined();
    expect(sess1.git_activity.length).toBe(2);

    // Verify timestamp ordering (ASC within session)
    const ts0 = new Date(sess1.git_activity[0].timestamp).getTime();
    const ts1 = new Date(sess1.git_activity[1].timestamp).getTime();
    expect(ts0).toBeLessThanOrEqual(ts1);
  });
});

// ---------------------------------------------------------------------------
// 14. Git activity data field
// ---------------------------------------------------------------------------

describe("GET /api/timeline — git activity data field", () => {
  test("data field is populated on git activity entries", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();

    // Check session git activity data
    const sess1 = body.items.find(
      (i: any) => i.type === "session" && i.session.id === "sess-01",
    );
    expect(sess1).toBeDefined();

    const commit = sess1.git_activity.find((g: any) => g.type === "commit");
    expect(commit).toBeDefined();
    expect(commit.data).toBeDefined();
    expect(commit.data.author_name).toBe("John");

    // Check orphan git activity data
    const orphan = body.items.find((i: any) => i.type === "git_activity");
    expect(orphan).toBeDefined();
    const orphanCommit = orphan.git_activity.find((g: any) => g.type === "commit");
    expect(orphanCommit).toBeDefined();
    expect(orphanCommit.data).toBeDefined();
    expect(orphanCommit.data.author_name).toBe("John");
  });
});

// ---------------------------------------------------------------------------
// 15. Auth required
// ---------------------------------------------------------------------------

describe("GET /api/timeline — auth", () => {
  test("returns 401 without Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/timeline`, {
      method: "GET",
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Missing or invalid API key");
  });

  test("returns 401 with wrong Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/timeline`, {
      method: "GET",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Response shape validation
// ---------------------------------------------------------------------------

describe("GET /api/timeline — response shape", () => {
  test("session items have correct shape", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();
    const sessionItem = body.items.find((i: any) => i.type === "session");
    expect(sessionItem).toBeDefined();

    // Verify session fields
    const s = sessionItem.session;
    expect(s).toHaveProperty("id");
    expect(s).toHaveProperty("workspace_id");
    expect(s).toHaveProperty("workspace_name");
    expect(s).toHaveProperty("device_id");
    expect(s).toHaveProperty("device_name");
    expect(s).toHaveProperty("lifecycle");
    expect(s).toHaveProperty("started_at");
    expect(s).toHaveProperty("ended_at");
    expect(s).toHaveProperty("duration_ms");
    expect(s).toHaveProperty("summary");
    expect(s).toHaveProperty("cost_estimate_usd");
    expect(s).toHaveProperty("total_messages");
    expect(s).toHaveProperty("tags");

    // Verify git_activity is an array
    expect(Array.isArray(sessionItem.git_activity)).toBe(true);
  });

  test("git activity entries have correct shape", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();
    const sessWithGit = body.items.find(
      (i: any) => i.type === "session" && i.git_activity.length > 0,
    );
    expect(sessWithGit).toBeDefined();

    const ga = sessWithGit.git_activity[0];
    expect(ga).toHaveProperty("id");
    expect(ga).toHaveProperty("type");
    expect(ga).toHaveProperty("branch");
    expect(ga).toHaveProperty("commit_sha");
    expect(ga).toHaveProperty("message");
    expect(ga).toHaveProperty("files_changed");
    expect(ga).toHaveProperty("timestamp");
    expect(ga).toHaveProperty("data");
  });

  test("orphan git_activity items have correct shape", async () => {
    const res = await get("/api/timeline");
    expect(res.status).toBe(200);

    const body = await res.json();
    const orphanItem = body.items.find((i: any) => i.type === "git_activity");
    expect(orphanItem).toBeDefined();

    expect(orphanItem).toHaveProperty("type", "git_activity");
    expect(orphanItem).toHaveProperty("workspace_id");
    expect(orphanItem).toHaveProperty("workspace_name");
    expect(orphanItem).toHaveProperty("device_id");
    expect(orphanItem).toHaveProperty("device_name");
    expect(orphanItem).toHaveProperty("git_activity");
    expect(orphanItem).toHaveProperty("started_at");
    expect(Array.isArray(orphanItem.git_activity)).toBe(true);
  });
});
