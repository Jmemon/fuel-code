/**
 * Fixture data definitions for Phase 4 E2E tests.
 *
 * Seeds workspaces, devices, workspace_devices, sessions, events,
 * git_activity, transcript_messages, and content_blocks into Postgres
 * via direct SQL inserts. All session started_at values use today's date
 * so that --today filtering works correctly in tests.
 *
 * Fixture layout:
 *   3 workspaces:  fuel-code, api-service, _unassociated
 *   2 devices:     macbook-pro (local), remote-abc (remote)
 *   8 sessions:    4 fuel-code, 2 api-service, 2 _unassociated
 *   20+ events:    session lifecycle, 5 git.commit, 2 git.push, 1 git.checkout
 *   5 git_activity: 3 commits, 1 push, 1 checkout (all fuel-code)
 *   Transcript data for 3 fuel-code sessions (4-8 messages each)
 */

import type postgres from "postgres";
import { generateId } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Stable IDs for cross-referencing in assertions.
// Hardcoded ULIDs so that all test files (which run in separate module
// contexts in bun) reference the same fixture rows in the database.
// ---------------------------------------------------------------------------

export const IDS = {
  // Workspaces  (26-char Crockford Base32: 0-9 A-H J K M N P-T V-Z)
  ws_fuel_code:    "01E2E0WS0000FC0000000000AA",
  ws_api_service:  "01E2E0WS0000AP0000000000BB",
  ws_unassociated: "01E2E0WS0000NA0000000000CC",

  // Devices
  dev_macbook: "01E2E0DV0000MB0000000000DD",
  dev_remote:  "01E2E0DV0000RM0000000000EE",

  // Sessions (8 total)
  sess_1_capturing:  "01E2E0SS0001CA0000000000FF",   // fuel-code, capturing
  sess_2_summarized: "01E2E0SS0002SM0000000000GG",   // fuel-code, summarized
  sess_3_summarized: "01E2E0SS0003SM0000000000HH",   // fuel-code, summarized
  sess_4_failed:     "01E2E0SS0004FA0000000000JJ",   // fuel-code, failed
  sess_5_parsed:     "01E2E0SS0005PA0000000000KK",   // api-service, parsed
  sess_6_summarized: "01E2E0SS0006SM0000000000MM",   // api-service, summarized
  sess_7_summarized: "01E2E0SS0007SM0000000000NN",   // _unassociated, summarized
  sess_8_summarized: "01E2E0SS0008SM0000000000PP",   // _unassociated, summarized

  // Events — IDs generated inline during seeding (unique per run is fine)

  // Git activity — IDs generated inline during seeding
} as const;

// ---------------------------------------------------------------------------
// Time helpers: all sessions start today, spread across hours
// ---------------------------------------------------------------------------

function todayAt(hour: number, minute = 0): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Seed function — inserts all fixture data into the test database
// ---------------------------------------------------------------------------

export async function seedFixtures(sql: postgres.Sql): Promise<void> {
  // -- Workspaces --
  await sql`
    INSERT INTO workspaces (id, canonical_id, display_name, default_branch, metadata, first_seen_at)
    VALUES
      (${IDS.ws_fuel_code},    'github.com/user/fuel-code',    'fuel-code',    'main',   '{}', ${todayAt(8)}),
      (${IDS.ws_api_service},  'github.com/user/api-service',  'api-service',  'main',   '{}', ${todayAt(8)}),
      (${IDS.ws_unassociated}, '_unassociated','_unassociated','develop', '{}', ${todayAt(8)})
  `;

  // -- Devices --
  await sql`
    INSERT INTO devices (id, name, type, hostname, os, arch, status, metadata, first_seen_at)
    VALUES
      (${IDS.dev_macbook}, 'macbook-pro', 'local',  'Johns-MBP',    'darwin', 'arm64', 'online',  '{}', ${todayAt(8)}),
      (${IDS.dev_remote},  'remote-abc',  'remote', 'ip-10-0-1-42', 'linux',  'x86_64','online',  '{}', ${todayAt(8)})
  `;

  // -- Workspace-Devices --
  await sql`
    INSERT INTO workspace_devices (workspace_id, device_id, local_path, hooks_installed, git_hooks_installed, last_active_at)
    VALUES
      (${IDS.ws_fuel_code},    ${IDS.dev_macbook}, '/Users/john/Desktop/fuel-code',    true,  true,  ${todayAt(9)}),
      (${IDS.ws_fuel_code},    ${IDS.dev_remote},  '/home/dev/fuel-code',              true,  false, ${todayAt(9)}),
      (${IDS.ws_api_service},  ${IDS.dev_macbook}, '/Users/john/Desktop/api-service',  true,  true,  ${todayAt(9)}),
      (${IDS.ws_unassociated}, ${IDS.dev_macbook}, '/Users/john/Desktop/_unassociated',false, false, ${todayAt(9)})
  `;

  // -- Sessions (8 total) --
  // Session 1: fuel-code, capturing (still active)
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, ended_at, duration_ms,
                          model, git_branch, total_messages, tokens_in, tokens_out, cost_estimate_usd, tags, summary)
    VALUES (${IDS.sess_1_capturing}, ${IDS.ws_fuel_code}, ${IDS.dev_macbook}, 'capturing',
            ${todayAt(9, 0)}, NULL, NULL,
            'claude-sonnet-4-20250514', 'main',
            12, 5000, 3000, 0.15, '{"active","wip"}', NULL)
  `;

  // Session 2: fuel-code, summarized (completed)
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, parse_status, started_at, ended_at, duration_ms,
                          model, git_branch, total_messages, user_messages, assistant_messages,
                          tokens_in, tokens_out, cache_read_tokens, cost_estimate_usd, tags, summary, initial_prompt, tool_use_count)
    VALUES (${IDS.sess_2_summarized}, ${IDS.ws_fuel_code}, ${IDS.dev_macbook}, 'summarized', 'completed',
            ${todayAt(10, 0)}, ${todayAt(10, 45)}, ${45 * 60_000},
            'claude-sonnet-4-20250514', 'feat/auth',
            24, 10, 14, 8000, 6000, 2000, 0.42, '{"auth","bugfix"}',
            'Fixed authentication flow and added error handling', 'Fix the authentication bug in login', 8)
  `;

  // Session 3: fuel-code, summarized
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, parse_status, started_at, ended_at, duration_ms,
                          model, git_branch, total_messages, user_messages, assistant_messages,
                          tokens_in, tokens_out, cost_estimate_usd, tags, summary, initial_prompt, tool_use_count)
    VALUES (${IDS.sess_3_summarized}, ${IDS.ws_fuel_code}, ${IDS.dev_remote}, 'summarized', 'completed',
            ${todayAt(11, 0)}, ${todayAt(11, 30)}, ${30 * 60_000},
            'claude-sonnet-4-20250514', 'main',
            16, 7, 9, 6000, 4500, 0.30, '{}',
            'Refactored database queries for performance', 'Optimize the database queries', 5)
  `;

  // Session 4: fuel-code, failed
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, parse_status, parse_error, started_at, ended_at, duration_ms,
                          model, git_branch, cost_estimate_usd, summary)
    VALUES (${IDS.sess_4_failed}, ${IDS.ws_fuel_code}, ${IDS.dev_macbook}, 'failed', 'failed',
            'S3 download failed: key not found',
            ${todayAt(12, 0)}, ${todayAt(12, 10)}, ${10 * 60_000},
            'claude-sonnet-4-20250514', 'main',
            0.05, NULL)
  `;

  // Session 5: api-service, parsed (has transcript data)
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, parse_status, started_at, ended_at, duration_ms,
                          model, git_branch, total_messages, user_messages, assistant_messages,
                          tokens_in, tokens_out, cache_read_tokens, cost_estimate_usd, tags,
                          summary, initial_prompt, tool_use_count)
    VALUES (${IDS.sess_5_parsed}, ${IDS.ws_api_service}, ${IDS.dev_macbook}, 'parsed', 'completed',
            ${todayAt(13, 0)}, ${todayAt(13, 20)}, ${20 * 60_000},
            'claude-sonnet-4-20250514', 'feat/api',
            20, 8, 12, 10000, 7500, 3000, 0.55, '{"api"}',
            'Implemented REST API endpoints', 'Add the REST API endpoints for user management', 10)
  `;

  // Session 6: api-service, summarized
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, parse_status, started_at, ended_at, duration_ms,
                          model, git_branch, total_messages, tokens_in, tokens_out, cost_estimate_usd, summary, initial_prompt, tool_use_count)
    VALUES (${IDS.sess_6_summarized}, ${IDS.ws_api_service}, ${IDS.dev_macbook}, 'summarized', 'completed',
            ${todayAt(14, 0)}, ${todayAt(14, 25)}, ${25 * 60_000},
            'claude-sonnet-4-20250514', 'main',
            18, 7000, 5000, 0.35, 'Added unit tests for API', 'Write tests for the API', 6)
  `;

  // Session 7: _unassociated, summarized
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, parse_status, started_at, ended_at, duration_ms,
                          model, git_branch, total_messages, tokens_in, tokens_out, cost_estimate_usd, summary)
    VALUES (${IDS.sess_7_summarized}, ${IDS.ws_unassociated}, ${IDS.dev_macbook}, 'summarized', 'completed',
            ${todayAt(15, 0)}, ${todayAt(15, 15)}, ${15 * 60_000},
            'claude-sonnet-4-20250514', 'develop',
            10, 4000, 3000, 0.20, 'Fixed deployment pipeline')
  `;

  // Session 8: _unassociated, summarized
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, parse_status, started_at, ended_at, duration_ms,
                          model, git_branch, total_messages, tokens_in, tokens_out, cost_estimate_usd, summary)
    VALUES (${IDS.sess_8_summarized}, ${IDS.ws_unassociated}, ${IDS.dev_macbook}, 'summarized', 'completed',
            ${todayAt(16, 0)}, ${todayAt(16, 10)}, ${10 * 60_000},
            'claude-sonnet-4-20250514', 'develop',
            8, 3000, 2000, 0.12, 'Quick documentation update')
  `;

  // -- Events (20+) --
  const events = [
    // Session 1 events (capturing — only start)
    { type: "session.start", ts: todayAt(9, 0), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_1_capturing,
      data: { cc_session_id: IDS.sess_1_capturing, cwd: "/Users/john/Desktop/fuel-code", git_branch: "main", model: "claude-sonnet-4-20250514" } },

    // CC session start event (different event type)
    { type: "cc.session_start", ts: todayAt(9, 1), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_1_capturing,
      data: { cc_session_id: IDS.sess_1_capturing, source: "startup" } },

    // Session 2 events (summarized — start + end + git)
    { type: "session.start", ts: todayAt(10, 0), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_2_summarized,
      data: { cc_session_id: IDS.sess_2_summarized, cwd: "/Users/john/Desktop/fuel-code", git_branch: "feat/auth" } },
    { type: "session.end", ts: todayAt(10, 45), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_2_summarized,
      data: { cc_session_id: IDS.sess_2_summarized, duration_ms: 45 * 60_000, end_reason: "exit" } },

    // Session 3 events
    { type: "session.start", ts: todayAt(11, 0), device: IDS.dev_remote, ws: IDS.ws_fuel_code, session: IDS.sess_3_summarized,
      data: { cc_session_id: IDS.sess_3_summarized, cwd: "/home/dev/fuel-code", git_branch: "main" } },
    { type: "session.end", ts: todayAt(11, 30), device: IDS.dev_remote, ws: IDS.ws_fuel_code, session: IDS.sess_3_summarized,
      data: { cc_session_id: IDS.sess_3_summarized, duration_ms: 30 * 60_000, end_reason: "exit" } },

    // Session 4 events (failed)
    { type: "session.start", ts: todayAt(12, 0), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_4_failed,
      data: { cc_session_id: IDS.sess_4_failed, cwd: "/Users/john/Desktop/fuel-code", git_branch: "main" } },
    { type: "session.end", ts: todayAt(12, 10), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_4_failed,
      data: { cc_session_id: IDS.sess_4_failed, duration_ms: 10 * 60_000, end_reason: "error" } },

    // Session 5 events
    { type: "session.start", ts: todayAt(13, 0), device: IDS.dev_macbook, ws: IDS.ws_api_service, session: IDS.sess_5_parsed,
      data: { cc_session_id: IDS.sess_5_parsed, cwd: "/Users/john/Desktop/api-service", git_branch: "feat/api" } },
    { type: "session.end", ts: todayAt(13, 20), device: IDS.dev_macbook, ws: IDS.ws_api_service, session: IDS.sess_5_parsed,
      data: { cc_session_id: IDS.sess_5_parsed, duration_ms: 20 * 60_000, end_reason: "exit" } },

    // Session 6 events
    { type: "session.start", ts: todayAt(14, 0), device: IDS.dev_macbook, ws: IDS.ws_api_service, session: IDS.sess_6_summarized,
      data: { cc_session_id: IDS.sess_6_summarized } },
    { type: "session.end", ts: todayAt(14, 25), device: IDS.dev_macbook, ws: IDS.ws_api_service, session: IDS.sess_6_summarized,
      data: { cc_session_id: IDS.sess_6_summarized, duration_ms: 25 * 60_000, end_reason: "exit" } },

    // Git events — tied to session 2 (fuel-code, feat/auth branch)
    { type: "git.commit", ts: todayAt(10, 15), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_2_summarized,
      data: { commit_sha: "abc1234567890", message: "fix: auth token validation", branch: "feat/auth", files_changed: 3, additions: 45, deletions: 12 } },
    { type: "git.commit", ts: todayAt(10, 30), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_2_summarized,
      data: { commit_sha: "def4567890123", message: "feat: add refresh token flow", branch: "feat/auth", files_changed: 5, additions: 120, deletions: 8 } },
    { type: "git.push", ts: todayAt(10, 40), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: IDS.sess_2_summarized,
      data: { branch: "feat/auth", remote: "origin", commit_count: 2 } },

    // Git events — session 3 (fuel-code, main branch)
    { type: "git.commit", ts: todayAt(11, 10), device: IDS.dev_remote, ws: IDS.ws_fuel_code, session: IDS.sess_3_summarized,
      data: { commit_sha: "ghi7890123456", message: "refactor: optimize slow queries", branch: "main", files_changed: 8, additions: 200, deletions: 15 } },
    { type: "git.commit", ts: todayAt(11, 15), device: IDS.dev_remote, ws: IDS.ws_fuel_code, session: IDS.sess_3_summarized,
      data: { commit_sha: "jkl0123456789", message: "fix: add missing index on events table", branch: "main", files_changed: 2, additions: 10, deletions: 0 } },
    { type: "git.commit", ts: todayAt(11, 20), device: IDS.dev_remote, ws: IDS.ws_fuel_code, session: IDS.sess_3_summarized,
      data: { commit_sha: "mno3456789012", message: "test: add query performance benchmarks", branch: "main", files_changed: 3, additions: 85, deletions: 5 } },
    { type: "git.push", ts: todayAt(11, 25), device: IDS.dev_remote, ws: IDS.ws_fuel_code, session: IDS.sess_3_summarized,
      data: { branch: "main", remote: "origin", commit_count: 3 } },

    // Git checkout event (orphan — no session)
    { type: "git.checkout", ts: todayAt(8, 30), device: IDS.dev_macbook, ws: IDS.ws_fuel_code, session: null,
      data: { from: "main", to: "feat/auth", branch: "feat/auth" } },

    // Session 7 events (_unassociated workspace)
    { type: "session.start", ts: todayAt(15, 0), device: IDS.dev_macbook, ws: IDS.ws_unassociated, session: IDS.sess_7_summarized,
      data: { cc_session_id: IDS.sess_7_summarized } },
    { type: "session.end", ts: todayAt(15, 15), device: IDS.dev_macbook, ws: IDS.ws_unassociated, session: IDS.sess_7_summarized,
      data: { cc_session_id: IDS.sess_7_summarized, duration_ms: 15 * 60_000, end_reason: "exit" } },

    // Session 8 events
    { type: "session.start", ts: todayAt(16, 0), device: IDS.dev_macbook, ws: IDS.ws_unassociated, session: IDS.sess_8_summarized,
      data: { cc_session_id: IDS.sess_8_summarized } },
    { type: "session.end", ts: todayAt(16, 10), device: IDS.dev_macbook, ws: IDS.ws_unassociated, session: IDS.sess_8_summarized,
      data: { cc_session_id: IDS.sess_8_summarized, duration_ms: 10 * 60_000, end_reason: "exit" } },
  ];

  for (const evt of events) {
    await sql`
      INSERT INTO events (id, type, timestamp, device_id, workspace_id, session_id, data, blob_refs)
      VALUES (${generateId()}, ${evt.type}, ${evt.ts}, ${evt.device}, ${evt.ws}, ${evt.session}, ${JSON.stringify(evt.data)}, '[]')
    `;
  }

  // -- Git Activity (5 records, all linked to fuel-code sessions) --
  // 3 commits, 1 push, 1 checkout
  await sql`
    INSERT INTO git_activity (id, workspace_id, device_id, session_id, type, branch, commit_sha, message, files_changed, insertions, deletions, timestamp, data)
    VALUES
      (${generateId()}, ${IDS.ws_fuel_code}, ${IDS.dev_macbook}, ${IDS.sess_2_summarized}, 'commit',   'feat/auth', 'abc1234567890', 'fix: auth token validation',       3,  45, 12, ${todayAt(10, 15)}, '{}'),
      (${generateId()}, ${IDS.ws_fuel_code}, ${IDS.dev_macbook}, ${IDS.sess_2_summarized}, 'commit',   'feat/auth', 'def4567890123', 'feat: add refresh token flow',     5, 120,  8, ${todayAt(10, 30)}, '{}'),
      (${generateId()}, ${IDS.ws_fuel_code}, ${IDS.dev_remote},  ${IDS.sess_3_summarized}, 'commit',   'main',      'ghi7890123456', 'refactor: optimize slow queries',  8, 200, 15, ${todayAt(11, 10)}, '{}'),
      (${generateId()}, ${IDS.ws_fuel_code}, ${IDS.dev_macbook}, ${IDS.sess_2_summarized}, 'push',     'feat/auth', NULL,             NULL,                              NULL, NULL, NULL, ${todayAt(10, 40)}, '{"remote":"origin","commit_count":2}'),
      (${generateId()}, ${IDS.ws_fuel_code}, ${IDS.dev_macbook}, NULL,                     'checkout', 'feat/auth', NULL,             NULL,                              NULL, NULL, NULL, ${todayAt(8, 30)},  '{"from":"main","to":"feat/auth"}')
  `;

  // -- Transcript Messages & Content Blocks --
  // Seed for fuel-code summarized sessions + the live session (spec line 81)
  await seedTranscriptData(sql, IDS.sess_2_summarized, 8);
  await seedTranscriptData(sql, IDS.sess_3_summarized, 6);
  await seedTranscriptData(sql, IDS.sess_1_capturing, 4);
}

/**
 * Seed transcript_messages and content_blocks for a session.
 * Creates realistic conversation turns with Human/Assistant messages,
 * tool_use blocks, and thinking blocks.
 */
async function seedTranscriptData(
  sql: postgres.Sql,
  sessionId: string,
  messageCount: number,
): Promise<void> {
  for (let i = 0; i < messageCount; i++) {
    const msgId = generateId();
    const isUser = i % 2 === 0;
    const role = isUser ? "human" : "assistant";
    const messageType = isUser ? "user" : "assistant";
    const ordinal = i + 1;

    await sql`
      INSERT INTO transcript_messages (
        id, session_id, line_number, ordinal, message_type, role, model,
        tokens_in, tokens_out, cache_read, cache_write, cost_usd,
        compact_sequence, is_compacted, has_text, has_thinking, has_tool_use, has_tool_result,
        metadata
      )
      VALUES (
        ${msgId}, ${sessionId}, ${i + 1}, ${ordinal}, ${messageType}, ${role},
        ${isUser ? null : "claude-sonnet-4-20250514"},
        ${isUser ? null : 500 + i * 100}, ${isUser ? null : 300 + i * 50},
        ${isUser ? null : 100}, ${isUser ? null : 50}, ${isUser ? null : 0.005},
        0, false,
        true,
        ${!isUser && i > 2},
        ${!isUser && i > 0},
        ${isUser && i > 0},
        '{}'
      )
    `;

    // Content blocks for this message
    if (isUser) {
      // User messages have a single text block
      await sql`
        INSERT INTO content_blocks (
          id, message_id, session_id, block_order, block_type,
          content_text, metadata
        )
        VALUES (
          ${generateId()}, ${msgId}, ${sessionId}, 0, 'text',
          ${`User message ${ordinal}: Can you help me with this task?`},
          '{}'
        )
      `;
    } else {
      // Assistant messages have text + optionally thinking + tool_use blocks
      let blockOrder = 0;

      // Thinking block (for messages after ordinal 3)
      if (i > 2) {
        await sql`
          INSERT INTO content_blocks (
            id, message_id, session_id, block_order, block_type,
            thinking_text, metadata
          )
          VALUES (
            ${generateId()}, ${msgId}, ${sessionId}, ${blockOrder}, 'thinking',
            'Let me analyze this problem step by step...',
            '{}'
          )
        `;
        blockOrder++;
      }

      // Text block
      await sql`
        INSERT INTO content_blocks (
          id, message_id, session_id, block_order, block_type,
          content_text, metadata
        )
        VALUES (
          ${generateId()}, ${msgId}, ${sessionId}, ${blockOrder}, 'text',
          ${`I'll help you with that. Here's my analysis for step ${ordinal}.`},
          '{}'
        )
      `;
      blockOrder++;

      // Tool use block (for messages after ordinal 1)
      if (i > 0) {
        const toolNames = ["Read", "Edit", "Bash", "Grep"];
        const toolName = toolNames[i % toolNames.length];
        await sql`
          INSERT INTO content_blocks (
            id, message_id, session_id, block_order, block_type,
            tool_name, tool_use_id, tool_input, metadata
          )
          VALUES (
            ${generateId()}, ${msgId}, ${sessionId}, ${blockOrder}, 'tool_use',
            ${toolName}, ${`toolu_${generateId().slice(0, 12)}`},
            ${JSON.stringify({ file_path: `/src/file${i}.ts` })},
            '{}'
          )
        `;
      }
    }
  }
}
