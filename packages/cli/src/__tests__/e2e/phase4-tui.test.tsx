/**
 * Phase 4 E2E integration tests — TUI smoke tests.
 *
 * Tests 19-21: Verify the Dashboard TUI component renders correctly
 * with a REAL ApiClient pointed at the test server (not mocks).
 * Uses ink-testing-library for headless rendering.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { EventEmitter } from "events";

import { setupTestServer, type TestServerContext } from "./setup.js";
import { createTestClient, stripAnsi, wait, waitFor } from "./helpers.js";
import { Dashboard } from "../../tui/Dashboard.js";
import type { FuelApiClient } from "../../lib/api-client.js";

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let ctx: TestServerContext;
let api: FuelApiClient;

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await setupTestServer();
  api = createTestClient(ctx.baseUrl, ctx.apiKey);
}, 30_000);

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  if (ctx?.cleanup) {
    await ctx.cleanup();
  }
}, 15_000);

// ---------------------------------------------------------------------------
// ANSI stripping helper
// ---------------------------------------------------------------------------

/** Strip ANSI codes, handling undefined from ink's lastFrame() */
function strip(s: string | undefined): string {
  return stripAnsi(s ?? "");
}

// ---------------------------------------------------------------------------
// Mock WsClient — same pattern as Dashboard.test.tsx
// We use a mock WS client because real WS connection in ink-testing-library
// would add complexity without testing TUI rendering behavior.
// The real WS is tested separately in phase4-ws.test.ts.
// ---------------------------------------------------------------------------

class MockWsClient extends EventEmitter {
  connected = false;
  _state: string = "disconnected";

  get state() {
    return this._state;
  }

  async connect() {
    this.connected = true;
    this._state = "connected";
  }

  disconnect() {
    this.connected = false;
    this._state = "disconnected";
  }

  subscribe() {}
  unsubscribe() {}
  destroy() {}
}

// ---------------------------------------------------------------------------
// Tests 19-21
// ---------------------------------------------------------------------------

describe("TUI Dashboard E2E", () => {
  test("Test 19: Dashboard renders workspace list from real backend", async () => {
    const instance = render(
      <Dashboard
        api={api as any}
        ws={new MockWsClient() as any}
        onSelectSession={() => {}}
      />,
    );

    // Poll until workspace data loads from the real backend
    await waitFor(() => {
      const output = strip(instance.lastFrame());
      return output.includes("fuel-code") && output.includes("api-service");
    });

    const output = strip(instance.lastFrame());

    // All 3 seeded workspaces should appear
    expect(output).toContain("fuel-code");
    expect(output).toContain("api-service");
    expect(output).toContain("_unassociated");

    // Pane headers should be present
    expect(output).toContain("WORKSPACES");
    expect(output).toContain("SESSIONS");
  }, 15_000);

  test("Test 20: Dashboard renders sessions for selected workspace", async () => {
    const instance = render(
      <Dashboard
        api={api as any}
        ws={new MockWsClient() as any}
        onSelectSession={() => {}}
      />,
    );

    // Poll until session lifecycle indicators appear (data loaded)
    await waitFor(() => {
      const output = strip(instance.lastFrame());
      return output.includes("LIVE") || output.includes("DONE") || output.includes("FAIL");
    });

    const output = strip(instance.lastFrame());

    // The first workspace is selected by default. Sessions for it should show.
    const hasLifecycleIndicator =
      output.includes("LIVE") ||
      output.includes("DONE") ||
      output.includes("FAIL");
    expect(hasLifecycleIndicator).toBe(true);
  }, 15_000);

  test("Test 21: Enter on session calls onSelectSession with session ID", async () => {
    let selectedId = "";

    const instance = render(
      <Dashboard
        api={api as any}
        ws={new MockWsClient() as any}
        onSelectSession={(id) => {
          selectedId = id;
        }}
      />,
    );

    // Poll until data loads (sessions visible)
    await waitFor(() => {
      const output = strip(instance.lastFrame());
      return output.includes("LIVE") || output.includes("DONE") || output.includes("FAIL");
    });

    // Switch focus to sessions pane (Tab), then press Enter
    instance.stdin.write("\t");
    await wait(100);
    instance.stdin.write("\r");

    // Poll until onSelectSession fires
    await waitFor(() => selectedId.length > 0, 3_000);

    expect(selectedId).toBeTruthy();
    expect(selectedId.length).toBeGreaterThan(0);
  }, 15_000);
});
