# E2E Test Gap Coverage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close three E2E test gaps: CLI-with-S3 pipeline, hooks-to-pipeline via real Claude Code session, and backfill ingestion against a real server.

**Architecture:** Each gap becomes one new test file. Gaps 1 and 2 share a new S3-enabled setup variant in the CLI E2E directory. Gap 3 lives in the server E2E directory and reuses the existing Phase 2 setup pattern. All tests use targeted row deletion (not TRUNCATE) for cleanup.

**Tech Stack:** Bun test runner, Postgres (port 5433), Redis (port 6380), LocalStack S3 (port 4566), `@aws-sdk/client-s3`, child_process.spawn for CLI subprocess invocation, `claude` CLI for Gap 2.

**Design doc:** `docs/plans/2026-02-23-e2e-test-gaps-design.md`

---

## Task 1: Create S3-Enabled Setup for CLI E2E Tests

Creates `setup-s3.ts` — a variant of the existing `setup.ts` that includes LocalStack S3 and pipeline dependencies.

**Files:**
- Create: `packages/cli/src/__tests__/e2e/setup-s3.ts`
- Reference: `packages/cli/src/__tests__/e2e/setup.ts` (existing setup pattern)
- Reference: `packages/server/src/__tests__/e2e/phase2-pipeline.test.ts:128-215` (S3 setup pattern)

### Step 1: Create setup-s3.ts

This file follows the same pattern as `setup.ts` but adds S3 and pipeline deps. Key differences from `setup.ts`:
- Creates a LocalStack S3 bucket via `@aws-sdk/client-s3`
- Creates an `FuelCodeS3Client` via `createS3Client()`
- Builds `PipelineDeps` with summaries disabled
- Passes `s3` and `pipelineDeps` to `createApp()` and to `createEventHandler()`/`startConsumer()`
- Returns `s3` in the context for cleanup
- Does NOT seed fixture data (these tests create their own data dynamically)
- Does NOT use advisory locks or ref counting (each test file gets its own server)
- Uses targeted row deletion in cleanup (accepts IDs to delete)

```typescript
// packages/cli/src/__tests__/e2e/setup-s3.ts

import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { S3Client as AwsS3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

import { createApp } from "../../../../server/src/app.js";
import { createDb } from "../../../../server/src/db/postgres.js";
import { runMigrations } from "../../../../server/src/db/migrator.js";
import { createRedisClient } from "../../../../server/src/redis/client.js";
import { ensureConsumerGroup } from "../../../../server/src/redis/stream.js";
import { startConsumer, type ConsumerHandle } from "../../../../server/src/pipeline/consumer.js";
import { createEventHandler } from "../../../../server/src/pipeline/wire.js";
import { createWsServer, type WsServerHandle } from "../../../../server/src/ws/index.js";
import { createS3Client, type FuelCodeS3Client } from "../../../../server/src/aws/s3.js";
import { logger } from "../../../../server/src/logger.js";
import type { PipelineDeps, SummaryConfig } from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";
const S3_ENDPOINT = "http://localhost:4566";
const S3_BUCKET = "fuel-code-test-cli";
const S3_REGION = "us-east-1";
const MIGRATIONS_DIR = join(import.meta.dir, "../../../../server/src/db/migrations");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface S3TestServerContext {
  baseUrl: string;
  wsUrl: string;
  apiKey: string;
  sql: ReturnType<typeof createDb>;
  s3: FuelCodeS3Client;
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export async function setupTestServerWithS3(): Promise<S3TestServerContext> {
  // 1. Postgres
  const sql = createDb(DATABASE_URL, { max: 5 });
  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    throw new Error(`Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`);
  }

  // 2. Redis (two clients: app + consumer)
  const redis = createRedisClient(REDIS_URL);
  const redisConsumer = createRedisClient(REDIS_URL);
  await Promise.all([redis.connect(), redisConsumer.connect()]);
  await ensureConsumerGroup(redis);

  // 3. S3 bucket in LocalStack
  const rawS3 = new AwsS3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  try {
    await rawS3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  } catch (err: any) {
    if (err.name !== "BucketAlreadyOwnedByYou" && err.name !== "BucketAlreadyExists") throw err;
  }
  rawS3.destroy();

  // 4. fuel-code S3 client
  const s3 = createS3Client({ bucket: S3_BUCKET, region: S3_REGION, endpoint: S3_ENDPOINT, forcePathStyle: true }, logger);

  // 5. Pipeline deps (summaries disabled — no Anthropic API needed)
  const summaryConfig: SummaryConfig = {
    enabled: false,
    model: "claude-sonnet-4-20250514",
    temperature: 0.3,
    maxOutputTokens: 150,
    apiKey: "",
  };
  const pipelineDeps: PipelineDeps = { sql, s3, summaryConfig, logger };

  // 6. Express app with S3 + pipeline
  const app = createApp({ sql, redis, apiKey: API_KEY, s3, pipelineDeps });
  const server: Server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;

  // 7. WebSocket
  const wsHandle: WsServerHandle = createWsServer({
    httpServer: server, logger, apiKey: API_KEY,
    pingIntervalMs: 60_000, pongTimeoutMs: 10_000,
  });

  // 8. Consumer with pipeline deps
  const { registry } = createEventHandler(sql, logger, pipelineDeps);
  const consumer = startConsumer({
    redis: redisConsumer, sql, registry, logger, pipelineDeps,
    broadcaster: wsHandle.broadcaster,
  });

  // 9. Cleanup function
  const cleanup = async () => {
    if (consumer) await consumer.stop();
    if (wsHandle) await wsHandle.shutdown();
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    try { if (redis) await redis.flushall(); } catch {}
    if (redisConsumer) await redisConsumer.quit();
    if (redis) await redis.quit();
    if (sql) await sql.end();
  };

  return { baseUrl, wsUrl, apiKey: API_KEY, sql, s3, cleanup };
}
```

### Step 2: Verify it compiles

Run: `cd /Users/johnmemon/Desktop/fuel-code && bun build packages/cli/src/__tests__/e2e/setup-s3.ts --no-bundle 2>&1 | head -20`

Expected: No type errors. If there are import issues, fix them.

### Step 3: Commit

```bash
git add packages/cli/src/__tests__/e2e/setup-s3.ts
git commit -m "test: add S3-enabled setup for CLI E2E tests"
```

---

## Task 2: Create Targeted Cleanup Helper

Creates a shared `deleteTestRows()` function that deletes specific rows by captured IDs in FK-safe order, plus S3 object cleanup.

**Files:**
- Create: `packages/cli/src/__tests__/e2e/cleanup.ts`
- Reference: `packages/cli/src/__tests__/e2e/fixtures.ts:291-340` (FK deletion order)

### Step 1: Create cleanup.ts

```typescript
// packages/cli/src/__tests__/e2e/cleanup.ts

import type postgres from "postgres";
import type { FuelCodeS3Client } from "../../../../server/src/aws/s3.js";

/**
 * IDs captured during a test for targeted cleanup.
 * All fields are optional — only the IDs you captured will be cleaned up.
 */
export interface CapturedIds {
  sessionIds?: string[];
  workspaceIds?: string[];
  deviceIds?: string[];
  s3Keys?: string[];
}

/**
 * Delete test-created rows from Postgres in FK-safe order,
 * then remove any S3 objects. Only deletes rows matching the
 * provided IDs — never touches data from other tests.
 */
export async function deleteTestRows(
  sql: postgres.Sql,
  ids: CapturedIds,
  s3?: FuelCodeS3Client,
): Promise<void> {
  const { sessionIds = [], workspaceIds = [], deviceIds = [], s3Keys = [] } = ids;

  // Delete children before parents (FK constraint order)
  if (sessionIds.length > 0) {
    await sql`DELETE FROM content_blocks WHERE session_id = ANY(${sessionIds})`;
    await sql`DELETE FROM transcript_messages WHERE session_id = ANY(${sessionIds})`;
  }
  if (workspaceIds.length > 0) {
    await sql`DELETE FROM git_activity WHERE workspace_id = ANY(${workspaceIds})`;
  }
  if (workspaceIds.length > 0 || deviceIds.length > 0) {
    // Events can reference workspace_id OR device_id
    if (workspaceIds.length > 0 && deviceIds.length > 0) {
      await sql`DELETE FROM events WHERE workspace_id = ANY(${workspaceIds}) OR device_id = ANY(${deviceIds})`;
    } else if (workspaceIds.length > 0) {
      await sql`DELETE FROM events WHERE workspace_id = ANY(${workspaceIds})`;
    } else {
      await sql`DELETE FROM events WHERE device_id = ANY(${deviceIds})`;
    }
  }
  if (sessionIds.length > 0) {
    await sql`DELETE FROM sessions WHERE id = ANY(${sessionIds})`;
  }
  if (workspaceIds.length > 0 || deviceIds.length > 0) {
    if (workspaceIds.length > 0 && deviceIds.length > 0) {
      await sql`DELETE FROM workspace_devices WHERE workspace_id = ANY(${workspaceIds}) OR device_id = ANY(${deviceIds})`;
    } else if (workspaceIds.length > 0) {
      await sql`DELETE FROM workspace_devices WHERE workspace_id = ANY(${workspaceIds})`;
    } else {
      await sql`DELETE FROM workspace_devices WHERE device_id = ANY(${deviceIds})`;
    }
  }
  if (workspaceIds.length > 0) {
    await sql`DELETE FROM workspaces WHERE id = ANY(${workspaceIds})`;
  }
  if (deviceIds.length > 0) {
    await sql`DELETE FROM devices WHERE id = ANY(${deviceIds})`;
  }

  // S3 cleanup
  if (s3 && s3Keys.length > 0) {
    for (const key of s3Keys) {
      try {
        await s3.delete(key);
      } catch {
        // Ignore — object may not exist
      }
    }
  }
}
```

### Step 2: Verify it compiles

Run: `cd /Users/johnmemon/Desktop/fuel-code && bun build packages/cli/src/__tests__/e2e/cleanup.ts --no-bundle 2>&1 | head -20`

Expected: No type errors.

### Step 3: Commit

```bash
git add packages/cli/src/__tests__/e2e/cleanup.ts
git commit -m "test: add targeted cleanup helper for E2E tests"
```

---

## Task 3: Gap 1 — Phase 4 CLI Pipeline E2E Test

Tests the full flow: CLI `emit session.start` → `transcript upload` → `emit session.end` → pipeline processes to `parsed` lifecycle.

**Files:**
- Create: `packages/cli/src/__tests__/e2e/phase4-pipeline.test.ts`
- Reference: `packages/cli/src/__tests__/e2e/setup-s3.ts` (from Task 1)
- Reference: `packages/cli/src/__tests__/e2e/cleanup.ts` (from Task 2)
- Reference: `packages/server/src/__tests__/e2e/fixtures/test-transcript.jsonl` (transcript fixture)
- Reference: `packages/cli/src/commands/emit.ts` (runEmit function)
- Reference: `packages/cli/src/commands/transcript.ts` (runTranscriptUpload function)

### Step 1: Write the test file

This test spawns CLI subprocesses with a temp HOME containing a `config.yaml` pointing at the test server. It tests:
1. Full lifecycle: session.start → transcript upload → session.end → lifecycle reaches `parsed`
2. Session without transcript: start + end → lifecycle stays at `ended`

```typescript
// packages/cli/src/__tests__/e2e/phase4-pipeline.test.ts

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { generateId } from "@fuel-code/shared";
import { setupTestServerWithS3, type S3TestServerContext } from "./setup-s3.js";
import { deleteTestRows, type CapturedIds } from "./cleanup.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ctx: S3TestServerContext;
let tempHome: string;
let cliEntryPoint: string;

/** IDs captured per-test for cleanup */
let captured: CapturedIds;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Path to the test transcript fixture (11-line JSONL) */
const TEST_TRANSCRIPT_PATH = join(
  import.meta.dir,
  "../../../../server/src/__tests__/e2e/fixtures/test-transcript.jsonl",
);

/**
 * Create a temporary HOME directory with a fuel-code config.yaml
 * pointing at the test server. Returns the temp dir path.
 */
function createTempHome(baseUrl: string, apiKey: string): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "fuel-e2e-"));
  const fuelDir = join(dir, ".fuel-code");
  fs.mkdirSync(fuelDir, { recursive: true });
  fs.mkdirSync(join(fuelDir, "queue"), { recursive: true });

  const configYaml = `
backend:
  url: ${baseUrl}
  api_key: ${apiKey}
device:
  id: e2e-device-${generateId().slice(0, 8)}
  name: e2e-test-machine
  type: local
pipeline:
  queue_path: ${join(fuelDir, "queue")}
  drain_interval_seconds: 30
  batch_size: 50
  post_timeout_ms: 5000
`.trim();

  fs.writeFileSync(join(fuelDir, "config.yaml"), configYaml);
  return dir;
}

/**
 * Spawn a fuel-code CLI command as a child process with the test HOME.
 * Returns a promise that resolves with { exitCode, stderr }.
 */
function runCli(args: string[], home: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [cliEntryPoint, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.stdout?.on("data", () => {}); // drain stdout

    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
    proc.on("error", reject);
  });
}

/**
 * Poll Postgres until a condition is met or timeout.
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

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await setupTestServerWithS3();
  tempHome = createTempHome(ctx.baseUrl, ctx.apiKey);
  cliEntryPoint = join(import.meta.dir, "../../index.ts");
}, 30_000);

afterEach(async () => {
  if (captured) {
    await deleteTestRows(ctx.sql, captured, ctx.s3);
    captured = { sessionIds: [], workspaceIds: [], deviceIds: [] };
  }
});

afterAll(async () => {
  // Remove temp HOME
  if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  if (ctx) await ctx.cleanup();
}, 15_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 4 CLI Pipeline E2E (with S3)", () => {

  test("full lifecycle: emit start → transcript upload → emit end → parsed", async () => {
    const ccSessionId = `cc-sess-${generateId()}`;
    const workspaceId = "github.com/e2e-test/cli-pipeline-repo";

    captured = { sessionIds: [], workspaceIds: [], deviceIds: [], s3Keys: [] };

    // 1. Emit session.start via CLI subprocess
    const startPayload = JSON.stringify({
      cc_session_id: ccSessionId,
      cwd: "/tmp/test-repo",
      git_branch: "main",
      git_remote: "https://github.com/e2e-test/cli-pipeline-repo.git",
      cc_version: "1.0.0-test",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: "",
    });

    const startResult = await runCli(
      ["emit", "session.start", "--data", startPayload, "--workspace-id", workspaceId],
      tempHome,
    );
    expect(startResult.exitCode).toBe(0);

    // 2. Wait for session row to appear in Postgres
    const session = await waitFor(async () => {
      const rows = await ctx.sql`
        SELECT id, lifecycle, workspace_id, device_id
        FROM sessions
        WHERE cc_session_id = ${ccSessionId}
      `;
      return rows.length > 0 ? rows[0] : null;
    });

    expect(session).toBeTruthy();
    const sessionId = session.id as string;
    captured.sessionIds!.push(sessionId);
    captured.workspaceIds!.push(session.workspace_id as string);
    captured.deviceIds!.push(session.device_id as string);

    // 3. Upload transcript via CLI subprocess
    const uploadResult = await runCli(
      ["transcript", "upload", "--session-id", sessionId, "--file", TEST_TRANSCRIPT_PATH],
      tempHome,
    );
    expect(uploadResult.exitCode).toBe(0);

    // 4. Emit session.end via CLI subprocess
    const endPayload = JSON.stringify({
      cc_session_id: ccSessionId,
      duration_ms: 60000,
      end_reason: "exit",
      transcript_path: "",
    });

    const endResult = await runCli(
      ["emit", "session.end", "--data", endPayload, "--workspace-id", workspaceId, "--session-id", sessionId],
      tempHome,
    );
    expect(endResult.exitCode).toBe(0);

    // 5. Wait for lifecycle to reach "parsed" (pipeline processes after session.end)
    const parsed = await waitFor(async () => {
      const rows = await ctx.sql`
        SELECT lifecycle, s3_key FROM sessions WHERE id = ${sessionId}
      `;
      if (rows.length > 0 && rows[0].lifecycle === "parsed") return rows[0];
      return null;
    }, 20_000);

    expect(parsed.lifecycle).toBe("parsed");

    // Track S3 key for cleanup
    if (parsed.s3_key) captured.s3Keys!.push(parsed.s3_key as string);

    // 6. Verify transcript_messages were created
    const [{ count: msgCount }] = await ctx.sql`
      SELECT count(*) as count FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    expect(Number(msgCount)).toBeGreaterThan(0);

    // 7. Verify content_blocks were created
    const [{ count: blockCount }] = await ctx.sql`
      SELECT count(*) as count FROM content_blocks WHERE session_id = ${sessionId}
    `;
    expect(Number(blockCount)).toBeGreaterThan(0);
  }, 45_000);

  test("session without transcript: lifecycle stays at 'ended'", async () => {
    const ccSessionId = `cc-sess-${generateId()}`;
    const workspaceId = "github.com/e2e-test/cli-no-transcript";

    captured = { sessionIds: [], workspaceIds: [], deviceIds: [] };

    // 1. Emit session.start
    const startPayload = JSON.stringify({
      cc_session_id: ccSessionId,
      cwd: "/tmp/test-repo",
      git_branch: "main",
      git_remote: "https://github.com/e2e-test/cli-no-transcript.git",
      cc_version: "1.0.0-test",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: "",
    });

    await runCli(
      ["emit", "session.start", "--data", startPayload, "--workspace-id", workspaceId],
      tempHome,
    );

    // 2. Wait for session row
    const session = await waitFor(async () => {
      const rows = await ctx.sql`
        SELECT id, lifecycle, workspace_id, device_id
        FROM sessions WHERE cc_session_id = ${ccSessionId}
      `;
      return rows.length > 0 ? rows[0] : null;
    });

    const sessionId = session.id as string;
    captured.sessionIds!.push(sessionId);
    captured.workspaceIds!.push(session.workspace_id as string);
    captured.deviceIds!.push(session.device_id as string);

    // 3. Emit session.end WITHOUT uploading a transcript
    const endPayload = JSON.stringify({
      cc_session_id: ccSessionId,
      duration_ms: 5000,
      end_reason: "exit",
      transcript_path: "",
    });

    await runCli(
      ["emit", "session.end", "--data", endPayload, "--workspace-id", workspaceId, "--session-id", sessionId],
      tempHome,
    );

    // 4. Wait briefly for consumer to process
    await new Promise((r) => setTimeout(r, 3000));

    // 5. Verify lifecycle is "ended" (not "parsed" — no transcript to process)
    const [row] = await ctx.sql`SELECT lifecycle FROM sessions WHERE id = ${sessionId}`;
    expect(row.lifecycle).toBe("ended");

    // 6. Verify no transcript_messages exist
    const [{ count }] = await ctx.sql`
      SELECT count(*) as count FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    expect(Number(count)).toBe(0);
  }, 30_000);
});
```

### Step 2: Run the test to verify it passes

Run: `cd /Users/johnmemon/Desktop/fuel-code && bun test packages/cli/src/__tests__/e2e/phase4-pipeline.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: 2 pass, 0 fail.

If tests fail, debug by running without grep filter to see full output, then fix.

### Step 3: Commit

```bash
git add packages/cli/src/__tests__/e2e/phase4-pipeline.test.ts
git commit -m "test: add Phase 4 CLI pipeline E2E with S3 (Gap 1)"
```

---

## Task 4: Gap 2 — Hooks-to-Pipeline E2E via Real Claude Code Session

Tests the full hooks flow: spawn `claude -p` → SessionStart hook fires → session created → SessionEnd hook fires → transcript uploaded → pipeline processes to `parsed`.

**Files:**
- Create: `packages/cli/src/__tests__/e2e/phase4-hooks-pipeline.test.ts`
- Reference: `packages/cli/src/__tests__/e2e/setup-s3.ts` (from Task 1)
- Reference: `packages/cli/src/__tests__/e2e/cleanup.ts` (from Task 2)
- Reference: `packages/cli/src/commands/cc-hook.ts` (hook handlers)

### Step 1: Write the test file

This test requires `ANTHROPIC_API_KEY` to be set. It spawns a real `claude -p` subprocess with a temp HOME containing both `.claude/settings.json` (hooks config) and `.fuel-code/config.yaml` (backend config).

```typescript
// packages/cli/src/__tests__/e2e/phase4-hooks-pipeline.test.ts

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { generateId } from "@fuel-code/shared";
import { setupTestServerWithS3, type S3TestServerContext } from "./setup-s3.js";
import { deleteTestRows, type CapturedIds } from "./cleanup.js";

// ---------------------------------------------------------------------------
// Skip if no API key
// ---------------------------------------------------------------------------

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let ctx: S3TestServerContext;
let tempHome: string;
let captured: CapturedIds;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path to the fuel-code CLI entry point */
const CLI_ENTRY = join(import.meta.dir, "../../index.ts");

/**
 * Create a temp HOME with both:
 *   .claude/settings.json  — CC hooks config pointing fuel-code cc-hook at test server
 *   .fuel-code/config.yaml — fuel-code config pointing at test server
 */
function createHooksHome(baseUrl: string, apiKey: string): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "fuel-hooks-e2e-"));

  // .claude/settings.json — hooks that invoke fuel-code cc-hook
  const claudeDir = join(dir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  const settings = {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: `bun ${CLI_ENTRY} cc-hook session-start`,
        }],
      }],
      SessionEnd: [{
        hooks: [{
          type: "command",
          command: `bun ${CLI_ENTRY} cc-hook session-end`,
        }],
      }],
    },
  };
  fs.writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));

  // .fuel-code/config.yaml
  const fuelDir = join(dir, ".fuel-code");
  fs.mkdirSync(fuelDir, { recursive: true });
  fs.mkdirSync(join(fuelDir, "queue"), { recursive: true });

  const deviceId = `e2e-hooks-device-${generateId().slice(0, 8)}`;
  const configYaml = `
backend:
  url: ${baseUrl}
  api_key: ${apiKey}
device:
  id: ${deviceId}
  name: e2e-hooks-machine
  type: local
pipeline:
  queue_path: ${join(fuelDir, "queue")}
  drain_interval_seconds: 30
  batch_size: 50
  post_timeout_ms: 5000
`.trim();

  fs.writeFileSync(join(fuelDir, "config.yaml"), configYaml);
  return dir;
}

/**
 * Spawn `claude -p` with the test HOME and wait for it to exit.
 */
function runClaude(prompt: string, home: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", prompt, "--max-turns", "1", "--output-format", "json"], {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    proc.on("error", reject);
  });
}

/**
 * Poll Postgres until a condition is met or timeout.
 */
async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
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

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!HAS_API_KEY) return;
  ctx = await setupTestServerWithS3();
  tempHome = createHooksHome(ctx.baseUrl, ctx.apiKey);
  captured = { sessionIds: [], workspaceIds: [], deviceIds: [], s3Keys: [] };
}, 30_000);

afterAll(async () => {
  if (!HAS_API_KEY) return;
  // Clean up test data
  if (captured && ctx) {
    await deleteTestRows(ctx.sql, captured, ctx.s3);
  }
  if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  if (ctx) await ctx.cleanup();
}, 15_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Hooks-to-Pipeline E2E (real Claude Code session)", () => {

  test.skipIf(!HAS_API_KEY)(
    "claude -p triggers hooks → session created → transcript parsed",
    async () => {
      // 1. Run a real Claude Code session with hooks
      const result = await runClaude("Say exactly: hello world", tempHome);

      // Claude should exit successfully (0 or sometimes 1 is ok)
      // The important thing is the hooks fired
      expect(result.exitCode).toBeLessThanOrEqual(1);

      // 2. Wait for at least one session row to appear
      //    The SessionStart hook emits session.start → consumer creates the row
      const session = await waitFor(async () => {
        const rows = await ctx.sql`
          SELECT id, lifecycle, workspace_id, device_id, s3_key, cc_session_id
          FROM sessions
          ORDER BY started_at DESC
          LIMIT 1
        `;
        return rows.length > 0 ? rows[0] : null;
      }, 30_000);

      expect(session).toBeTruthy();
      const sessionId = session.id as string;
      captured.sessionIds!.push(sessionId);
      captured.workspaceIds!.push(session.workspace_id as string);
      captured.deviceIds!.push(session.device_id as string);

      // 3. Wait for lifecycle to reach "parsed"
      //    SessionEnd hook emits session.end + uploads transcript → pipeline parses
      const parsed = await waitFor(async () => {
        const rows = await ctx.sql`
          SELECT lifecycle, s3_key FROM sessions WHERE id = ${sessionId}
        `;
        if (rows.length > 0 && rows[0].lifecycle === "parsed") return rows[0];
        return null;
      }, 60_000);

      expect(parsed.lifecycle).toBe("parsed");
      if (parsed.s3_key) captured.s3Keys!.push(parsed.s3_key as string);

      // 4. Verify transcript_messages were created
      const [{ count: msgCount }] = await ctx.sql`
        SELECT count(*) as count FROM transcript_messages WHERE session_id = ${sessionId}
      `;
      expect(Number(msgCount)).toBeGreaterThan(0);

      // 5. Verify content_blocks were created
      const [{ count: blockCount }] = await ctx.sql`
        SELECT count(*) as count FROM content_blocks WHERE session_id = ${sessionId}
      `;
      expect(Number(blockCount)).toBeGreaterThan(0);
    },
    120_000, // 2 minute timeout
  );
});
```

### Step 2: Run the test

**Without API key (should skip):**
Run: `cd /Users/johnmemon/Desktop/fuel-code && bun test packages/cli/src/__tests__/e2e/phase4-hooks-pipeline.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|\(skip\)|^\s+\d+ (pass|fail|skip)|^Ran "`

Expected: 1 skip (or 0 pass if `test.skipIf` causes the whole describe to be empty).

**With API key (full test):**
Run: `cd /Users/johnmemon/Desktop/fuel-code && ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY bun test packages/cli/src/__tests__/e2e/phase4-hooks-pipeline.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: 1 pass.

### Step 3: Commit

```bash
git add packages/cli/src/__tests__/e2e/phase4-hooks-pipeline.test.ts
git commit -m "test: add hooks-to-pipeline E2E with real Claude Code session (Gap 2)"
```

---

## Task 5: Gap 3 — Backfill Ingestion E2E Test

Tests `scanForSessions()` and `ingestBackfillSessions()` against a real server with Postgres, Redis, and S3.

**Files:**
- Create: `packages/server/src/__tests__/e2e/phase2-backfill-ingest.test.ts`
- Reference: `packages/server/src/__tests__/e2e/phase2-pipeline.test.ts:128-264` (setup/teardown pattern)
- Reference: `packages/core/src/session-backfill.ts` (scanForSessions, ingestBackfillSessions)
- Reference: `packages/server/src/__tests__/e2e/fixtures/test-transcript.jsonl` (fixture)

### Step 1: Write the test file

This test creates a fake `~/.claude/projects/` directory structure with a test transcript JSONL file, then runs `scanForSessions()` to discover it, then `ingestBackfillSessions()` to push it through the real pipeline.

```typescript
// packages/server/src/__tests__/e2e/phase2-backfill-ingest.test.ts

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

import { S3Client as AwsS3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

import { createApp } from "../../app.js";
import { createDb } from "../../db/postgres.js";
import { runMigrations } from "../../db/migrator.js";
import { createRedisClient } from "../../redis/client.js";
import { ensureConsumerGroup } from "../../redis/stream.js";
import { startConsumer, type ConsumerHandle } from "../../pipeline/consumer.js";
import { createEventHandler } from "../../pipeline/wire.js";
import { createS3Client } from "../../aws/s3.js";
import type { FuelCodeS3Client } from "../../aws/s3.js";
import { logger } from "../../logger.js";
import { generateId } from "@fuel-code/shared";
import { scanForSessions, ingestBackfillSessions } from "@fuel-code/core";
import type { PipelineDeps, SummaryConfig, BackfillProgress } from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";
const S3_ENDPOINT = "http://localhost:4566";
const S3_BUCKET = "fuel-code-test-backfill";
const S3_REGION = "us-east-1";
const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");
const TEST_TRANSCRIPT_PATH = join(import.meta.dir, "fixtures/test-transcript.jsonl");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let sql: ReturnType<typeof createDb>;
let redis: ReturnType<typeof createRedisClient>;
let redisConsumer: ReturnType<typeof createRedisClient>;
let consumer: ConsumerHandle;
let server: Server;
let baseUrl: string;
let s3: FuelCodeS3Client;
let pipelineDeps: PipelineDeps;

/** Temp directory simulating ~/.claude/projects/ */
let tempProjectsDir: string;

/** IDs captured per-test for targeted cleanup */
let capturedSessionIds: string[];
let capturedWorkspaceIds: string[];
let capturedDeviceIds: string[];
let capturedS3Keys: string[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Create a fake claude projects directory with a test transcript.
 * Returns { projectsDir, sessionId } for assertions.
 *
 * Structure:
 *   $TEMP/
 *     -Users-testuser-Desktop-test-project/
 *       <uuid>.jsonl
 *
 * File mtime is set to 10 minutes ago to avoid the "active session" filter.
 */
function createFakeProjectsDir(): { projectsDir: string; sessionId: string } {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "fuel-backfill-e2e-"));
  const projectDir = join(dir, "-Users-testuser-Desktop-test-project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sessionId = randomUUID();
  const transcriptDest = join(projectDir, `${sessionId}.jsonl`);
  fs.copyFileSync(TEST_TRANSCRIPT_PATH, transcriptDest);

  // Set mtime to 10 minutes ago (past the 5-minute active threshold)
  const tenMinAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(transcriptDest, tenMinAgo, tenMinAgo);

  return { projectsDir: dir, sessionId };
}

/**
 * Delete test rows from Postgres by captured IDs (FK-safe order).
 */
async function deleteTestRows(): Promise<void> {
  if (capturedSessionIds.length > 0) {
    await sql`DELETE FROM content_blocks WHERE session_id = ANY(${capturedSessionIds})`;
    await sql`DELETE FROM transcript_messages WHERE session_id = ANY(${capturedSessionIds})`;
  }
  if (capturedWorkspaceIds.length > 0) {
    await sql`DELETE FROM git_activity WHERE workspace_id = ANY(${capturedWorkspaceIds})`;
  }
  if (capturedWorkspaceIds.length > 0 || capturedDeviceIds.length > 0) {
    await sql`DELETE FROM events WHERE workspace_id = ANY(${capturedWorkspaceIds}) OR device_id = ANY(${capturedDeviceIds})`;
  }
  if (capturedSessionIds.length > 0) {
    await sql`DELETE FROM sessions WHERE id = ANY(${capturedSessionIds})`;
  }
  if (capturedWorkspaceIds.length > 0 || capturedDeviceIds.length > 0) {
    await sql`DELETE FROM workspace_devices WHERE workspace_id = ANY(${capturedWorkspaceIds}) OR device_id = ANY(${capturedDeviceIds})`;
  }
  if (capturedWorkspaceIds.length > 0) {
    await sql`DELETE FROM workspaces WHERE id = ANY(${capturedWorkspaceIds})`;
  }
  if (capturedDeviceIds.length > 0) {
    await sql`DELETE FROM devices WHERE id = ANY(${capturedDeviceIds})`;
  }

  // S3 cleanup
  for (const key of capturedS3Keys) {
    try { await s3.delete(key); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Postgres
  sql = createDb(DATABASE_URL, { max: 5 });
  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    throw new Error(`Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`);
  }

  // 2. Redis
  redis = createRedisClient(REDIS_URL);
  redisConsumer = createRedisClient(REDIS_URL);
  await Promise.all([redis.connect(), redisConsumer.connect()]);
  await ensureConsumerGroup(redis);

  // 3. S3
  const rawS3 = new AwsS3Client({
    region: S3_REGION, endpoint: S3_ENDPOINT, forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  try {
    await rawS3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  } catch (err: any) {
    if (err.name !== "BucketAlreadyOwnedByYou" && err.name !== "BucketAlreadyExists") throw err;
  }
  rawS3.destroy();

  s3 = createS3Client({ bucket: S3_BUCKET, region: S3_REGION, endpoint: S3_ENDPOINT, forcePathStyle: true }, logger);

  // 4. Pipeline deps
  const summaryConfig: SummaryConfig = {
    enabled: false, model: "claude-sonnet-4-20250514",
    temperature: 0.3, maxOutputTokens: 150, apiKey: "",
  };
  pipelineDeps = { sql, s3, summaryConfig, logger };

  // 5. App + consumer
  const app = createApp({ sql, redis, apiKey: API_KEY, s3, pipelineDeps });
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  const { registry } = createEventHandler(sql, logger, pipelineDeps);
  consumer = startConsumer({ redis: redisConsumer, sql, registry, logger, pipelineDeps });
}, 30_000);

afterEach(async () => {
  await deleteTestRows();
  capturedSessionIds = [];
  capturedWorkspaceIds = [];
  capturedDeviceIds = [];
  capturedS3Keys = [];

  // Clean up temp projects dir
  if (tempProjectsDir) {
    fs.rmSync(tempProjectsDir, { recursive: true, force: true });
    tempProjectsDir = "";
  }
});

afterAll(async () => {
  if (consumer) await consumer.stop();
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (redisConsumer) await redisConsumer.quit();
  if (redis) await redis.quit();
  if (sql) await sql.end();
}, 15_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Backfill Ingestion E2E", () => {

  test("scanForSessions discovers transcript files", async () => {
    capturedSessionIds = [];
    capturedWorkspaceIds = [];
    capturedDeviceIds = [];
    capturedS3Keys = [];

    const { projectsDir, sessionId } = createFakeProjectsDir();
    tempProjectsDir = projectsDir;

    const scanResult = await scanForSessions(projectsDir);

    expect(scanResult.discovered.length).toBe(1);
    expect(scanResult.discovered[0].sessionId).toBe(sessionId);
    expect(scanResult.discovered[0].transcriptPath).toContain(`${sessionId}.jsonl`);
    expect(scanResult.discovered[0].fileSizeBytes).toBeGreaterThan(0);
  }, 10_000);

  test("full backfill: scan → ingest → session reaches parsed", async () => {
    capturedSessionIds = [];
    capturedWorkspaceIds = [];
    capturedDeviceIds = [];
    capturedS3Keys = [];

    const { projectsDir, sessionId } = createFakeProjectsDir();
    tempProjectsDir = projectsDir;

    // 1. Scan
    const scanResult = await scanForSessions(projectsDir);
    expect(scanResult.discovered.length).toBe(1);

    const deviceId = `backfill-device-${generateId().slice(0, 8)}`;

    // 2. Track progress
    const progressUpdates: BackfillProgress[] = [];

    // 3. Ingest against real server
    const result = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: baseUrl,
      apiKey: API_KEY,
      deviceId,
      onProgress: (p) => progressUpdates.push({ ...p }),
      concurrency: 1,
      batchSize: 10,
      throttleMs: 50,
    });

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // Capture IDs for cleanup — find the session row the consumer created
    // (backfill uses the discovered sessionId as cc_session_id)
    const sessionRows = await sql`
      SELECT id, workspace_id, device_id FROM sessions WHERE cc_session_id = ${sessionId}
    `;
    expect(sessionRows.length).toBe(1);
    capturedSessionIds.push(sessionRows[0].id);
    capturedWorkspaceIds.push(sessionRows[0].workspace_id);
    capturedDeviceIds.push(sessionRows[0].device_id);

    // 4. Wait for lifecycle to reach "parsed"
    const parsed = await waitFor(async () => {
      const rows = await sql`SELECT lifecycle, s3_key FROM sessions WHERE id = ${sessionRows[0].id}`;
      if (rows.length > 0 && rows[0].lifecycle === "parsed") return rows[0];
      return null;
    }, 30_000);

    expect(parsed.lifecycle).toBe("parsed");
    if (parsed.s3_key) capturedS3Keys.push(parsed.s3_key as string);

    // 5. Verify transcript_messages populated
    const [{ count: msgCount }] = await sql`
      SELECT count(*) as count FROM transcript_messages WHERE session_id = ${sessionRows[0].id}
    `;
    expect(Number(msgCount)).toBeGreaterThan(0);

    // 6. Verify content_blocks populated
    const [{ count: blockCount }] = await sql`
      SELECT count(*) as count FROM content_blocks WHERE session_id = ${sessionRows[0].id}
    `;
    expect(Number(blockCount)).toBeGreaterThan(0);

    // 7. Verify progress callback fired
    expect(progressUpdates.length).toBeGreaterThan(0);
    const lastProgress = progressUpdates[progressUpdates.length - 1];
    expect(lastProgress.completed).toBe(1);
  }, 60_000);

  test("dedup: second ingest of same session is skipped", async () => {
    capturedSessionIds = [];
    capturedWorkspaceIds = [];
    capturedDeviceIds = [];
    capturedS3Keys = [];

    const { projectsDir, sessionId } = createFakeProjectsDir();
    tempProjectsDir = projectsDir;

    const scanResult = await scanForSessions(projectsDir);
    const deviceId = `backfill-dedup-${generateId().slice(0, 8)}`;

    // First ingest
    const result1 = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: baseUrl,
      apiKey: API_KEY,
      deviceId,
      concurrency: 1,
      batchSize: 10,
      throttleMs: 50,
    });
    expect(result1.ingested).toBe(1);

    // Capture IDs for cleanup
    const sessionRows = await sql`
      SELECT id, workspace_id, device_id FROM sessions WHERE cc_session_id = ${sessionId}
    `;
    capturedSessionIds.push(sessionRows[0].id);
    capturedWorkspaceIds.push(sessionRows[0].workspace_id);
    capturedDeviceIds.push(sessionRows[0].device_id);

    // Wait for first session to be fully processed
    await waitFor(async () => {
      const rows = await sql`SELECT lifecycle FROM sessions WHERE id = ${sessionRows[0].id}`;
      if (rows.length > 0 && (rows[0].lifecycle === "parsed" || rows[0].lifecycle === "ended")) return rows[0];
      return null;
    }, 30_000);

    // Track S3 key
    const [{ s3_key }] = await sql`SELECT s3_key FROM sessions WHERE id = ${sessionRows[0].id}`;
    if (s3_key) capturedS3Keys.push(s3_key as string);

    // Second ingest — should skip because session already exists
    const result2 = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: baseUrl,
      apiKey: API_KEY,
      deviceId,
      concurrency: 1,
      batchSize: 10,
      throttleMs: 50,
    });
    expect(result2.skipped).toBe(1);
    expect(result2.ingested).toBe(0);

    // Verify no duplicate session rows
    const allSessions = await sql`SELECT id FROM sessions WHERE cc_session_id = ${sessionId}`;
    expect(allSessions.length).toBe(1);
  }, 60_000);
});
```

### Step 2: Run the test to verify it passes

Run: `cd /Users/johnmemon/Desktop/fuel-code && bun test packages/server/src/__tests__/e2e/phase2-backfill-ingest.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: 3 pass, 0 fail.

If tests fail, debug and fix.

### Step 3: Commit

```bash
git add packages/server/src/__tests__/e2e/phase2-backfill-ingest.test.ts
git commit -m "test: add backfill ingestion E2E against real server (Gap 3)"
```

---

## Task 6: Run Full E2E Suite and Verify No Regressions

Ensure the new tests don't break existing ones.

### Step 1: Run existing CLI E2E tests

Run: `cd /Users/johnmemon/Desktop/fuel-code && bun test packages/cli/src/__tests__/e2e/ 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: All existing tests still pass, plus the new ones.

### Step 2: Run existing server E2E tests

Run: `cd /Users/johnmemon/Desktop/fuel-code && bun test packages/server/src/__tests__/e2e/ 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: All existing tests still pass, plus the new backfill test.

### Step 3: Fix any regressions

If existing tests break, investigate whether the new setup files cause side effects (unlikely since each test file creates its own server instance).

### Step 4: Final commit if fixes were needed

```bash
git add -A
git commit -m "test: fix E2E test regressions from gap coverage additions"
```

---

## Summary

| Task | File | Description |
|------|------|-------------|
| 1 | `packages/cli/src/__tests__/e2e/setup-s3.ts` | S3-enabled test server setup |
| 2 | `packages/cli/src/__tests__/e2e/cleanup.ts` | FK-safe targeted row deletion |
| 3 | `packages/cli/src/__tests__/e2e/phase4-pipeline.test.ts` | Gap 1: CLI emit + transcript upload + pipeline |
| 4 | `packages/cli/src/__tests__/e2e/phase4-hooks-pipeline.test.ts` | Gap 2: Real CC session → hooks → pipeline |
| 5 | `packages/server/src/__tests__/e2e/phase2-backfill-ingest.test.ts` | Gap 3: Backfill scan + ingest against real server |
| 6 | — | Full regression check |
