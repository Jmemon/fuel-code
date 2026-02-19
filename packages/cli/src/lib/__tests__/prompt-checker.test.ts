/**
 * Tests for the prompt checker module.
 *
 * Tests that checkPendingPrompts():
 *   1. Returns prompt list from a working backend
 *   2. Returns empty array when backend is unreachable
 *   3. Returns empty array when request times out (>2s)
 *   4. Returns empty array when backend returns non-200
 *
 * Uses a real HTTP server to test actual fetch behavior including timeouts.
 */

import { describe, test, expect, afterAll } from "bun:test";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { FuelCodeConfig } from "../config.js";
import { checkPendingPrompts, dismissPrompt } from "../prompt-checker.js";

// ---------------------------------------------------------------------------
// Test config factory
// ---------------------------------------------------------------------------

function makeConfig(port: number): FuelCodeConfig {
  return {
    backend: {
      url: `http://127.0.0.1:${port}`,
      api_key: "fc_test_key",
    },
    device: {
      id: "dev-test-001",
      name: "test-machine",
      type: "local",
    },
    pipeline: {
      queue_path: "/tmp/fuel-code-test/queue",
      drain_interval_seconds: 30,
      batch_size: 50,
      post_timeout_ms: 2000,
    },
  };
}

/** Config pointing to an unreachable host (port 1 is almost never listening) */
function makeUnreachableConfig(): FuelCodeConfig {
  return makeConfig(1);
}

// ---------------------------------------------------------------------------
// Helper: start a test HTTP server
// ---------------------------------------------------------------------------

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: srv, port });
    });
  });
}

function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    srv.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Servers for each scenario
// ---------------------------------------------------------------------------

const servers: Server[] = [];

afterAll(async () => {
  for (const srv of servers) {
    await closeServer(srv);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkPendingPrompts", () => {
  test("returns prompt list from a working backend", async () => {
    const { server, port } = await startServer((req, res) => {
      // Verify the request has correct auth header and device_id param
      expect(req.url).toContain("device_id=dev-test-001");
      expect(req.headers.authorization).toBe("Bearer fc_test_key");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          prompts: [
            {
              type: "git_hooks_install",
              workspace_id: "ws-01",
              workspace_name: "fuel-code",
              workspace_canonical_id: "github.com/user/fuel-code",
            },
          ],
        }),
      );
    });
    servers.push(server);

    const config = makeConfig(port);
    const prompts = await checkPendingPrompts(config);

    expect(prompts).toHaveLength(1);
    expect(prompts[0].type).toBe("git_hooks_install");
    expect(prompts[0].workspaceId).toBe("ws-01");
    expect(prompts[0].workspaceName).toBe("fuel-code");
    expect(prompts[0].workspaceCanonicalId).toBe("github.com/user/fuel-code");
  });

  test("returns empty array when backend is unreachable", async () => {
    const config = makeUnreachableConfig();
    const prompts = await checkPendingPrompts(config);

    expect(prompts).toEqual([]);
  });

  test("returns empty array when request times out", async () => {
    // Create a server that never responds (simulates timeout)
    const { server, port } = await startServer((_req, _res) => {
      // Intentionally never respond — the 2s timeout should kick in
    });
    servers.push(server);

    const config = makeConfig(port);

    const start = Date.now();
    const prompts = await checkPendingPrompts(config);
    const elapsed = Date.now() - start;

    expect(prompts).toEqual([]);
    // Should have timed out around 2 seconds (allow some margin)
    expect(elapsed).toBeLessThan(5000);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
  });

  test("returns empty array when backend returns non-200", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    });
    servers.push(server);

    const config = makeConfig(port);
    const prompts = await checkPendingPrompts(config);

    expect(prompts).toEqual([]);
  });

  test("returns empty array when response is invalid JSON", async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not valid json!!!");
    });
    servers.push(server);

    const config = makeConfig(port);
    const prompts = await checkPendingPrompts(config);

    expect(prompts).toEqual([]);
  });
});

describe("dismissPrompt", () => {
  test("sends POST with correct body and auth", async () => {
    let receivedBody = "";
    let receivedAuth = "";

    const { server, port } = await startServer((req, res) => {
      receivedAuth = req.headers.authorization ?? "";

      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => {
        receivedBody = data;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    servers.push(server);

    const config = makeConfig(port);
    await dismissPrompt(config, "ws-01", "accepted");

    const parsed = JSON.parse(receivedBody);
    expect(parsed.workspace_id).toBe("ws-01");
    expect(parsed.device_id).toBe("dev-test-001");
    expect(parsed.action).toBe("accepted");
    expect(receivedAuth).toBe("Bearer fc_test_key");
  });

  test("does not throw when backend is unreachable", async () => {
    const config = makeUnreachableConfig();
    // Should not throw — errors are silently swallowed
    await dismissPrompt(config, "ws-01", "declined");
  });
});
