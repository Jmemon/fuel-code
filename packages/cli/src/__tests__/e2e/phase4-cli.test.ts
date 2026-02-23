/**
 * Phase 4 E2E integration tests — CLI command tests.
 *
 * Tests 1-14: Verify sessions, session detail, timeline, workspaces,
 * and status commands against a real Postgres + Redis backend with
 * seeded fixture data.
 *
 * Approach: construct a FuelApiClient pointed at the test server, then
 * call the exported data-fetching + formatting functions from each
 * command module. This tests the complete data layer and presentation
 * layer without needing a config file.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { setupTestServer, type TestServerContext } from "./setup.js";
import { createTestClient, stripAnsi } from "./helpers.js";
import type { FuelApiClient } from "../../lib/api-client.js";

// Import data-fetching and formatting functions from each command module
import { fetchSessions, formatSessionsTable } from "../../commands/sessions.js";
import {
  fetchSessionDetail,
  fetchSessionTranscript,
  fetchSessionGit,
  fetchSessionExportData,
  formatSessionSummary,
  formatSessionGitActivity,
} from "../../commands/session-detail.js";
import { fetchTimeline, formatTimeline } from "../../commands/timeline.js";
import {
  fetchWorkspaces,
  fetchWorkspaceDetail,
  formatWorkspacesTable,
  formatWorkspaceDetail,
} from "../../commands/workspaces.js";
import { fetchStatus, formatStatus } from "../../commands/status.js";
import { renderTranscript } from "../../lib/transcript-renderer.js";

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let ctx: TestServerContext;
let api: FuelApiClient;

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await setupTestServer();
  api = createTestClient(ctx.baseUrl, ctx.apiKey);
}, 30_000);

afterAll(async () => {
  if (ctx?.cleanup) {
    await ctx.cleanup();
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Tests 1-4: Sessions command
// ---------------------------------------------------------------------------

describe("Sessions command", () => {
  test("Test 1: sessions shows all 8 sessions with workspace names and status icons", async () => {
    const result = await fetchSessions(api, { limit: 50 });

    expect(result.sessions.length).toBe(8);

    const output = stripAnsi(formatSessionsTable(result.sessions));

    // Check workspace names appear
    expect(output).toContain("fuel-code");
    expect(output).toContain("api-service");
    expect(output).toContain("_unassociated");

    // Check that table headers are rendered
    expect(output).toContain("STATUS");
    expect(output).toContain("WORKSPACE");
    expect(output).toContain("DEVICE");

    // Check status icons appear: LIVE for capturing, DONE for summarized, FAIL for failed
    expect(output).toContain("LIVE");
    expect(output).toContain("DONE");
    expect(output).toContain("FAIL");
  }, 15_000);

  test("Test 2: sessions --workspace fuel-code shows only fuel-code sessions", async () => {
    // Resolve workspace name to ID via the API (same as CLI does)
    const workspaceId = await api.resolveWorkspaceName("fuel-code");
    const result = await fetchSessions(api, { workspaceId, limit: 50 });

    // fuel-code has 4 sessions: sess_1_capturing, sess_2_summarized, sess_3_summarized, sess_4_failed
    expect(result.sessions.length).toBe(4);

    // All sessions should belong to the fuel-code workspace
    for (const s of result.sessions) {
      expect(s.workspace_id).toBe(ctx.fixtures.ws_fuel_code);
    }
  }, 15_000);

  test("Test 3: sessions --today shows all seeded sessions", async () => {
    // All fixture sessions have today's date
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const result = await fetchSessions(api, { after: today.toISOString(), limit: 50 });

    expect(result.sessions.length).toBe(8);
  }, 15_000);

  test("Test 4: sessions --json returns valid JSON with required fields", async () => {
    const result = await fetchSessions(api, { limit: 50 });

    // The result should be a proper object with sessions array
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(result.sessions.length).toBe(8);

    // Each session should have the required fields
    for (const session of result.sessions) {
      expect(session.id).toBeTruthy();
      expect(session.workspace_id).toBeTruthy();
      expect(session.device_id).toBeTruthy();
      expect(session.lifecycle).toBeTruthy();
      expect(session.started_at).toBeTruthy();
    }

    // Verify JSON serialization works
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.sessions.length).toBe(8);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Tests 5-9: Session detail command
// ---------------------------------------------------------------------------

describe("Session detail command", () => {
  test("Test 5: session <id> shows summary card with metadata fields", async () => {
    const session = await fetchSessionDetail(api, ctx.fixtures.sess_2_summarized);
    const output = stripAnsi(formatSessionSummary(session));

    // Check key metadata fields are present
    expect(output).toContain("Session Detail");
    expect(output).toContain(ctx.fixtures.sess_2_summarized);
    expect(output).toContain("fuel-code");
    expect(output).toContain("macbook-pro");
    expect(output).toContain("DONE");
    expect(output).toContain("Fixed authentication flow");

    // Check Duration field is present with value (Cost removed — tokens shown in Stats section)
    expect(output).toContain("Duration:");
    expect(output).toContain("45m");
  }, 15_000);

  test("Test 6: session <id> --transcript shows conversation turns with tool trees", async () => {
    const messages = await fetchSessionTranscript(api, ctx.fixtures.sess_2_summarized);

    // Session 2 has 8 transcript messages seeded
    expect(messages.length).toBe(8);

    // Render the transcript and check it contains expected content
    const output = stripAnsi(renderTranscript(messages as any));

    // Should contain Human and Assistant turn labels
    expect(output).toContain("Human");
    expect(output).toContain("Assistant");

    // Should contain tool use names from the seeded tool_use content blocks.
    // Tools cycle as toolNames[i % 4] for assistant messages (odd i, i>0):
    // i=1 -> Edit, i=3 -> Grep, i=5 -> Edit, i=7 -> Grep
    expect(output).toContain("Edit");
    expect(output).toContain("Grep");
  }, 15_000);

  test("Test 7: session <id> --git shows git activity table", async () => {
    const gitActivity = await fetchSessionGit(api, ctx.fixtures.sess_2_summarized);

    // Session 2 has 3 git activities: 2 commits + 1 push
    expect(gitActivity.length).toBe(3);

    const output = stripAnsi(formatSessionGitActivity(gitActivity));

    // Check commit messages appear
    expect(output).toContain("auth token validation");
    expect(output).toContain("refresh token flow");
    // Check commit hash prefixes (7-char prefix from formatSessionGitActivity)
    expect(output).toContain("abc1234");
    expect(output).toContain("def4567");
    // Check push info
    expect(output).toContain("push");
    expect(output).toContain("feat/auth");
  }, 15_000);

  test("Test 8: session <id> --export json writes valid JSON file", async () => {
    const data = await fetchSessionExportData(api, ctx.fixtures.sess_2_summarized);

    // Verify the export data structure
    expect(data.session).toBeTruthy();
    expect(data.session.id).toBe(ctx.fixtures.sess_2_summarized);
    expect(data.transcript).toBeTruthy();
    expect(Array.isArray(data.transcript)).toBe(true);
    expect(data.events).toBeTruthy();
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.git_activity).toBeTruthy();
    expect(Array.isArray(data.git_activity)).toBe(true);
    expect(data.exported_at).toBeTruthy();

    // Write to a temp file and verify it's valid JSON
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-e2e-"));
    const filePath = path.join(tmpDir, `session-export.json`);

    try {
      const content = JSON.stringify(data, null, 2);
      fs.writeFileSync(filePath, content, "utf-8");

      // Read back and parse
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.session.id).toBe(ctx.fixtures.sess_2_summarized);
      expect(parsed.transcript.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("Test 9: session <id> --tag adds tag and verifies via API", async () => {
    // Fetch the session before tagging to capture original state
    const before = await fetchSessionDetail(api, ctx.fixtures.sess_5_parsed);
    const tagsBefore: string[] = (before as any).tags ?? [];

    try {
      // Add a tag via the API (same as CLI --tag does)
      const newTag = "test-e2e";
      const newTags = [...tagsBefore, newTag];
      await api.updateSession(ctx.fixtures.sess_5_parsed, { tags: newTags });

      // Verify the tag was added
      const after = await fetchSessionDetail(api, ctx.fixtures.sess_5_parsed);
      expect((after as any).tags).toContain("test-e2e");
    } finally {
      // Restore original tags so we don't pollute shared fixture data
      await api.updateSession(ctx.fixtures.sess_5_parsed, { tags: tagsBefore });
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 10: Timeline command
// ---------------------------------------------------------------------------

describe("Timeline command", () => {
  test("Test 10: timeline shows session-grouped activity feed", async () => {
    // Fetch today's timeline (default behavior)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const data = await fetchTimeline(api, { after: today.toISOString() });

    // Should have timeline items (sessions and possibly orphan git)
    expect(data.items.length).toBeGreaterThan(0);

    const output = stripAnsi(formatTimeline(data));

    // Should contain workspace names from our fixtures
    expect(output).toContain("fuel-code");
    expect(output).toContain("api-service");

    // Should contain the stats footer with session count
    expect(output).toContain("session");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Tests 11-12: Workspaces command
// ---------------------------------------------------------------------------

describe("Workspaces command", () => {
  test("Test 11: workspaces shows table with all 3 workspaces", async () => {
    const workspaces = await fetchWorkspaces(api);

    expect(workspaces.length).toBe(3);

    const output = stripAnsi(formatWorkspacesTable(workspaces));

    // Check all workspace names appear
    expect(output).toContain("fuel-code");
    expect(output).toContain("api-service");
    expect(output).toContain("_unassociated");

    // Check table headers
    expect(output).toContain("WORKSPACE");
    expect(output).toContain("SESSIONS");
  }, 15_000);

  test("Test 12: workspace fuel-code shows workspace detail view", async () => {
    const workspaceId = await api.resolveWorkspaceName("fuel-code");
    const detail = await fetchWorkspaceDetail(api, workspaceId);

    const output = stripAnsi(formatWorkspaceDetail(detail));

    // Check workspace header
    expect(output).toContain("fuel-code");
    expect(output).toContain("github.com/user/fuel-code");

    // Check devices section
    expect(output).toContain("Devices:");
    expect(output).toContain("macbook-pro");

    // Check recent sessions section
    expect(output).toContain("Recent Sessions:");

    // Check git activity section
    expect(output).toContain("Git Activity:");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 13: Status command
// ---------------------------------------------------------------------------

describe("Status command", () => {
  test("Test 13: status shows status card with backend connection", async () => {
    // fetchStatus requires a FuelCodeConfig — we construct one matching the test server
    const config = {
      device: { id: ctx.fixtures.dev_macbook, name: "macbook-pro", type: "local" as const },
      backend: { url: ctx.baseUrl, api_key: ctx.apiKey },
      pipeline: { queue_dir: "/tmp/fuel-code-test-queue", post_timeout_ms: 10_000, batch_size: 50, max_retries: 3 },
    };

    const statusApi = createTestClient(ctx.baseUrl, ctx.apiKey);
    const data = await fetchStatus(statusApi, config as any);

    // Check backend is connected
    expect(data.backend.status).toBe("connected");
    expect(data.backend.latencyMs).toBeDefined();

    // Check recent sessions exist
    expect(data.recentSessions.length).toBeGreaterThan(0);

    // Check today's stats
    expect(data.today).toBeDefined();
    expect(data.today!.sessionCount).toBeGreaterThan(0);

    // Format and check output
    const output = stripAnsi(formatStatus(data));
    expect(output).toContain("fuel-code status");
    expect(output).toContain("Connected");
    expect(output).toContain("macbook-pro");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Test 14: Error handling — nonexistent session
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  test("Test 14: session nonexistent-id returns error", async () => {
    const fakeId = "01ZZZZZZZZZZZZZZZZZZZZZZZZ";
    try {
      await fetchSessionDetail(api, fakeId);
      // Should not reach here
      throw new Error("Expected fetchSessionDetail to throw for nonexistent ID");
    } catch (err: any) {
      if (err.message?.includes("Expected fetchSessionDetail")) throw err;
      // The API should return a 404 or similar error containing "not found"
      expect(err.message).toBeTruthy();
      expect(err.message.toLowerCase()).toContain("not found");
    }
  }, 15_000);
});
