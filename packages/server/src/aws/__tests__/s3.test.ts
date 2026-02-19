/**
 * Tests for the S3 client abstraction layer.
 *
 * Two test suites:
 *   1. Unit tests — mock-based, always run, verify error handling and interface shape
 *   2. Integration tests — require LocalStack (S3_TEST_BUCKET + S3_ENDPOINT env vars),
 *      skipped when no S3 endpoint is available
 *
 * To run integration tests locally:
 *   docker run -d -p 4566:4566 localstack/localstack
 *   awslocal s3 mb s3://fuel-code-test
 *   S3_TEST_BUCKET=fuel-code-test S3_ENDPOINT=http://localhost:4566 bun test
 */

import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { StorageError } from "@fuel-code/shared";
import { createS3Client } from "../s3.js";
import type { FuelCodeS3Client } from "../s3.js";
import type { S3Config } from "../s3-config.js";
import { loadS3Config } from "../s3-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a silent pino-like logger that captures calls for assertion */
function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    fatal: mock(() => {}),
    trace: mock(() => {}),
    child: mock(function (this: any) { return this; }),
  } as any;
}

/** Generate a unique S3 key prefix per test run to avoid collisions */
function testKey(suffix: string): string {
  return `test/${randomUUID()}/${suffix}`;
}

// ---------------------------------------------------------------------------
// Unit tests — always run, no S3 required
// ---------------------------------------------------------------------------

describe("loadS3Config", () => {
  test("returns defaults when no env vars are set", () => {
    // Save and clear env vars
    const saved = {
      S3_BUCKET: process.env.S3_BUCKET,
      S3_REGION: process.env.S3_REGION,
      S3_ENDPOINT: process.env.S3_ENDPOINT,
      S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
    };
    delete process.env.S3_BUCKET;
    delete process.env.S3_REGION;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_FORCE_PATH_STYLE;

    const config = loadS3Config();
    expect(config.bucket).toBe("fuel-code-blobs");
    expect(config.region).toBe("us-east-1");
    expect(config.endpoint).toBeUndefined();
    expect(config.forcePathStyle).toBeUndefined();

    // Restore env vars
    Object.entries(saved).forEach(([k, v]) => {
      if (v !== undefined) process.env[k] = v;
    });
  });

  test("reads S3_ENDPOINT when set", () => {
    const saved = process.env.S3_ENDPOINT;
    process.env.S3_ENDPOINT = "http://localhost:4566";

    const config = loadS3Config();
    expect(config.endpoint).toBe("http://localhost:4566");

    if (saved !== undefined) process.env.S3_ENDPOINT = saved;
    else delete process.env.S3_ENDPOINT;
  });

  test("reads S3_FORCE_PATH_STYLE when set to 'true'", () => {
    const saved = process.env.S3_FORCE_PATH_STYLE;
    process.env.S3_FORCE_PATH_STYLE = "true";

    const config = loadS3Config();
    expect(config.forcePathStyle).toBe(true);

    if (saved !== undefined) process.env.S3_FORCE_PATH_STYLE = saved;
    else delete process.env.S3_FORCE_PATH_STYLE;
  });
});

describe("createS3Client — interface shape", () => {
  test("returns an object with all expected methods", () => {
    const logger = createMockLogger();
    const config: S3Config = { bucket: "test-bucket", region: "us-east-1" };
    const s3 = createS3Client(config, logger);

    expect(typeof s3.upload).toBe("function");
    expect(typeof s3.uploadFile).toBe("function");
    expect(typeof s3.download).toBe("function");
    expect(typeof s3.downloadStream).toBe("function");
    expect(typeof s3.presignedUrl).toBe("function");
    expect(typeof s3.headObject).toBe("function");
    expect(typeof s3.delete).toBe("function");
    expect(typeof s3.healthCheck).toBe("function");
  });
});

describe("createS3Client — error handling (no real S3)", () => {
  test("upload throws StorageError with STORAGE_S3_UPLOAD_FAILED on network error", async () => {
    const logger = createMockLogger();
    // Use a bogus endpoint that will fail immediately
    const config: S3Config = {
      bucket: "nonexistent-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:1",
      forcePathStyle: true,
    };
    const s3 = createS3Client(config, logger);

    try {
      await s3.upload("test-key", "test-content");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("STORAGE_S3_UPLOAD_FAILED");
    }
  });

  test("download throws StorageError with STORAGE_S3_DOWNLOAD_FAILED on network error", async () => {
    const logger = createMockLogger();
    const config: S3Config = {
      bucket: "nonexistent-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:1",
      forcePathStyle: true,
    };
    const s3 = createS3Client(config, logger);

    try {
      await s3.download("test-key");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      const code = (err as StorageError).code;
      // Could be NOT_FOUND or DOWNLOAD_FAILED depending on the error type
      expect(code).toMatch(/STORAGE_S3_(NOT_FOUND|DOWNLOAD_FAILED)/);
    }
  });

  test("healthCheck returns ok:false on connection failure (never throws)", async () => {
    const logger = createMockLogger();
    const config: S3Config = {
      bucket: "nonexistent-bucket",
      region: "us-east-1",
      endpoint: "http://localhost:1",
      forcePathStyle: true,
    };
    const s3 = createS3Client(config, logger);

    const result = await s3.healthCheck();
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require LocalStack or real S3
// Skipped when S3_TEST_BUCKET is not set
// ---------------------------------------------------------------------------

const hasS3 = !!process.env.S3_TEST_BUCKET;

describe.skipIf(!hasS3)("S3 integration tests (LocalStack)", () => {
  let s3: FuelCodeS3Client;
  let logger: ReturnType<typeof createMockLogger>;
  /** Track all keys created during the test so we can clean up */
  const createdKeys: string[] = [];

  beforeAll(() => {
    logger = createMockLogger();
    const config: S3Config = {
      bucket: process.env.S3_TEST_BUCKET!,
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
    };
    s3 = createS3Client(config, logger);
  });

  /** Clean up all objects created during the test run */
  afterAll(async () => {
    for (const key of createdKeys) {
      try {
        await s3.delete(key);
      } catch {
        // Best-effort cleanup — don't fail the suite
      }
    }
  });

  test("upload a string, download it back, verify content matches", async () => {
    const key = testKey("round-trip.txt");
    createdKeys.push(key);

    const content = "Hello, fuel-code! This is a round-trip test.";
    const result = await s3.upload(key, content, "text/plain");

    expect(result.key).toBe(key);
    expect(result.size).toBe(Buffer.byteLength(content));

    const downloaded = await s3.download(key);
    expect(downloaded).toBe(content);
  });

  test("upload a file from disk, download and verify", async () => {
    const key = testKey("file-upload.txt");
    createdKeys.push(key);

    // Write a temp file to disk
    const tempPath = join(tmpdir(), `fuel-code-test-${randomUUID()}.txt`);
    const fileContent = "File upload test content — streaming from disk to S3.";
    await Bun.write(tempPath, fileContent);

    const result = await s3.uploadFile(key, tempPath, "text/plain");
    expect(result.key).toBe(key);
    expect(result.size).toBe(Buffer.byteLength(fileContent));

    const downloaded = await s3.download(key);
    expect(downloaded).toBe(fileContent);

    // Clean up temp file
    const { unlink } = await import("fs/promises");
    await unlink(tempPath).catch(() => {});
  });

  test("headObject returns { exists: true, size: N } for uploaded object", async () => {
    const key = testKey("head-exists.txt");
    createdKeys.push(key);

    const content = "head object test";
    await s3.upload(key, content, "text/plain");

    const head = await s3.headObject(key);
    expect(head.exists).toBe(true);
    expect(head.size).toBe(Buffer.byteLength(content));
  });

  test("headObject returns { exists: false } for non-existent key (no throw)", async () => {
    const key = testKey("does-not-exist.txt");

    const head = await s3.headObject(key);
    expect(head.exists).toBe(false);
    expect(head.size).toBeUndefined();
  });

  test("presignedUrl returns a URL string starting with 'http'", async () => {
    const key = testKey("presign-test.txt");
    createdKeys.push(key);

    await s3.upload(key, "presign content", "text/plain");

    const url = await s3.presignedUrl(key);
    expect(typeof url).toBe("string");
    expect(url.startsWith("http")).toBe(true);
  });

  test("download non-existent key throws error with code containing 'NOT_FOUND'", async () => {
    const key = testKey("never-uploaded.txt");

    try {
      await s3.download(key);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toContain("NOT_FOUND");
    }
  });

  test("healthCheck returns { ok: true } when bucket is accessible", async () => {
    const result = await s3.healthCheck();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("upload with empty string is handled gracefully", async () => {
    const key = testKey("empty-upload.txt");
    createdKeys.push(key);

    const result = await s3.upload(key, "", "text/plain");
    expect(result.key).toBe(key);
    expect(result.size).toBe(0);

    const downloaded = await s3.download(key);
    expect(downloaded).toBe("");
  });

  test("delete removes an object", async () => {
    const key = testKey("delete-me.txt");

    await s3.upload(key, "to be deleted", "text/plain");

    // Verify it exists
    const headBefore = await s3.headObject(key);
    expect(headBefore.exists).toBe(true);

    // Delete it
    await s3.delete(key);

    // Verify it's gone
    const headAfter = await s3.headObject(key);
    expect(headAfter.exists).toBe(false);
  });

  test("downloadStream returns a readable stream", async () => {
    const key = testKey("stream-test.txt");
    createdKeys.push(key);

    const content = "streaming download test content";
    await s3.upload(key, content, "text/plain");

    const stream = await s3.downloadStream(key);
    expect(stream).toBeDefined();

    // Read the stream to verify content
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.value) chunks.push(result.value);
      done = result.done;
    }

    const decoder = new TextDecoder();
    const text = chunks.map((c) => decoder.decode(c, { stream: true })).join("");
    expect(text).toBe(content);
  });
});
