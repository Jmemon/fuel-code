/**
 * Phase 4 E2E test — Claude Code session-to-pipeline integration.
 *
 * Uses the Claude Agent SDK to run a real Claude Code session, then drives
 * the full pipeline (emit events + upload transcript) with the session data.
 * Verifies the complete lifecycle: detected → parsed.
 *
 * ISOLATION:
 *   - Claude Code runs with HOME set to a temp directory. All session data
 *     (.claude/projects/*, transcripts) goes there, NOT the real ~/.claude.
 *   - DB and S3 are docker-compose test infrastructure only (Postgres:5433,
 *     LocalStack S3:4566, Redis:6380). No production data is touched.
 *   - afterAll cleans up: deletes all test rows from the DB, removes S3
 *     objects, and `rm -rf`s the temp HOME directory.
 *
 * This test is SKIPPED when ANTHROPIC_API_KEY is not set.
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

import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { setupS3TestServer, type S3TestServerContext } from "./setup-s3.js";
import { deleteTestRows, type CapturedIds } from "./cleanup.js";
import { generateId } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Load .env.test from project root (provides ANTHROPIC_API_KEY etc.)
// ---------------------------------------------------------------------------

const envTestPath = join(import.meta.dir, "../../../../../.env.test");
if (fs.existsSync(envTestPath)) {
  for (const line of fs.readFileSync(envTestPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Skip guard — test requires a live Anthropic API key
// ---------------------------------------------------------------------------

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const cliEntryPoint = join(import.meta.dir, "../../index.ts");
const REAL_HOME = os.homedir();

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let ctx: S3TestServerContext;
let tempHome: string;
let captured: CapturedIds;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a clean env for spawning processes: override HOME and strip all
 * Claude Code session env vars so child processes don't think they're nested.
 * Returns a shallow copy — process.env is never modified.
 */
function buildCleanEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Find a transcript file by searching the Claude Code projects directory.
 * Claude Code stores transcripts at: <HOME>/.claude/projects/<cwd-hash>/<session-id>.jsonl
 */
function findTranscript(home: string, sessionId: string): string | null {
  const claudeProjectsDir = path.join(home, ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) return null;

  for (const dir of fs.readdirSync(claudeProjectsDir)) {
    const transcriptFile = path.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(transcriptFile)) return transcriptFile;
  }
  return null;
}

/**
 * Run a real Claude Code session using the Agent SDK with HOME isolated
 * to a temp directory. Returns session_id, transcript path, and cwd.
 */
async function runClaudeSDK(
  prompt: string,
  home: string,
): Promise<{
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  durationMs: number;
}> {
  const conversation = query({
    prompt,
    options: {
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Don't load any filesystem settings — fully isolated from real HOME
      settingSources: [],
      cwd: home,
      env: buildCleanEnv(home),
      model: "claude-sonnet-4-6",
      thinking: { type: "disabled" },
    },
  });

  let resultMsg: SDKResultMessage | undefined;
  let cwd = home;

  for await (const msg of conversation) {
    if (msg.type === "system" && (msg as any).subtype === "init") {
      cwd = (msg as any).cwd ?? home;
    }
    if (msg.type === "result") {
      resultMsg = msg as SDKResultMessage;
    }
  }

  if (!resultMsg) {
    throw new Error("SDK query completed without a result message");
  }

  const sessionId = resultMsg.session_id;
  const transcriptPath = findTranscript(home, sessionId);
  if (!transcriptPath) {
    throw new Error(`Transcript not found for session ${sessionId} under ${home}/.claude/projects/`);
  }

  // Guard: transcript MUST be under the temp HOME, never the real HOME
  if (transcriptPath.startsWith(REAL_HOME)) {
    throw new Error(
      `ISOLATION VIOLATION: transcript was written to real HOME (${transcriptPath}). ` +
      `Expected it under temp HOME (${home}).`,
    );
  }

  return { sessionId, transcriptPath, cwd, durationMs: resultMsg.duration_ms };
}

/**
 * Spawn the fuel-code CLI as a child process with HOME pointing at
 * the temp directory so it reads the test config.yaml.
 */
function runCli(
  args: string[],
  home: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntryPoint, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.stdout?.on("data", () => {}); // drain
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
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
 *   - .claude/ — empty, so the SDK writes transcripts here (not real HOME)
 *   - .fuel-code/config.yaml — points at the test server
 *   - .fuel-code/queue/ — empty queue directory for offline event fallback
 */
function createTempHome(serverUrl: string): {
  home: string;
  deviceId: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-e2e-hooks-"));

  // Pre-create .claude/ so the SDK subprocess doesn't need to
  fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });

  // fuel-code CLI config pointing at the test server
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
  // 1. Clean up all test rows from test DB and S3 objects from LocalStack
  if (ctx?.sql && captured) {
    try {
      await deleteTestRows(ctx.sql, captured, ctx.s3);
    } catch {
      // Best effort
    }
  }

  // 2. Remove the entire temp HOME directory (transcripts, .claude, .fuel-code)
  if (tempHome) {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  }

  // 3. Tear down test server (HTTP, Redis, Postgres pool)
  if (ctx?.cleanup) {
    await ctx.cleanup();
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("Hooks-to-Pipeline E2E", () => {
  test.skipIf(!HAS_API_KEY)(
    "SDK session → emit start/end → pipeline processes to parsed",
    async () => {
      captured = { sessionIds: [], workspaceIds: [], deviceIds: [], s3Keys: [] };

      // 1. Create isolated temp HOME with fuel-code config + .claude dir
      const setup = createTempHome(ctx.baseUrl);
      tempHome = setup.home;
      captured.deviceIds!.push(setup.deviceId);

      // 2. Run a real Claude Code session via the Agent SDK (HOME = temp dir)
      const claude = await runClaudeSDK("Say exactly: hello world", tempHome);

      const ccSessionId = claude.sessionId;
      const transcriptPath = claude.transcriptPath;
      captured.sessionIds!.push(ccSessionId);

      // 3. Verify isolation: transcript is under temp HOME, not real HOME
      expect(ccSessionId).toBeTruthy();
      expect(transcriptPath).toBeTruthy();
      expect(transcriptPath.startsWith(tempHome)).toBe(true);
      expect(fs.existsSync(transcriptPath)).toBe(true);

      // 4. Emit session.start via CLI → creates session row in test Postgres
      const startData = JSON.stringify({
        cc_session_id: ccSessionId,
        cwd: claude.cwd,
        git_branch: null,
        git_remote: null,
        cc_version: "test",
        model: null,
        source: "startup",
        transcript_path: transcriptPath,
      });

      const workspaceCanonical = `github.com/test-user/hooks-e2e-${generateId()}`;

      const startResult = await runCli(
        ["emit", "session.start", "--data", startData, "--workspace-id", workspaceCanonical],
        tempHome,
      );
      expect(startResult.exitCode).toBe(0);

      // 5. Wait for session row to appear
      const sessionRow = await waitFor(async () => {
        const rows = await ctx.sql`
          SELECT id, lifecycle, workspace_id, device_id
          FROM sessions
          WHERE id = ${ccSessionId}
        `;
        return rows.length > 0 ? rows[0] : null;
      });

      expect(sessionRow.lifecycle).toBe("detected");
      captured.workspaceIds!.push(sessionRow.workspace_id);

      // 6. Upload the REAL transcript to LocalStack S3
      const uploadResult = await runCli(
        ["transcript", "upload", "--session-id", ccSessionId, "--file", transcriptPath],
        tempHome,
      );
      expect(uploadResult.exitCode).toBe(0);

      // 7. Verify transcript_s3_key was set on the session row
      const afterUpload = await waitFor(async () => {
        const rows = await ctx.sql`
          SELECT transcript_s3_key FROM sessions WHERE id = ${ccSessionId}
        `;
        return rows[0]?.transcript_s3_key ? rows[0] : null;
      });
      expect(afterUpload.transcript_s3_key).toBeTruthy();
      captured.s3Keys!.push(afterUpload.transcript_s3_key);

      // 8. Emit session.end → triggers pipeline processing
      const endData = JSON.stringify({
        cc_session_id: ccSessionId,
        duration_ms: claude.durationMs,
        end_reason: "exit",
        transcript_path: transcriptPath,
      });

      const endResult = await runCli(
        [
          "emit", "session.end",
          "--data", endData,
          "--workspace-id", workspaceCanonical,
          "--session-id", ccSessionId,
        ],
        tempHome,
      );
      expect(endResult.exitCode).toBe(0);

      // 9. Wait for lifecycle to reach "parsed"
      const parsedSession = await waitFor(
        async () => {
          const rows = await ctx.sql`
            SELECT lifecycle, transcript_s3_key FROM sessions WHERE id = ${ccSessionId}
          `;
          if (rows.length > 0 && rows[0].lifecycle === "parsed") {
            return rows[0];
          }
          return null;
        },
        30_000,
        1_000,
      );

      expect(parsedSession.lifecycle).toBe("parsed");

      // 10. Verify transcript_messages were parsed
      const tmRows = await ctx.sql`
        SELECT count(*) as count FROM transcript_messages WHERE session_id = ${ccSessionId}
      `;
      expect(Number(tmRows[0].count)).toBeGreaterThan(0);

      // 11. Verify content_blocks were extracted
      const cbRows = await ctx.sql`
        SELECT count(*) as count FROM content_blocks WHERE session_id = ${ccSessionId}
      `;
      expect(Number(cbRows[0].count)).toBeGreaterThan(0);
    },
    120_000,
  );
});
