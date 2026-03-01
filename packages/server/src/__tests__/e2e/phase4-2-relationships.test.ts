/**
 * Phase 4-2 API endpoint tests for session relationships and teams.
 *
 * Tests the REST API responses for sessions with sub-agents, skills,
 * worktrees, and team associations. Verifies:
 *   - GET /api/sessions/:id includes inline subagents, skills, worktrees, team
 *   - GET /api/sessions/:id/subagents returns correct list
 *   - GET /api/sessions/:id/skills returns correct list
 *   - GET /api/sessions/:id/worktrees returns correct list
 *   - GET /api/teams returns teams with lead session info
 *   - GET /api/teams/:name returns detail with members
 *   - GET /api/sessions?has_subagents=true filters correctly
 *   - GET /api/sessions?team=<name> filters correctly
 *   - 404 cases for non-existent resources
 *   - Backward compatibility: old sessions have empty relationship arrays
 *
 * These tests require REAL Postgres and Redis running via docker-compose.test.yml
 * (ports 5433 and 6380 respectively).
 *
 * The test inserts data directly into the database to set up known states,
 * then queries the API to verify correct responses. This avoids needing S3
 * or the event pipeline for API-only testing.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../../app.js";
import { createDb } from "../../db/postgres.js";
import { runMigrations } from "../../db/migrator.js";
import { createRedisClient } from "../../redis/client.js";
import { logger } from "../../logger.js";
import { generateId } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";
const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let sql: ReturnType<typeof createDb>;
let redis: ReturnType<typeof createRedisClient>;
let server: Server;
let baseUrl: string;

// Test fixture IDs — deterministic IDs for subagents so we can reference them in transcript_messages
const workspaceId = `ws-p42-${generateId()}`;
const deviceId = `dev-p42-${generateId()}`;
const sessionWithRelId = `sess-rels-${generateId()}`;
const sessionPlainId = `sess-plain-${generateId()}`;
const teamName = `test-team-${Date.now()}`;
const subagentRowId1 = `sa-row-${generateId()}`;
const subagentRowId2 = `sa-row-${generateId()}`;

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  sql = createDb(DATABASE_URL, { max: 5 });

  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    throw new Error(
      `Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`,
    );
  }

  redis = createRedisClient(REDIS_URL);
  await redis.connect();

  const app = createApp({ sql, redis, apiKey: API_KEY });
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Insert test workspace and device
  await sql`
    INSERT INTO workspaces (id, canonical_id, display_name)
    VALUES (${workspaceId}, ${"test-canonical-p42"}, ${"p42-test-repo"})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO devices (id, name, type)
    VALUES (${deviceId}, ${"p42-test-device"}, ${"local"})
    ON CONFLICT (id) DO NOTHING
  `;

  // Insert session WITH relationships
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, parse_status, team_name, team_role, subagent_count)
    VALUES (${sessionWithRelId}, ${workspaceId}, ${deviceId}, ${"parsed"}, ${new Date().toISOString()}, ${"completed"}, ${teamName}, ${"lead"}, ${2})
  `;

  // Insert session WITHOUT relationships (backward compat test)
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, parse_status)
    VALUES (${sessionPlainId}, ${workspaceId}, ${deviceId}, ${"parsed"}, ${new Date().toISOString()}, ${"completed"})
  `;

  // Insert team row
  await sql`
    INSERT INTO teams (id, team_name, description, lead_session_id, created_at, member_count, metadata)
    VALUES (${generateId()}, ${teamName}, ${"Test team for API tests"}, ${sessionWithRelId}, ${new Date().toISOString()}, ${2}, ${{message_count: 5}})
  `;

  // Insert subagent rows for the session (using known IDs for transcript_message FK)
  await sql`
    INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model, status, started_at, team_name, metadata)
    VALUES
      (${subagentRowId1}, ${sessionWithRelId}, ${"agent-x1"}, ${"code"}, ${"code-worker"}, ${"claude-sonnet-4-6"}, ${"completed"}, ${new Date().toISOString()}, ${teamName}, ${"{}"}::jsonb),
      (${subagentRowId2}, ${sessionWithRelId}, ${"agent-x2"}, ${"researcher"}, ${"research-worker"}, ${null}, ${"completed"}, ${new Date().toISOString()}, ${teamName}, ${"{}"}::jsonb)
  `;

  // Insert skill rows
  await sql`
    INSERT INTO session_skills (id, session_id, skill_name, invoked_at, invoked_by, args)
    VALUES
      (${generateId()}, ${sessionWithRelId}, ${"commit"}, ${new Date().toISOString()}, ${"user"}, ${"-m 'Fix bug'"}),
      (${generateId()}, ${sessionWithRelId}, ${"review-pr"}, ${new Date().toISOString()}, ${"claude"}, ${"123"})
  `;

  // Insert worktree rows
  await sql`
    INSERT INTO session_worktrees (id, session_id, worktree_name, created_at)
    VALUES (${generateId()}, ${sessionWithRelId}, ${"feature-wt"}, ${new Date().toISOString()})
  `;

  // Insert transcript_messages for subagent_id filtering tests.
  // 2 main messages (subagent_id IS NULL) + 1 sub-agent message (subagent_id = subagentRowId1).
  const mainMsg1Id = generateId();
  const mainMsg2Id = generateId();
  const subMsg1Id = generateId();

  await sql`
    INSERT INTO transcript_messages (id, session_id, line_number, ordinal, message_type, role, timestamp, has_text)
    VALUES
      (${mainMsg1Id}, ${sessionWithRelId}, ${1}, ${0}, ${"user"}, ${"user"}, ${new Date().toISOString()}, ${true}),
      (${mainMsg2Id}, ${sessionWithRelId}, ${2}, ${1}, ${"assistant"}, ${"assistant"}, ${new Date().toISOString()}, ${true}),
      (${subMsg1Id}, ${sessionWithRelId}, ${3}, ${2}, ${"assistant"}, ${"assistant"}, ${new Date().toISOString()}, ${true})
  `;

  // Set the subagent_id on the sub-agent message
  await sql`
    UPDATE transcript_messages SET subagent_id = ${subagentRowId1} WHERE id = ${subMsg1Id}
  `;

  // Insert matching content_blocks for each message
  await sql`
    INSERT INTO content_blocks (id, message_id, session_id, block_order, block_type, content_text)
    VALUES
      (${generateId()}, ${mainMsg1Id}, ${sessionWithRelId}, ${0}, ${"text"}, ${"Hello world"}),
      (${generateId()}, ${mainMsg2Id}, ${sessionWithRelId}, ${0}, ${"text"}, ${"Main agent reply"}),
      (${generateId()}, ${subMsg1Id}, ${sessionWithRelId}, ${0}, ${"text"}, ${"Sub-agent work"})
  `;
}, 30_000);

afterAll(async () => {
  // Clean up in FK order
  await sql`DELETE FROM content_blocks WHERE session_id IN (${sessionWithRelId}, ${sessionPlainId})`;
  await sql`DELETE FROM transcript_messages WHERE session_id IN (${sessionWithRelId}, ${sessionPlainId})`;
  await sql`DELETE FROM session_skills WHERE session_id IN (${sessionWithRelId}, ${sessionPlainId})`;
  await sql`DELETE FROM session_worktrees WHERE session_id IN (${sessionWithRelId}, ${sessionPlainId})`;
  await sql`DELETE FROM subagents WHERE session_id IN (${sessionWithRelId}, ${sessionPlainId})`;
  await sql`DELETE FROM teams WHERE team_name = ${teamName}`;
  await sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_devices WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM devices WHERE id = ${deviceId}`;

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  if (redis) await redis.quit();
  if (sql) await sql.end();
}, 15_000);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 4-2 API: Session relationships", () => {
  // -----------------------------------------------------------------------
  // Session detail includes inline relationships
  // -----------------------------------------------------------------------

  test("GET /sessions/:id includes subagents, skills, worktrees, team", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionWithRelId}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    const session = body.session;

    // Subagents
    expect(session.subagents).toBeDefined();
    expect(session.subagents.length).toBe(2);
    expect(session.subagents[0].agent_id).toBeDefined();

    // Skills
    expect(session.skills).toBeDefined();
    expect(session.skills.length).toBe(2);
    expect(session.skills[0].skill_name).toBeDefined();

    // Worktrees
    expect(session.worktrees).toBeDefined();
    expect(session.worktrees.length).toBe(1);
    expect(session.worktrees[0].worktree_name).toBe("feature-wt");

    // Team
    expect(session.team).toBeDefined();
    expect(session.team.team_name).toBe(teamName);
  });

  // -----------------------------------------------------------------------
  // Session sub-endpoints
  // -----------------------------------------------------------------------

  test("GET /sessions/:id/subagents returns sub-agents for session", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionWithRelId}/subagents`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.subagents.length).toBe(2);
    expect(body.subagents[0].agent_type).toBeDefined();
  });

  test("GET /sessions/:id/skills returns skills for session", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionWithRelId}/skills`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.skills.length).toBe(2);
    expect(body.skills[0].skill_name).toBeDefined();
    expect(body.skills[0].invoked_by).toBeDefined();
  });

  test("GET /sessions/:id/worktrees returns worktrees for session", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionWithRelId}/worktrees`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.worktrees.length).toBe(1);
    expect(body.worktrees[0].worktree_name).toBe("feature-wt");
  });

  // -----------------------------------------------------------------------
  // 404 cases
  // -----------------------------------------------------------------------

  test("GET /sessions/:id returns 404 for non-existent session", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent-session-xyz`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("GET /sessions/:id/subagents returns 404 for non-existent session", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/nonexistent-session-xyz/subagents`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(404);
  });

  test("GET /sessions/:id/skills returns 404 for non-existent session", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/nonexistent-session-xyz/skills`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(404);
  });

  test("GET /sessions/:id/worktrees returns 404 for non-existent session", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/nonexistent-session-xyz/worktrees`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Filtering
  // -----------------------------------------------------------------------

  test("GET /sessions?has_subagents=true returns sessions with subagents", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions?has_subagents=true`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    // Should include the session that has subagent_count > 0
    const found = body.sessions.some(
      (s: any) => s.id === sessionWithRelId,
    );
    expect(found).toBe(true);

    // Should NOT include the plain session
    const foundPlain = body.sessions.some(
      (s: any) => s.id === sessionPlainId,
    );
    expect(foundPlain).toBe(false);
  });

  test("GET /sessions?team=<name> returns sessions with that team", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions?team=${encodeURIComponent(teamName)}`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const found = body.sessions.some(
      (s: any) => s.id === sessionWithRelId,
    );
    expect(found).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Transcript subagent_id filtering
  // -----------------------------------------------------------------------

  test("GET /sessions/:id/transcript returns only main messages by default", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionWithRelId}/transcript`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    // Default: only main session messages (subagent_id IS NULL)
    // We inserted 2 main messages and 1 sub-agent message
    expect(body.messages.length).toBe(2);
  });

  test("GET /sessions/:id/transcript?subagent_id=all returns main + sub-agent messages", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionWithRelId}/transcript?subagent_id=all`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    // All messages: 2 main + 1 sub-agent = 3
    expect(body.messages.length).toBe(3);
  });

  test("GET /sessions/:id/transcript?subagent_id=<id> returns only that sub-agent's messages", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionWithRelId}/transcript?subagent_id=${subagentRowId1}`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    // Only the 1 message belonging to subagentRowId1
    expect(body.messages.length).toBe(1);
    // Should include subagent context
    expect(body.messages[0].subagent).toBeDefined();
    expect(body.messages[0].subagent.agent_id).toBe("agent-x1");
  });

  test("GET /sessions/:id/transcript?subagent_id=<nonexistent> returns 404", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionWithRelId}/transcript?subagent_id=nonexistent-sa-id`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Backward compatibility: old session
  // -----------------------------------------------------------------------

  test("old session without relationships returns empty arrays and null team", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${sessionPlainId}`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    const session = body.session;

    expect(session.subagents).toHaveLength(0);
    expect(session.skills).toHaveLength(0);
    expect(session.worktrees).toHaveLength(0);
    expect(session.team).toBeNull();
    expect(session.resumed_from).toBeNull();
  });
});

describe("Phase 4-2 API: Teams", () => {
  test("GET /teams returns teams with lead session info", async () => {
    const res = await fetch(`${baseUrl}/api/teams`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.teams).toBeDefined();
    expect(Array.isArray(body.teams)).toBe(true);

    const testTeam = body.teams.find((t: any) => t.team_name === teamName);
    expect(testTeam).toBeDefined();
    expect(testTeam.description).toBe("Test team for API tests");
    expect(testTeam.lead_session_id).toBe(sessionWithRelId);
    expect(testTeam.lead_session).toBeDefined();
    expect(testTeam.lead_session.id).toBe(sessionWithRelId);
  });

  test("GET /teams/:name returns team detail with members", async () => {
    const res = await fetch(
      `${baseUrl}/api/teams/${encodeURIComponent(teamName)}`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const team = body.team;

    expect(team.team_name).toBe(teamName);
    expect(team.description).toBe("Test team for API tests");
    expect(team.members).toBeDefined();
    expect(team.members.length).toBe(2);
    expect(team.members[0].agent_id).toBeDefined();
  });

  test("GET /teams/:name returns 404 for non-existent team", async () => {
    const res = await fetch(
      `${baseUrl}/api/teams/nonexistent-team-xyz`,
      { headers: authHeaders() },
    );
    expect(res.status).toBe(404);
  });
});
