/**
 * Phase 4 E2E integration tests — TUI smoke tests.
 *
 * Tests 19-21: Verify the WorkspacesView TUI component renders correctly
 * with a REAL ApiClient pointed at the test server (not mocks).
 * Uses ink-testing-library for headless rendering.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { EventEmitter } from "events";

import { setupTestServer, type TestServerContext } from "./setup.js";
import { createTestClient, stripAnsi, wait, waitFor } from "./helpers.js";
import { WorkspacesView } from "../../tui/WorkspacesView.js";
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
// Mock WsClient — minimal mock for TUI components that accept a WsClient.
// We use a mock WS client because real WS connection in ink-testing-library
// would add complexity without testing TUI rendering behavior.
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
// Tests 19-21 (updated for drill-down navigation)
// ---------------------------------------------------------------------------

describe("TUI WorkspacesView E2E", () => {
  test("Test 19: WorkspacesView renders workspace list from real backend", async () => {
    const instance = render(
      <WorkspacesView
        api={api as any}
        ws={new MockWsClient() as any}
        onSelectWorkspace={() => {}}
        onTeams={() => {}}
        onQuit={() => {}}
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

    // Header should be present
    expect(output).toContain("WORKSPACES");
  }, 15_000);

  test("Test 20: WorkspacesView shows session count and activity info", async () => {
    const instance = render(
      <WorkspacesView
        api={api as any}
        ws={new MockWsClient() as any}
        onSelectWorkspace={() => {}}
        onTeams={() => {}}
        onQuit={() => {}}
      />,
    );

    // Poll until workspace data loads
    await waitFor(() => {
      const output = strip(instance.lastFrame());
      return output.includes("sessions");
    });

    const output = strip(instance.lastFrame());

    // Session count metadata should appear
    expect(output).toContain("sessions");
  }, 15_000);

  test("Test 21: Enter on workspace calls onSelectWorkspace", async () => {
    let selectedWorkspace: any = null;

    const instance = render(
      <WorkspacesView
        api={api as any}
        ws={new MockWsClient() as any}
        onSelectWorkspace={(ws) => {
          selectedWorkspace = ws;
        }}
        onTeams={() => {}}
        onQuit={() => {}}
      />,
    );

    // Poll until data loads (workspaces visible)
    await waitFor(() => {
      const output = strip(instance.lastFrame());
      return output.includes("fuel-code");
    });

    // Press Enter on the first workspace
    instance.stdin.write("\r");

    // Poll until onSelectWorkspace fires
    await waitFor(() => selectedWorkspace !== null, 3_000);

    expect(selectedWorkspace).toBeTruthy();
    expect(selectedWorkspace.id).toBeTruthy();
  }, 15_000);
});
