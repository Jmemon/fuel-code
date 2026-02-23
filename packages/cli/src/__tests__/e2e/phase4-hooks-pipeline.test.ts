/**
 * Phase 4 E2E test — Claude Code hooks-to-pipeline integration.
 *
 * Verifies the FULL end-to-end flow: spawning a REAL `claude -p` session
 * with hooks configured to call `fuel-code cc-hook`, then confirming the
 * session row appears in Postgres with transcript parsed.
 *
 * This test is SKIPPED when ANTHROPIC_API_KEY is not set, since it requires
 * a live Claude Code API call.
 *
 * Flow under test:
 *   1. Claude Code starts → SessionStart hook fires → cc-hook session-start
 *      → emit session.start → session row created in Postgres (lifecycle: detected)
 *   2. Claude Code completes → SessionEnd hook fires → cc-hook session-end
 *      → emit session.end + transcript upload → pipeline processes transcript
 *      → session lifecycle reaches "parsed"
 *
 * Requires Postgres (5433), Redis (6380), and LocalStack S3 (4566) running
 * via docker-compose.test.yml.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { join } from "node:path";

import { setupS3TestServer, type S3TestServerContext } from "./setup-s3.js";
import { deleteTestRows, type CapturedIds } from "./cleanup.js";
import { generateId } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Skip guard — test requires a live Anthropic API key
// ---------------------------------------------------------------------------

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** CLI entry point — resolved relative to this test file */
const cliEntryPoint = join(import.meta.dir, "../../index.ts");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let ctx: S3TestServerContext;

/** Temp HOME directory — created once for the single test, cleaned up in afterAll */
let tempHome: string;

/** Device ID written into config.yaml — used to find the session in Postgres */
let deviceId: string;

/** IDs captured during the test for targeted cleanup */
let captured: CapturedIds;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn `claude -p` as a child process with a custom HOME dir that has
 * hooks configured to call fuel-code cc-hook. Returns exit code and
 * captured stdout/stderr once the process exits.
 */
function runClaude(
  prompt: string,
  home: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", prompt, "--max-turns", "1", "--output-format", "json"], {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    proc.on("error", reject);
  });
}

/**
 * Poll an async function until it returns a non-null value or times out.
 */
async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Create a temp HOME directory with:
 *   - .claude/settings.json — hooks that call fuel-code cc-hook
 *   - .fuel-code/config.yaml — points at the test server
 *   - .fuel-code/queue/ — empty queue directory
 *
 * Returns the temp HOME path and the device ID written into config.
 */
function createTempHome(serverUrl: string): { home: string; deviceId: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-e2e-hooks-"));

  // --- .claude/settings.json with hook commands ---
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const hookCommand = `bun ${cliEntryPoint} cc-hook`;

  const settings = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `${hookCommand} session-start`,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: `${hookCommand} session-end`,
            },
          ],
        },
      ],
    },
  };

  fs.writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );

  // --- .fuel-code/config.yaml pointing at test server ---
  const fuelDir = path.join(tmpDir, ".fuel-code");
  const queueDir = path.join(fuelDir, "queue");
  fs.mkdirSync(fuelDir, { recursive: true });
  fs.mkdirSync(queueDir, { recursive: true });

  const devId = `e2e-device-${generateId()}`;

  const config = [
    "backend:",
    `  url: ${serverUrl}`,
    "  api_key: test-api-key-123",
    "device:",
    `  id: ${devId}`,
    "  name: e2e-hooks-test-machine",
    "  type: local",
    "pipeline:",
    `  queue_path: ${queueDir}`,
    "  drain_interval_seconds: 30",
    "  batch_size: 50",
    "  post_timeout_ms: 5000",
  ].join("\n");

  fs.writeFileSync(path.join(fuelDir, "config.yaml"), config, "utf-8");

  return { home: tmpDir, deviceId: devId };
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!HAS_API_KEY) return;
  ctx = await setupS3TestServer();
}, 30_000);

afterAll(async () => {
  // Clean up rows created during the test
  if (ctx?.sql && captured) {
    try {
      await deleteTestRows(ctx.sql, captured, ctx.s3);
    } catch {
      // Best effort
    }
  }

  // Clean up temp HOME directory
  if (tempHome) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  // Tear down test server
  if (ctx?.cleanup) {
    await ctx.cleanup();
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Hooks-to-Pipeline E2E", () => {
  test.skipIf(!HAS_API_KEY)(
    "claude -p with hooks → session created → transcript parsed",
    async () => {
      // Reset captured IDs for cleanup
      captured = { sessionIds: [], workspaceIds: [], deviceIds: [], s3Keys: [] };

      // 1. Create temp HOME with hooks config and fuel-code config
      const result = createTempHome(ctx.baseUrl);
      tempHome = result.home;
      deviceId = result.deviceId;
      captured.deviceIds!.push(deviceId);

      // 2. Spawn a real Claude Code session with a trivial prompt.
      //    The hooks in settings.json will fire cc-hook session-start/session-end
      //    which emit events to our test server.
      const claudeResult = await runClaude("Say exactly: hello world", tempHome);

      // Claude should complete successfully (exit 0)
      expect(claudeResult.exitCode).toBe(0);

      // 3. Poll Postgres for a session row matching our device ID.
      //    We don't control the cc_session_id — Claude generates it internally —
      //    so we find the most recent session for our test device.
      const sessionRow = await waitFor(
        async () => {
          const rows = await ctx.sql`
            SELECT id, lifecycle, workspace_id, device_id, cc_session_id
            FROM sessions
            WHERE device_id = ${deviceId}
            ORDER BY started_at DESC
            LIMIT 1
          `;
          return rows.length > 0 ? rows[0] : null;
        },
        30_000,
        500,
      );

      expect(sessionRow).toBeTruthy();
      expect(sessionRow.device_id).toBe(deviceId);

      // Track IDs for cleanup
      captured.sessionIds!.push(sessionRow.id);
      captured.workspaceIds!.push(sessionRow.workspace_id);

      // 4. Wait for lifecycle to reach "parsed" — the full pipeline must complete:
      //    session.end event → consumer processes → transcript downloaded → parsed
      const parsedSession = await waitFor(
        async () => {
          const rows = await ctx.sql`
            SELECT lifecycle, transcript_s3_key FROM sessions WHERE id = ${sessionRow.id}
          `;
          if (rows.length > 0 && rows[0].lifecycle === "parsed") {
            return rows[0];
          }
          return null;
        },
        60_000,
        1_000,
      );

      expect(parsedSession.lifecycle).toBe("parsed");

      // Track S3 key for cleanup
      if (parsedSession.transcript_s3_key) {
        captured.s3Keys!.push(parsedSession.transcript_s3_key);
      }

      // 5. Assert: transcript_messages were parsed from the uploaded transcript
      const tmRows = await ctx.sql`
        SELECT count(*) as count FROM transcript_messages WHERE session_id = ${sessionRow.id}
      `;
      expect(Number(tmRows[0].count)).toBeGreaterThan(0);

      // 6. Assert: content_blocks were extracted from the transcript
      const cbRows = await ctx.sql`
        SELECT count(*) as count FROM content_blocks WHERE session_id = ${sessionRow.id}
      `;
      expect(Number(cbRows[0].count)).toBeGreaterThan(0);
    },
    120_000, // 2 minute timeout for the full flow
  );
});
