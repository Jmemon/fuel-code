/**
 * Unit tests for per-teammate summary generation.
 *
 * Tests generateTeammateSummaries() by mocking the database queries and the
 * generateSummary function. Validates:
 *   1. Skips silently when summaries are disabled
 *   2. Skips silently when no API key is configured
 *   3. Skips silently when no teammates exist in the session
 *   4. Sets "No recorded activity" for teammates with zero messages
 *   5. Calls generateSummary and persists the result on success
 *   6. Handles generateSummary failure without blocking other teammates
 *   7. Handles individual teammate errors without blocking the rest
 *   8. Returns results array with per-teammate outcomes
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { SummaryConfig } from "../../summary-generator.js";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

// We mock the summary-generator module so generateSummary doesn't call the
// real Anthropic API. renderTranscriptForSummary is also imported but its
// return value isn't critical for these tests.
const mockGenerateSummary = mock(() =>
  Promise.resolve({ success: true, summary: "Did some work on the backend." }),
);
mock.module("../../summary-generator.js", () => ({
  generateSummary: mockGenerateSummary,
}));

// Import after mocking so the mocked module is used
const { generateTeammateSummaries } = await import("../teammate-summary.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a default SummaryConfig for tests (enabled with a fake API key) */
function makeConfig(overrides?: Partial<SummaryConfig>): SummaryConfig {
  return {
    enabled: true,
    model: "claude-sonnet-4-5-20250929",
    temperature: 0.3,
    maxOutputTokens: 150,
    apiKey: "sk-test-key",
    ...overrides,
  };
}

/** Minimal mock logger that captures nothing */
function makeLogger() {
  const noop = () => {};
  const child = () => makeLogger();
  return { debug: noop, info: noop, warn: noop, error: noop, child } as any;
}

/**
 * Create a mock SQL tagged template function.
 *
 * queryResults is a map from a substring match on the SQL query to the
 * rows that should be returned. The mock checks which key is found in
 * the query string and returns the corresponding rows.
 *
 * updateTracker is an array that accumulates UPDATE calls for assertion.
 */
function makeMockSql(
  queryResults: Record<string, any[]>,
  updateTracker?: { query: string; values: any[] }[],
) {
  const sqlFn = (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");

    // Track UPDATE calls
    if (query.includes("UPDATE") && updateTracker) {
      updateTracker.push({ query, values });
    }

    // Match query to result set
    for (const [pattern, rows] of Object.entries(queryResults)) {
      if (query.includes(pattern)) {
        return Promise.resolve(rows);
      }
    }

    // Default: return empty array
    return Promise.resolve([]);
  };

  return sqlFn as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateTeammateSummaries", () => {
  beforeEach(() => {
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockImplementation(() =>
      Promise.resolve({ success: true, summary: "Did some work on the backend." }),
    );
  });

  test("returns empty results when summaries are disabled", async () => {
    const sql = makeMockSql({});
    const config = makeConfig({ enabled: false });
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toEqual([]);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  test("returns empty results when no API key configured", async () => {
    const sql = makeMockSql({});
    const config = makeConfig({ apiKey: "" });
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toEqual([]);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  test("returns empty results when no teammates found", async () => {
    const sql = makeMockSql({
      "FROM teammates": [],
    });
    const config = makeConfig();
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toEqual([]);
    expect(mockGenerateSummary).not.toHaveBeenCalled();
  });

  test("sets 'No recorded activity' for teammates with zero messages", async () => {
    const updates: { query: string; values: any[] }[] = [];
    const sql = makeMockSql(
      {
        "FROM teammates": [
          { id: "tm-1", entity_name: "alice", role: "member", entity_type: "agent" },
        ],
        "FROM transcript_messages": [],
        "FROM content_blocks": [],
      },
      updates,
    );
    const config = makeConfig();
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      teammateId: "tm-1",
      entityName: "alice",
      success: true,
      summary: "No recorded activity",
    });

    // Verify the UPDATE was called with the right summary text
    const updateCall = updates.find((u) => u.query.includes("UPDATE teammates"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.values).toContain("No recorded activity");
  });

  test("generates and persists summary for teammate with messages", async () => {
    const updates: { query: string; values: any[] }[] = [];

    // Fake messages and blocks to return from DB
    const fakeMessages = [
      {
        id: "msg-1", session_id: "sess-1", teammate_id: "tm-1",
        line_number: 1, ordinal: 1, message_type: "assistant", role: "assistant",
        model: "claude-sonnet-4-5-20250929", tokens_in: 100, tokens_out: 50,
        cache_read: null, cache_write: null, cost_usd: null,
        compact_sequence: 0, is_compacted: false,
        timestamp: "2026-03-03T10:00:00Z", raw_message: null, metadata: {},
        has_text: true, has_thinking: false, has_tool_use: false, has_tool_result: false,
      },
    ];
    const fakeBlocks = [
      {
        id: "blk-1", message_id: "msg-1", session_id: "sess-1", teammate_id: "tm-1",
        block_order: 0, block_type: "text", content_text: "Hello world",
        thinking_text: null, tool_name: null, tool_use_id: null, tool_input: null,
        tool_result_id: null, is_error: false, result_text: null,
        result_s3_key: null, metadata: {},
      },
    ];

    const sql = makeMockSql(
      {
        "FROM teammates": [
          { id: "tm-1", entity_name: "backend-worker", role: "member", entity_type: "agent" },
        ],
        "FROM transcript_messages": fakeMessages,
        "FROM content_blocks": fakeBlocks,
      },
      updates,
    );
    const config = makeConfig();
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      teammateId: "tm-1",
      entityName: "backend-worker",
      success: true,
      summary: "Did some work on the backend.",
    });

    // Verify generateSummary was called with overridden maxOutputTokens
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateSummary.mock.calls[0];
    expect(callArgs[2].maxOutputTokens).toBe(100);

    // Verify the UPDATE was called
    const updateCall = updates.find((u) => u.query.includes("UPDATE teammates"));
    expect(updateCall).toBeDefined();
  });

  test("handles generateSummary failure without blocking other teammates", async () => {
    // First call fails, second succeeds
    let callCount = 0;
    mockGenerateSummary.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ success: false, error: "Rate limited" });
      }
      return Promise.resolve({ success: true, summary: "Worked on frontend." });
    });

    const sql = makeMockSql({
      "FROM teammates": [
        { id: "tm-1", entity_name: "alice", role: "member", entity_type: "agent" },
        { id: "tm-2", entity_name: "bob", role: "member", entity_type: "agent" },
      ],
      "FROM transcript_messages": [
        {
          id: "msg-1", session_id: "sess-1", teammate_id: "tm-1",
          line_number: 1, ordinal: 1, message_type: "assistant", role: "assistant",
          model: null, tokens_in: null, tokens_out: null,
          cache_read: null, cache_write: null, cost_usd: null,
          compact_sequence: 0, is_compacted: false,
          timestamp: null, raw_message: null, metadata: {},
          has_text: true, has_thinking: false, has_tool_use: false, has_tool_result: false,
        },
      ],
      "FROM content_blocks": [],
    });
    const config = makeConfig();
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toHaveLength(2);

    // First teammate failed
    expect(results[0].teammateId).toBe("tm-1");
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("Rate limited");

    // Second teammate succeeded
    expect(results[1].teammateId).toBe("tm-2");
    expect(results[1].success).toBe(true);
    expect(results[1].summary).toBe("Worked on frontend.");
  });

  test("handles thrown error for individual teammate without blocking others", async () => {
    // First teammate's message query throws, second succeeds
    let teammateQueryCount = 0;
    const sql = (strings: TemplateStringsArray, ...values: any[]) => {
      const query = strings.join("?");

      if (query.includes("FROM teammates")) {
        return Promise.resolve([
          { id: "tm-1", entity_name: "crasher", role: "member", entity_type: "agent" },
          { id: "tm-2", entity_name: "stable", role: "member", entity_type: "agent" },
        ]);
      }

      if (query.includes("FROM transcript_messages")) {
        teammateQueryCount++;
        if (teammateQueryCount === 1) {
          return Promise.reject(new Error("DB connection lost"));
        }
        return Promise.resolve([
          {
            id: "msg-2", session_id: "sess-1", teammate_id: "tm-2",
            line_number: 1, ordinal: 1, message_type: "assistant", role: "assistant",
            model: null, tokens_in: null, tokens_out: null,
            cache_read: null, cache_write: null, cost_usd: null,
            compact_sequence: 0, is_compacted: false,
            timestamp: null, raw_message: null, metadata: {},
            has_text: true, has_thinking: false, has_tool_use: false, has_tool_result: false,
          },
        ]);
      }

      if (query.includes("FROM content_blocks")) {
        return Promise.resolve([]);
      }

      if (query.includes("UPDATE")) {
        return Promise.resolve([]);
      }

      return Promise.resolve([]);
    };

    const config = makeConfig();
    const deps = { sql: sql as any, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toHaveLength(2);

    // First teammate errored
    expect(results[0].teammateId).toBe("tm-1");
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("DB connection lost");

    // Second teammate succeeded
    expect(results[1].teammateId).toBe("tm-2");
    expect(results[1].success).toBe(true);
  });

  test("sets fallback summary when generateSummary returns success with no summary", async () => {
    mockGenerateSummary.mockImplementation(() =>
      Promise.resolve({ success: true, summary: undefined }),
    );

    const updates: { query: string; values: any[] }[] = [];
    const sql = makeMockSql(
      {
        "FROM teammates": [
          { id: "tm-1", entity_name: "quiet-agent", role: "member", entity_type: "agent" },
        ],
        "FROM transcript_messages": [
          {
            id: "msg-1", session_id: "sess-1", teammate_id: "tm-1",
            line_number: 1, ordinal: 1, message_type: "assistant", role: "assistant",
            model: null, tokens_in: null, tokens_out: null,
            cache_read: null, cache_write: null, cost_usd: null,
            compact_sequence: 0, is_compacted: false,
            timestamp: null, raw_message: null, metadata: {},
            has_text: false, has_thinking: false, has_tool_use: false, has_tool_result: false,
          },
        ],
        "FROM content_blocks": [],
      },
      updates,
    );
    const config = makeConfig();
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    const results = await generateTeammateSummaries(deps, "sess-1");

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].summary).toBe("No recorded activity");
  });

  test("passes overridden maxOutputTokens (100) to generateSummary", async () => {
    const sql = makeMockSql({
      "FROM teammates": [
        { id: "tm-1", entity_name: "alice", role: "member", entity_type: "agent" },
      ],
      "FROM transcript_messages": [
        {
          id: "msg-1", session_id: "sess-1", teammate_id: "tm-1",
          line_number: 1, ordinal: 1, message_type: "assistant", role: "assistant",
          model: null, tokens_in: null, tokens_out: null,
          cache_read: null, cache_write: null, cost_usd: null,
          compact_sequence: 0, is_compacted: false,
          timestamp: null, raw_message: null, metadata: {},
          has_text: true, has_thinking: false, has_tool_use: false, has_tool_result: false,
        },
      ],
      "FROM content_blocks": [],
    });
    const config = makeConfig({ maxOutputTokens: 200 });
    const deps = { sql, summaryConfig: config, logger: makeLogger() };

    await generateTeammateSummaries(deps, "sess-1");

    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    const passedConfig = mockGenerateSummary.mock.calls[0][2];
    expect(passedConfig.maxOutputTokens).toBe(100);
    // Other config fields should be preserved
    expect(passedConfig.apiKey).toBe("sk-test-key");
    expect(passedConfig.enabled).toBe(true);
  });

  test("handles top-level DB error gracefully", async () => {
    const sql = (_strings: TemplateStringsArray, ..._values: any[]) => {
      return Promise.reject(new Error("Connection refused"));
    };

    const config = makeConfig();
    const deps = { sql: sql as any, summaryConfig: config, logger: makeLogger() };

    // Should not throw
    const results = await generateTeammateSummaries(deps, "sess-1");
    expect(results).toEqual([]);
  });
});
