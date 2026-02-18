/**
 * Tests for workspace-resolver.ts
 *
 * Since we don't have a test Postgres instance, the postgres.js `sql`
 * client is mocked. The sql object is a tagged template literal function —
 * we mock it to capture the query and return expected results.
 *
 * These tests verify that:
 *   - resolveOrCreateWorkspace calls SQL with correct parameters and returns the ULID
 *   - Empty canonical IDs are normalized to "_unassociated"
 *   - getWorkspaceByCanonicalId returns a workspace when found, null when not
 *   - getWorkspaceById returns a workspace when found, null when not
 */

import { describe, expect, test, mock } from "bun:test";
import {
  resolveOrCreateWorkspace,
  getWorkspaceByCanonicalId,
  getWorkspaceById,
} from "../workspace-resolver.js";

/**
 * Create a mock sql tagged template function.
 *
 * postgres.js sql is invoked as a tagged template literal:
 *   sql`SELECT * FROM foo WHERE id = ${id}`
 *
 * The mock captures the template strings and interpolated values,
 * then returns the configured result rows.
 */
function createMockSql(resultRows: Record<string, unknown>[] = []) {
  // Track calls for assertion
  const calls: { strings: string[]; values: unknown[] }[] = [];

  // The sql tagged template function
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(resultRows);
  };

  return { sql: sqlFn as any, calls };
}

describe("resolveOrCreateWorkspace", () => {
  test("inserts new workspace with correct params and returns ULID", async () => {
    const expectedId = "01HXYZ_MOCK_ULID";
    const { sql, calls } = createMockSql([{ id: expectedId }]);

    const result = await resolveOrCreateWorkspace(
      sql,
      "github.com/user/repo",
    );

    // Should return the ULID from the result row
    expect(result).toBe(expectedId);

    // Should have made exactly one SQL call
    expect(calls).toHaveLength(1);

    // The interpolated values should include the canonical_id and display_name
    const [call] = calls;
    // Values order: id (ULID), canonicalId, displayName, default_branch, metadata
    expect(call.values[1]).toBe("github.com/user/repo"); // canonical_id
    expect(call.values[2]).toBe("repo"); // display_name derived from canonical_id
    expect(call.values[3]).toBeNull(); // no default_branch hint
    expect(call.values[4]).toBe("{}"); // empty metadata JSON

    // The generated ULID should be a string (first value)
    expect(typeof call.values[0]).toBe("string");
  });

  test("empty canonical ID is normalized to _unassociated", async () => {
    const { sql, calls } = createMockSql([{ id: "some-ulid" }]);

    await resolveOrCreateWorkspace(sql, "");

    const [call] = calls;
    // canonical_id should be "_unassociated"
    expect(call.values[1]).toBe("_unassociated");
    // display_name for "_unassociated" is "_unassociated"
    expect(call.values[2]).toBe("_unassociated");
  });

  test("whitespace-only canonical ID is normalized to _unassociated", async () => {
    const { sql, calls } = createMockSql([{ id: "some-ulid" }]);

    await resolveOrCreateWorkspace(sql, "   ");

    const [call] = calls;
    expect(call.values[1]).toBe("_unassociated");
  });

  test("passes hints into SQL insert values", async () => {
    const { sql, calls } = createMockSql([{ id: "some-ulid" }]);

    await resolveOrCreateWorkspace(sql, "github.com/user/repo", {
      default_branch: "main",
      all_remotes: ["https://github.com/user/repo.git"],
    });

    const [call] = calls;
    // default_branch hint should be passed as 4th value
    expect(call.values[3]).toBe("main");
    // all_remotes should be in metadata JSON
    const metadata = JSON.parse(call.values[4] as string);
    expect(metadata.all_remotes).toEqual([
      "https://github.com/user/repo.git",
    ]);
  });

  test("metadata is empty JSON when no all_remotes hint provided", async () => {
    const { sql, calls } = createMockSql([{ id: "some-ulid" }]);

    await resolveOrCreateWorkspace(sql, "github.com/user/repo", {
      default_branch: "develop",
    });

    const [call] = calls;
    expect(call.values[4]).toBe("{}");
  });
});

describe("getWorkspaceByCanonicalId", () => {
  test("returns workspace when found", async () => {
    const workspace = {
      id: "01HXYZ",
      canonical_id: "github.com/user/repo",
      display_name: "repo",
      default_branch: "main",
      metadata: {},
      first_seen_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };
    const { sql } = createMockSql([workspace]);

    const result = await getWorkspaceByCanonicalId(
      sql,
      "github.com/user/repo",
    );

    expect(result).toEqual(workspace);
  });

  test("returns null when not found", async () => {
    // Empty result set — no matching rows
    const { sql } = createMockSql([]);

    const result = await getWorkspaceByCanonicalId(
      sql,
      "github.com/nonexistent/repo",
    );

    expect(result).toBeNull();
  });

  test("passes canonical ID as query parameter", async () => {
    const { sql, calls } = createMockSql([]);

    await getWorkspaceByCanonicalId(sql, "github.com/user/repo");

    const [call] = calls;
    expect(call.values[0]).toBe("github.com/user/repo");
  });
});

describe("getWorkspaceById", () => {
  test("returns workspace when found", async () => {
    const workspace = {
      id: "01HXYZ",
      canonical_id: "github.com/user/repo",
      display_name: "repo",
      default_branch: null,
      metadata: {},
      first_seen_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };
    const { sql } = createMockSql([workspace]);

    const result = await getWorkspaceById(sql, "01HXYZ");

    expect(result).toEqual(workspace);
  });

  test("returns null when not found", async () => {
    const { sql } = createMockSql([]);

    const result = await getWorkspaceById(sql, "nonexistent-id");

    expect(result).toBeNull();
  });

  test("passes workspace ID as query parameter", async () => {
    const { sql, calls } = createMockSql([]);

    await getWorkspaceById(sql, "01HXYZ");

    const [call] = calls;
    expect(call.values[0]).toBe("01HXYZ");
  });
});
