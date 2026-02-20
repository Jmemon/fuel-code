/**
 * TUI Shell — top-level Ink application component.
 *
 * Owns the ApiClient and WsClient instances, manages view routing between
 * Dashboard and SessionDetail, and handles global keybindings (q to quit,
 * b to go back). The WsClient connects on mount and disconnects on unmount;
 * connection failure is non-fatal (dashboard falls back to polling).
 *
 * Launched by `fuel-code` with no subcommand via launchTui().
 */

import React, { useState, useEffect } from "react";
import { render, useApp, useInput, Box, Text } from "ink";
import { FuelApiClient } from "../lib/api-client.js";
import { WsClient } from "../lib/ws-client.js";
import { loadConfig } from "../lib/config.js";
import { Dashboard } from "./Dashboard.js";
import { SessionDetailView } from "./SessionDetailView.js";

// ---------------------------------------------------------------------------
// View routing types
// ---------------------------------------------------------------------------

type View =
  | { name: "dashboard" }
  | { name: "session-detail"; sessionId: string };

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

export interface AppProps {
  /** Override the API client (for testing) */
  apiClient?: FuelApiClient;
  /** Override the WS client (for testing) */
  wsClient?: WsClient;
}

export function App({ apiClient, wsClient }: AppProps): React.ReactElement {
  const { exit } = useApp();

  // Create clients once. Use provided overrides (tests) or build from config.
  const [api] = useState<FuelApiClient>(() => {
    if (apiClient) return apiClient;
    return FuelApiClient.fromConfig(loadConfig());
  });

  const [ws] = useState<WsClient>(() => {
    if (wsClient) return wsClient;
    return WsClient.fromConfig(loadConfig());
  });

  const [view, setView] = useState<View>({ name: "dashboard" });

  // Connect WebSocket on mount, subscribe to all, disconnect on unmount.
  // Connection failure is non-fatal — dashboard will fall back to polling.
  useEffect(() => {
    let mounted = true;

    ws.connect()
      .then(() => {
        if (mounted) {
          ws.subscribe({ scope: "all" });
        }
      })
      .catch(() => {
        // WS failure is non-fatal; dashboard will poll instead
      });

    return () => {
      mounted = false;
      ws.disconnect();
    };
  }, [ws]);

  // Global keybindings: q exits, b goes back to dashboard
  useInput((input, key) => {
    if (input === "q") {
      ws.disconnect();
      exit();
      return;
    }

    if (input === "b" && view.name !== "dashboard") {
      setView({ name: "dashboard" });
      return;
    }
  });

  // View routing — session detail view with full TUI components
  if (view.name === "session-detail") {
    return (
      <SessionDetailView
        apiClient={api}
        wsClient={ws}
        sessionId={view.sessionId}
        onBack={() => setView({ name: "dashboard" })}
      />
    );
  }

  return (
    <Dashboard
      api={api}
      ws={ws}
      onSelectSession={(sessionId) =>
        setView({ name: "session-detail", sessionId })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// launchTui — entry point called from CLI index.ts
// ---------------------------------------------------------------------------

export async function launchTui(): Promise<void> {
  const instance = render(<App />);
  await instance.waitUntilExit();
}
