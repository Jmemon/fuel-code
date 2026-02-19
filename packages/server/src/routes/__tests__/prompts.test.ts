/**
 * Integration tests for the prompts API endpoints.
 *
 * Tests:
 *   1. GET /api/prompts/pending returns pending prompts for a device
 *   2. GET /api/prompts/pending with no pending: empty array
 *   3. GET /api/prompts/pending without device_id: 400
 *   4. POST /api/prompts/dismiss accepted: sets installed, clears pending
 *   5. POST /api/prompts/dismiss declined: clears pending, sets prompted
 *   6. POST /api/prompts/dismiss with invalid action: 400
 *   7. POST /api/prompts/dismiss with missing fields: 400
 *   8. Auth required on all endpoints
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { logger } from "../../logger.js";
import { createAuthMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createPromptsRouter } from "../prompts.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_prompts";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// ---------------------------------------------------------------------------
// Sample test data
// ---------------------------------------------------------------------------

/** Workspace+device pairs with various prompt states */
const WORKSPACE_DEVICES = [
  {
    workspace_id: "ws-01",
    device_id: "dev-01",
    pending_git_hooks_prompt: true,
    git_hooks_installed: false,
    git_hooks_prompted: false,
    canonical_id: "github.com/user/fuel-code",
    display_name: "fuel-code",
  },
  {
    workspace_id: "ws-02",
    device_id: "dev-01",
    pending_git_hooks_prompt: true,
    git_hooks_installed: false,
    git_hooks_prompted: false,
    canonical_id: "github.com/user/other-repo",
    display_name: "other-repo",
  },
  {
    // Already installed — should not appear in pending
    workspace_id: "ws-03",
    device_id: "dev-01",
    pending_git_hooks_prompt: true,
    git_hooks_installed: true,
    git_hooks_prompted: false,
    canonical_id: "github.com/user/installed-repo",
    display_name: "installed-repo",
  },
  {
    // Already prompted — should not appear in pending
    workspace_id: "ws-04",
    device_id: "dev-01",
    pending_git_hooks_prompt: true,
    git_hooks_installed: false,
    git_hooks_prompted: true,
    canonical_id: "github.com/user/prompted-repo",
    display_name: "prompted-repo",
  },
  {
    // Different device — should not appear for dev-01
    workspace_id: "ws-05",
    device_id: "dev-02",
    pending_git_hooks_prompt: true,
    git_hooks_installed: false,
    git_hooks_prompted: false,
    canonical_id: "github.com/user/other-device-repo",
    display_name: "other-device-repo",
  },
];

// ---------------------------------------------------------------------------
// Mock SQL — mutable state to simulate database updates
// ---------------------------------------------------------------------------

/**
 * Mutable copy of workspace_devices state.
 * Reset before each scenario that modifies state.
 */
let wdState = WORKSPACE_DEVICES.map((wd) => ({ ...wd }));

/**
 * Build a fragment-aware mock postgres.js sql tagged template function.
 *
 * Handles SELECT queries for GET /prompts/pending and UPDATE queries
 * for POST /prompts/dismiss. Mutates wdState to simulate DB changes.
 */
function buildMockSql() {
  const FRAGMENT_MARKER = Symbol("sql-fragment");

  interface SqlFragment {
    [key: symbol]: true;
    text: string;
    values: unknown[];
  }

  function isFragment(val: unknown): val is SqlFragment {
    return typeof val === "object" && val !== null && FRAGMENT_MARKER in val;
  }

  function sqlTaggedTemplate(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): unknown {
    const rawText = strings.join("$");
    const allValues: unknown[] = [];

    for (const v of values) {
      if (isFragment(v)) {
        allValues.push(...v.values);
      } else {
        allValues.push(v);
      }
    }

    const isFullQuery = /SELECT|UPDATE|INSERT|DELETE/i.test(rawText);

    if (!isFullQuery) {
      return {
        [FRAGMENT_MARKER]: true,
        text: rawText,
        values: allValues,
      } as SqlFragment;
    }

    // Handle GET /prompts/pending SELECT query
    if (
      rawText.includes("FROM workspace_devices wd") &&
      rawText.includes("JOIN workspaces w") &&
      rawText.includes("pending_git_hooks_prompt")
    ) {
      const deviceId = allValues[0] as string;
      const results = wdState.filter(
        (wd) =>
          wd.device_id === deviceId &&
          wd.pending_git_hooks_prompt === true &&
          wd.git_hooks_installed === false &&
          wd.git_hooks_prompted === false,
      );
      return Promise.resolve(
        results.map((wd) => ({
          workspace_id: wd.workspace_id,
          canonical_id: wd.canonical_id,
          display_name: wd.display_name,
          device_id: wd.device_id,
        })),
      );
    }

    // Handle POST /prompts/dismiss UPDATE query (accepted)
    if (
      rawText.includes("UPDATE workspace_devices") &&
      rawText.includes("git_hooks_installed")
    ) {
      // The values order depends on which UPDATE variant:
      // "accepted" UPDATE has git_hooks_installed = true (4 columns set)
      // "declined" UPDATE does not have git_hooks_installed
      const isAccepted = rawText.includes("git_hooks_installed = true");

      // workspace_id and device_id are the last two values
      const workspaceId = allValues[allValues.length - 2] as string;
      const deviceId = allValues[allValues.length - 1] as string;

      const wd = wdState.find(
        (w) => w.workspace_id === workspaceId && w.device_id === deviceId,
      );
      if (wd) {
        wd.pending_git_hooks_prompt = false;
        wd.git_hooks_prompted = true;
        if (isAccepted) {
          wd.git_hooks_installed = true;
        }
      }
      return Promise.resolve([]);
    }

    // Handle the declined variant (no git_hooks_installed = true)
    if (
      rawText.includes("UPDATE workspace_devices") &&
      rawText.includes("pending_git_hooks_prompt = false")
    ) {
      const workspaceId = allValues[allValues.length - 2] as string;
      const deviceId = allValues[allValues.length - 1] as string;

      const wd = wdState.find(
        (w) => w.workspace_id === workspaceId && w.device_id === deviceId,
      );
      if (wd) {
        wd.pending_git_hooks_prompt = false;
        wd.git_hooks_prompted = true;
      }
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  }

  const proxy = new Proxy(sqlTaggedTemplate, {
    apply(_target, _thisArg, args) {
      if (args[0] && Array.isArray(args[0]) && "raw" in args[0]) {
        return sqlTaggedTemplate(
          args[0] as TemplateStringsArray,
          ...args.slice(1),
        );
      }
      return args[0];
    },
  });

  return proxy;
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function buildTestApp() {
  const sql = buildMockSql();
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createAuthMiddleware(TEST_API_KEY));
  app.use(
    "/api",
    createPromptsRouter({ sql: sql as any, logger }),
  );
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = buildTestApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function getPrompts(deviceId: string) {
  return fetch(`${baseUrl}/api/prompts/pending?device_id=${deviceId}`, {
    method: "GET",
    headers: { Authorization: AUTH_HEADER },
  });
}

async function dismissPrompt(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/prompts/dismiss`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HEADER,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/prompts/pending", () => {
  test("returns pending prompts for a device", async () => {
    // Reset state
    wdState = WORKSPACE_DEVICES.map((wd) => ({ ...wd }));

    const res = await getPrompts("dev-01");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.prompts).toHaveLength(2);

    // Should include ws-01 and ws-02 (pending, not installed, not prompted)
    const ids = body.prompts.map((p: any) => p.workspace_id);
    expect(ids).toContain("ws-01");
    expect(ids).toContain("ws-02");

    // Should NOT include ws-03 (already installed), ws-04 (already prompted), ws-05 (different device)
    expect(ids).not.toContain("ws-03");
    expect(ids).not.toContain("ws-04");
    expect(ids).not.toContain("ws-05");

    // Verify prompt shape
    const prompt = body.prompts.find((p: any) => p.workspace_id === "ws-01");
    expect(prompt.type).toBe("git_hooks_install");
    expect(prompt.workspace_name).toBe("fuel-code");
    expect(prompt.workspace_canonical_id).toBe("github.com/user/fuel-code");
  });

  test("returns empty array when no pending prompts", async () => {
    wdState = WORKSPACE_DEVICES.map((wd) => ({ ...wd }));

    // dev-03 has no entries in the test data
    const res = await getPrompts("dev-03");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.prompts).toEqual([]);
  });

  test("returns 400 without device_id", async () => {
    const res = await fetch(`${baseUrl}/api/prompts/pending`, {
      method: "GET",
      headers: { Authorization: AUTH_HEADER },
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("device_id");
  });
});

describe("POST /api/prompts/dismiss", () => {
  test("accepted: sets installed=true, clears pending, sets prompted", async () => {
    wdState = WORKSPACE_DEVICES.map((wd) => ({ ...wd }));

    const res = await dismissPrompt({
      workspace_id: "ws-01",
      device_id: "dev-01",
      action: "accepted",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify state was updated
    const wd = wdState.find(
      (w) => w.workspace_id === "ws-01" && w.device_id === "dev-01",
    );
    expect(wd!.git_hooks_installed).toBe(true);
    expect(wd!.pending_git_hooks_prompt).toBe(false);
    expect(wd!.git_hooks_prompted).toBe(true);

    // ws-01 should no longer appear in pending prompts
    const pendingRes = await getPrompts("dev-01");
    const pendingBody = await pendingRes.json();
    const ids = pendingBody.prompts.map((p: any) => p.workspace_id);
    expect(ids).not.toContain("ws-01");
  });

  test("declined: clears pending, sets prompted, does NOT set installed", async () => {
    wdState = WORKSPACE_DEVICES.map((wd) => ({ ...wd }));

    const res = await dismissPrompt({
      workspace_id: "ws-02",
      device_id: "dev-01",
      action: "declined",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify state: installed should remain false
    const wd = wdState.find(
      (w) => w.workspace_id === "ws-02" && w.device_id === "dev-01",
    );
    expect(wd!.git_hooks_installed).toBe(false);
    expect(wd!.pending_git_hooks_prompt).toBe(false);
    expect(wd!.git_hooks_prompted).toBe(true);
  });

  test("returns 400 with invalid action", async () => {
    const res = await dismissPrompt({
      workspace_id: "ws-01",
      device_id: "dev-01",
      action: "maybe",
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("accepted");
  });

  test("returns 400 with missing fields", async () => {
    const res = await dismissPrompt({
      workspace_id: "ws-01",
      // missing device_id and action
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("Missing");
  });
});

describe("Prompts API — auth", () => {
  test("GET /api/prompts/pending returns 401 without token", async () => {
    const res = await fetch(
      `${baseUrl}/api/prompts/pending?device_id=dev-01`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/prompts/dismiss returns 401 without token", async () => {
    const res = await fetch(`${baseUrl}/api/prompts/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "ws-01",
        device_id: "dev-01",
        action: "accepted",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 with wrong Bearer token", async () => {
    const res = await fetch(
      `${baseUrl}/api/prompts/pending?device_id=dev-01`,
      {
        method: "GET",
        headers: { Authorization: "Bearer wrong-key" },
      },
    );
    expect(res.status).toBe(401);
  });
});
