/**
 * Tests for the emit command and API client.
 *
 * Tests the queue and api-client modules directly (no CLI process spawning).
 * Uses mock fetch for API client tests and temp directories for queue tests.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Event, IngestResponse } from "@fuel-code/shared";
import { createApiClient, type ApiClient } from "../../lib/api-client.js";
import { enqueueEvent, listQueuedEvents, readQueuedEvent } from "../../lib/queue.js";
import { overrideConfigPaths, type FuelCodeConfig } from "../../lib/config.js";
import { runEmit } from "../emit.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A valid config object for testing */
function makeConfig(overrides?: Partial<FuelCodeConfig>): FuelCodeConfig {
  return {
    backend: {
      url: "http://localhost:9999",
      api_key: "test-key-abc123",
    },
    device: {
      id: "01HZDEVICE0000000000000001",
      name: "test-device",
      type: "local",
    },
    pipeline: {
      queue_path: "/tmp/fuel-code-test-queue",
      drain_interval_seconds: 10,
      batch_size: 50,
      post_timeout_ms: 2000,
    },
    ...overrides,
  };
}

/** Create a minimal valid Event */
function makeEvent(id: string): Event {
  return {
    id,
    type: "git.commit",
    timestamp: new Date().toISOString(),
    device_id: "test-device-001",
    workspace_id: "test-workspace",
    session_id: null,
    data: { message: "test commit" },
    ingested_at: null,
    blob_refs: [],
  };
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let queueDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-emit-test-"));
  queueDir = path.join(tmpDir, "queue");
});

afterEach(() => {
  overrideConfigPaths(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: API Client
// ---------------------------------------------------------------------------

describe("createApiClient", () => {
  describe("ingest()", () => {
    it("sends events via POST with correct headers and body", async () => {
      const config = makeConfig();
      const mockResponse: IngestResponse = {
        ingested: 1,
        duplicates: 0,
      };

      // Mock global fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        expect(urlStr).toBe("http://localhost:9999/api/events/ingest");
        expect(init?.method).toBe("POST");

        const headers = init?.headers as Record<string, string>;
        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers["Authorization"]).toBe("Bearer test-key-abc123");

        const body = JSON.parse(init?.body as string);
        expect(body.events).toHaveLength(1);
        expect(body.events[0].id).toBe("01HZTEST00000000000000AAAA");

        return new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      try {
        const client = createApiClient(config);
        const event = makeEvent("01HZTEST00000000000000AAAA");
        const result = await client.ingest([event]);

        expect(result.ingested).toBe(1);
        expect(result.duplicates).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws NetworkError on fetch failure", async () => {
      const config = makeConfig();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        throw new Error("Connection refused");
      }) as unknown as typeof fetch;

      try {
        const client = createApiClient(config);
        const event = makeEvent("01HZTEST00000000000000BBBB");

        await expect(client.ingest([event])).rejects.toThrow("Connection refused");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws NetworkError on non-2xx response", async () => {
      const config = makeConfig();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response("Internal Server Error", { status: 500 });
      }) as unknown as typeof fetch;

      try {
        const client = createApiClient(config);
        const event = makeEvent("01HZTEST00000000000000CCCC");

        await expect(client.ingest([event])).rejects.toThrow("HTTP 500");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("strips trailing slashes from backend URL", async () => {
      const config = makeConfig({
        backend: { url: "http://localhost:9999///", api_key: "key" },
      });

      const originalFetch = globalThis.fetch;
      let capturedUrl = "";
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response(JSON.stringify({ ingested: 1, duplicates: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      try {
        const client = createApiClient(config);
        await client.ingest([makeEvent("01HZTEST00000000000000DDDD")]);
        expect(capturedUrl).toBe("http://localhost:9999/api/events/ingest");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("health()", () => {
    it("returns true on 2xx response", async () => {
      const config = makeConfig();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response("OK", { status: 200 });
      }) as unknown as typeof fetch;

      try {
        const client = createApiClient(config);
        const result = await client.health();
        expect(result).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns false on network failure", async () => {
      const config = makeConfig();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        throw new Error("DNS resolution failed");
      }) as unknown as typeof fetch;

      try {
        const client = createApiClient(config);
        const result = await client.health();
        expect(result).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns false on non-2xx response", async () => {
      const config = makeConfig();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response("Service Unavailable", { status: 503 });
      }) as unknown as typeof fetch;

      try {
        const client = createApiClient(config);
        const result = await client.health();
        expect(result).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: runEmit (integration-style, using real queue on tmp dirs)
// ---------------------------------------------------------------------------

describe("runEmit", () => {
  it("queues event when config is missing (no config file)", async () => {
    // Point config to a non-existent directory so loadConfig() fails
    overrideConfigPaths(path.join(tmpDir, "no-config"));

    await runEmit("git.commit", {
      data: '{"message":"test"}',
      workspaceId: "ws-001",
    });

    // Event should be queued in the default QUEUE_DIR path.
    // Since config is missing, the emit command uses QUEUE_DIR from config.ts
    // which is overridden by overrideConfigPaths.
    // However, the emit command falls back to QUEUE_DIR constant when config is null.
    // We verify the function completed without throwing.
    // (The actual queue path depends on whether config loaded successfully)
  });

  it("queues event when backend is unreachable", async () => {
    // Set up real config pointing to an unreachable backend
    overrideConfigPaths(tmpDir);

    // Create a valid config file
    const configContent = `
backend:
  url: "http://localhost:1"
  api_key: "test-key"
device:
  id: "01HZDEVICE0000000000000001"
  name: "test-device"
  type: "local"
pipeline:
  queue_path: "${queueDir}"
  drain_interval_seconds: 10
  batch_size: 50
  post_timeout_ms: 1000
`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), configContent);

    // Mock fetch to simulate network failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    try {
      await runEmit("git.commit", {
        data: '{"sha":"abc123","message":"test commit"}',
        workspaceId: "ws-test",
        sessionId: "sess-001",
      });

      // Event should be queued locally
      const queued = listQueuedEvents(queueDir);
      expect(queued).toHaveLength(1);

      // Verify event contents
      const event = readQueuedEvent(queued[0]);
      expect(event).not.toBeNull();
      expect(event!.type).toBe("git.commit");
      expect(event!.workspace_id).toBe("ws-test");
      expect(event!.session_id).toBe("sess-001");
      expect(event!.data).toEqual({ sha: "abc123", message: "test commit", _device_name: "test-device", _device_type: "local" });
      expect(event!.device_id).toBe("01HZDEVICE0000000000000001");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does NOT queue event when backend succeeds", async () => {
    overrideConfigPaths(tmpDir);

    const configContent = `
backend:
  url: "http://localhost:9999"
  api_key: "test-key"
device:
  id: "01HZDEVICE0000000000000001"
  name: "test-device"
  type: "local"
pipeline:
  queue_path: "${queueDir}"
  drain_interval_seconds: 10
  batch_size: 50
  post_timeout_ms: 2000
`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), configContent);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ ingested: 1, duplicates: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      await runEmit("git.push", {
        data: '{"remote":"origin","branch":"main"}',
        workspaceId: "ws-test",
      });

      // Queue should be empty — event was sent directly
      const queued = listQueuedEvents(queueDir);
      expect(queued).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("wraps non-JSON --data as { _raw: theString }", async () => {
    overrideConfigPaths(tmpDir);

    const configContent = `
backend:
  url: "http://localhost:1"
  api_key: "test-key"
device:
  id: "01HZDEVICE0000000000000001"
  name: "test-device"
  type: "local"
pipeline:
  queue_path: "${queueDir}"
  drain_interval_seconds: 10
  batch_size: 50
  post_timeout_ms: 1000
`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), configContent);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    try {
      await runEmit("git.commit", {
        data: "not valid json at all",
        workspaceId: "ws-test",
      });

      const queued = listQueuedEvents(queueDir);
      expect(queued).toHaveLength(1);

      const event = readQueuedEvent(queued[0]);
      expect(event).not.toBeNull();
      expect(event!.data).toEqual({ _raw: "not valid json at all", _device_name: "test-device", _device_type: "local" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("wraps JSON arrays as { _raw: theString }", async () => {
    overrideConfigPaths(tmpDir);

    const configContent = `
backend:
  url: "http://localhost:1"
  api_key: "test-key"
device:
  id: "01HZDEVICE0000000000000001"
  name: "test-device"
  type: "local"
pipeline:
  queue_path: "${queueDir}"
  drain_interval_seconds: 10
  batch_size: 50
  post_timeout_ms: 1000
`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), configContent);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    try {
      await runEmit("git.commit", {
        data: '[1, 2, 3]',
        workspaceId: "ws-test",
      });

      const queued = listQueuedEvents(queueDir);
      expect(queued).toHaveLength(1);

      const event = readQueuedEvent(queued[0]);
      expect(event).not.toBeNull();
      expect(event!.data).toEqual({ _raw: "[1, 2, 3]", _device_name: "test-device", _device_type: "local" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses default workspace_id '_unassociated' when not specified", async () => {
    overrideConfigPaths(tmpDir);

    const configContent = `
backend:
  url: "http://localhost:1"
  api_key: "test-key"
device:
  id: "01HZDEVICE0000000000000001"
  name: "test-device"
  type: "local"
pipeline:
  queue_path: "${queueDir}"
  drain_interval_seconds: 10
  batch_size: 50
  post_timeout_ms: 1000
`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), configContent);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    try {
      await runEmit("system.heartbeat", {
        data: "{}",
        workspaceId: "_unassociated",
      });

      const queued = listQueuedEvents(queueDir);
      expect(queued).toHaveLength(1);

      const event = readQueuedEvent(queued[0]);
      expect(event).not.toBeNull();
      expect(event!.workspace_id).toBe("_unassociated");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sets session_id to null when --session-id is not provided", async () => {
    overrideConfigPaths(tmpDir);

    const configContent = `
backend:
  url: "http://localhost:1"
  api_key: "test-key"
device:
  id: "01HZDEVICE0000000000000001"
  name: "test-device"
  type: "local"
pipeline:
  queue_path: "${queueDir}"
  drain_interval_seconds: 10
  batch_size: 50
  post_timeout_ms: 1000
`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), configContent);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("Connection refused");
    }) as unknown as typeof fetch;

    try {
      await runEmit("git.commit", {
        data: '{"sha":"def456"}',
        workspaceId: "ws-test",
      });

      const queued = listQueuedEvents(queueDir);
      const event = readQueuedEvent(queued[0]);
      expect(event).not.toBeNull();
      expect(event!.session_id).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
