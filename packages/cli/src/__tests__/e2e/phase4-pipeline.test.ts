/**
 * Phase 4 E2E integration tests — CLI pipeline with S3.
 *
 * Tests the FULL flow: CLI emit session.start → transcript upload → emit
 * session.end → pipeline processes transcript to "parsed" lifecycle.
 *
 * Unlike phase4-cli.test.ts (which calls API functions directly), these tests
 * spawn the CLI as a child process with a temp HOME directory, exercising the
 * real config loading, HTTP posting, and transcript upload code paths.
 *
 * Requires Postgres (5433), Redis (6380), and LocalStack S3 (4566) running
 * via docker-compose.test.yml.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { join } from "node:path";

import { setupS3TestServer, type S3TestServerContext } from "./setup-s3.js";
import { deleteTestRows, type CapturedIds } from "./cleanup.js";
import { generateId } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** CLI entry point — resolved relative to this test file */
const cliEntryPoint = join(import.meta.dir, "../../index.ts");

/** 10-line test transcript fixture from the server E2E tests */
const transcriptFixturePath = join(
  import.meta.dir,
  "../../../../server/src/__tests__/e2e/fixtures/test-transcript.jsonl",
);

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let ctx: S3TestServerContext;

/** Temp HOME directory for this test file — each test gets its own */
let tempHome: string;

/** IDs captured during a test for targeted cleanup in afterEach */
let captured: CapturedIds;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the fuel-code CLI as a child process with a custom HOME dir.
 * Returns the exit code and captured stderr once the process exits.
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
    proc.stdout?.on("data", () => {}); // drain stdout
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
  intervalMs = 300,
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
 * Create a temp HOME directory with a valid .fuel-code/config.yaml
 * pointing at the test server.
 */
function createTempHome(serverUrl: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-e2e-pipeline-"));
  const fuelDir = path.join(tmpDir, ".fuel-code");
  const queueDir = path.join(fuelDir, "queue");

  fs.mkdirSync(fuelDir, { recursive: true });
  fs.mkdirSync(queueDir, { recursive: true });

  // Parse port from the server URL
  const url = new URL(serverUrl);

  const config = [
    "backend:",
    `  url: ${serverUrl}`,
    "  api_key: test-api-key-123",
    "device:",
    `  id: e2e-device-${generateId()}`,
    "  name: e2e-test-machine",
    "  type: local",
    "pipeline:",
    `  queue_path: ${queueDir}`,
    "  drain_interval_seconds: 30",
    "  batch_size: 50",
    "  post_timeout_ms: 5000",
  ].join("\n");

  fs.writeFileSync(path.join(fuelDir, "config.yaml"), config, "utf-8");

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await setupS3TestServer();
}, 30_000);

afterEach(async () => {
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
});

afterAll(async () => {
  if (ctx?.cleanup) {
    await ctx.cleanup();
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CLI Pipeline E2E", () => {
  test("full lifecycle: emit start → transcript upload → emit end → parsed", async () => {
    // Reset captured IDs for this test
    captured = { sessionIds: [], workspaceIds: [], deviceIds: [], s3Keys: [] };

    // 1. Create temp HOME with config pointing at test server
    tempHome = createTempHome(ctx.baseUrl);

    // Read device ID from the config we just wrote
    const configContent = fs.readFileSync(
      path.join(tempHome, ".fuel-code", "config.yaml"),
      "utf-8",
    );
    const deviceIdMatch = configContent.match(/id: (e2e-device-\S+)/);
    const deviceId = deviceIdMatch![1];
    captured.deviceIds!.push(deviceId);

    // 2. Build session.start payload
    const ccSessionId = `cc-sess-${generateId()}`;
    const workspaceCanonical = `github.com/test-user/pipeline-e2e-${generateId()}`;
    captured.sessionIds!.push(ccSessionId);

    const transcriptPath = `s3://transcripts/${ccSessionId}.json`;

    const startData = JSON.stringify({
      cc_session_id: ccSessionId,
      cwd: "/home/user/test-repo",
      git_branch: "main",
      git_remote: "https://github.com/test-user/test-repo.git",
      cc_version: "1.0.0",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: transcriptPath,
    });

    // 3. Emit session.start via CLI subprocess
    const startResult = await runCli(
      ["emit", "session.start", "--data", startData, "--workspace-id", workspaceCanonical],
      tempHome,
    );
    expect(startResult.exitCode).toBe(0);

    // 4. Poll Postgres for the session row (created by session.start handler)
    const sessionRow = await waitFor(async () => {
      const rows = await ctx.sql`
        SELECT id, lifecycle, workspace_id, device_id
        FROM sessions
        WHERE id = ${ccSessionId}
      `;
      return rows.length > 0 ? rows[0] : null;
    });

    expect(sessionRow.lifecycle).toBe("detected");

    // Track workspace and device for cleanup
    captured.workspaceIds!.push(sessionRow.workspace_id);

    // 5. Upload transcript via CLI subprocess
    const uploadResult = await runCli(
      ["transcript", "upload", "--session-id", ccSessionId, "--file", transcriptFixturePath],
      tempHome,
    );
    expect(uploadResult.exitCode).toBe(0);

    // 6. Verify transcript_s3_key was set on the session
    const afterUpload = await waitFor(async () => {
      const rows = await ctx.sql`
        SELECT transcript_s3_key FROM sessions WHERE id = ${ccSessionId}
      `;
      return rows[0]?.transcript_s3_key ? rows[0] : null;
    });
    expect(afterUpload.transcript_s3_key).toBeTruthy();
    captured.s3Keys!.push(afterUpload.transcript_s3_key);

    // 7. Emit session.end via CLI subprocess
    const endData = JSON.stringify({
      cc_session_id: ccSessionId,
      duration_ms: 60_000,
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

    // 8. Wait for lifecycle to reach "parsed" (pipeline processes after session.end)
    const parsedSession = await waitFor(
      async () => {
        const rows = await ctx.sql`
          SELECT lifecycle FROM sessions WHERE id = ${ccSessionId}
        `;
        if (rows.length > 0 && rows[0].lifecycle === "parsed") {
          return rows[0];
        }
        return null;
      },
      20_000,
      500,
    );

    expect(parsedSession.lifecycle).toBe("parsed");

    // 9. Assert: transcript_messages were parsed
    const tmRows = await ctx.sql`
      SELECT count(*) as count FROM transcript_messages WHERE session_id = ${ccSessionId}
    `;
    expect(Number(tmRows[0].count)).toBeGreaterThan(0);

    // 10. Assert: content_blocks were extracted
    const cbRows = await ctx.sql`
      SELECT count(*) as count FROM content_blocks WHERE session_id = ${ccSessionId}
    `;
    expect(Number(cbRows[0].count)).toBeGreaterThan(0);
  }, 45_000);

  test("session without transcript: lifecycle stays at ended", async () => {
    // Reset captured IDs for this test
    captured = { sessionIds: [], workspaceIds: [], deviceIds: [], s3Keys: [] };

    // 1. Create temp HOME with config pointing at test server
    tempHome = createTempHome(ctx.baseUrl);

    // Read device ID from the config
    const configContent = fs.readFileSync(
      path.join(tempHome, ".fuel-code", "config.yaml"),
      "utf-8",
    );
    const deviceIdMatch = configContent.match(/id: (e2e-device-\S+)/);
    const deviceId = deviceIdMatch![1];
    captured.deviceIds!.push(deviceId);

    // 2. Build session.start payload
    const ccSessionId = `cc-sess-${generateId()}`;
    const workspaceCanonical = `github.com/test-user/no-transcript-${generateId()}`;
    captured.sessionIds!.push(ccSessionId);

    const transcriptPath = `s3://transcripts/${ccSessionId}.json`;

    const startData = JSON.stringify({
      cc_session_id: ccSessionId,
      cwd: "/home/user/test-repo",
      git_branch: "main",
      git_remote: "https://github.com/test-user/test-repo.git",
      cc_version: "1.0.0",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: transcriptPath,
    });

    // 3. Emit session.start via CLI subprocess
    const startResult = await runCli(
      ["emit", "session.start", "--data", startData, "--workspace-id", workspaceCanonical],
      tempHome,
    );
    expect(startResult.exitCode).toBe(0);

    // 4. Wait for session row to appear
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

    // 5. Emit session.end WITHOUT uploading transcript
    const endData = JSON.stringify({
      cc_session_id: ccSessionId,
      duration_ms: 30_000,
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

    // 6. Wait for lifecycle to reach "ended"
    await waitFor(async () => {
      const rows = await ctx.sql`
        SELECT lifecycle FROM sessions WHERE id = ${ccSessionId}
      `;
      if (rows.length > 0 && rows[0].lifecycle === "ended") {
        return rows[0];
      }
      return null;
    });

    // 7. Wait a bit to confirm lifecycle does NOT advance beyond "ended"
    await new Promise((r) => setTimeout(r, 3_000));

    // 8. Assert: lifecycle is still "ended" (not "parsed")
    const finalRows = await ctx.sql`
      SELECT lifecycle FROM sessions WHERE id = ${ccSessionId}
    `;
    expect(finalRows[0].lifecycle).toBe("ended");

    // 9. Assert: no transcript_messages were created
    const tmRows = await ctx.sql`
      SELECT count(*) as count FROM transcript_messages WHERE session_id = ${ccSessionId}
    `;
    expect(Number(tmRows[0].count)).toBe(0);
  }, 30_000);
});
