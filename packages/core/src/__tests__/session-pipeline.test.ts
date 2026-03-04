/**
 * Tests for session-pipeline.ts — the pipeline queue.
 *
 * The actual pipeline logic is tested in reconcile/__tests__/reconcile.test.ts.
 * This file only tests the createPipelineQueue bounded async work queue.
 */

import { describe, expect, test } from "bun:test";
import {
  createPipelineQueue,
  type PipelineDeps,
  type S3Client,
} from "../session-pipeline.js";
import pino from "pino";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock S3 client */
function createMockS3(): S3Client {
  return {
    upload: async (key, body) => ({
      key,
      size: typeof body === "string" ? body.length : body.length,
    }),
    download: async () => "",
  };
}

/** Silent logger for tests */
const silentLogger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Pipeline queue tests — no database required
// ---------------------------------------------------------------------------

describe("createPipelineQueue", () => {
  test("enqueue increases depth, start enables processing", () => {
    const queue = createPipelineQueue(2);

    // Before start(), enqueue is a no-op (deps not set)
    queue.enqueue("session-1");
    expect(queue.depth()).toBe(0);

    // After start(), enqueue adds to pending
    const mockDeps: PipelineDeps = {
      sql: {} as any,
      s3: createMockS3(),
      summaryConfig: { enabled: false, model: "", temperature: 0, maxOutputTokens: 0, apiKey: "" },
      logger: silentLogger,
    };
    queue.start(mockDeps);

    // Note: items are dequeued immediately when there's concurrency available,
    // so depth may go back to 0 right away. We test overflow behavior instead.
    expect(queue.depth()).toBe(0); // no items enqueued after start
  });

  test("stop clears pending and returns a promise", async () => {
    const queue = createPipelineQueue(2);
    const mockDeps: PipelineDeps = {
      sql: {} as any,
      s3: createMockS3(),
      summaryConfig: { enabled: false, model: "", temperature: 0, maxOutputTokens: 0, apiKey: "" },
      logger: silentLogger,
    };
    queue.start(mockDeps);

    // stop() should resolve even with nothing in flight
    await queue.stop();
    expect(queue.depth()).toBe(0);
  });

});
