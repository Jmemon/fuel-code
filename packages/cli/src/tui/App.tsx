/**
 * TUI Shell — top-level Ink application component.
 *
 * Owns the ApiClient and WsClient instances, manages view routing between
 * WorkspacesView, SessionsView, SessionDetail, TeamsListView, and
 * TeamDetailView using a drill-down navigation model:
 *
 *   WorkspacesView → SessionsView → SessionDetailView
 *                  → TeamsListView → TeamDetailView → SessionDetailView
 *
 * The WsClient connects on mount and disconnects on unmount; connection
 * failure is non-fatal (views fall back to polling).
 *
 * Launched by `fuel-code` with no subcommand via launchTui().
 */

import React, { useState, useEffect } from "react";
import { render, useApp, useInput } from "ink";
import { FuelApiClient } from "../lib/api-client.js";
import type { WorkspaceSummary } from "../lib/api-client.js";
import { WsClient } from "../lib/ws-client.js";
import { loadConfig } from "../lib/config.js";
import { WorkspacesView } from "./WorkspacesView.js";
import { SessionsView } from "./SessionsView.js";
import { SessionDetailView } from "./SessionDetailView.js";
import { TeamsListView } from "./TeamsListView.js";
import { TeamDetailView } from "./TeamDetailView.js";

// ---------------------------------------------------------------------------
// View routing types — drill-down navigation hierarchy
// ---------------------------------------------------------------------------

type View =
  | { name: "workspaces" }
  | { name: "sessions"; workspace: WorkspaceSummary }
  | { name: "session-detail"; sessionId: string; fromView: "sessions" | "team-detail"; workspace?: WorkspaceSummary; teamName?: string }
  | { name: "teams-list"; fromView: "workspaces" | "sessions"; workspace?: WorkspaceSummary }
  | { name: "team-detail"; teamName: string; fromView: "workspaces" | "sessions"; workspace?: WorkspaceSummary };

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

  const [view, setView] = useState<View>({ name: "workspaces" });

  // Connect WebSocket on mount, subscribe to all, disconnect on unmount.
  // Connection failure is non-fatal — views will fall back to polling.
  useEffect(() => {
    let mounted = true;

    ws.connect()
      .then(() => {
        if (mounted) {
          ws.subscribe({ scope: "all" });
        }
      })
      .catch(() => {
        // WS failure is non-fatal; views will poll instead
      });

    return () => {
      mounted = false;
      ws.disconnect();
    };
  }, [ws]);

  // Global quit handler — 'q' is handled by each view's onQuit callback
  // to avoid double-handling. Only catch it here for views that don't
  // have their own quit handler (session-detail).
  useInput((input) => {
    if (input === "q" && (view.name === "session-detail")) {
      ws.disconnect();
      exit();
    }
  });

  // View routing — drill-down hierarchy
  if (view.name === "workspaces") {
    return (
      <WorkspacesView
        api={api}
        ws={ws}
        onSelectWorkspace={(workspace) =>
          setView({ name: "sessions", workspace })
        }
        onTeams={() => setView({ name: "teams-list", fromView: "workspaces" })}
        onQuit={() => { ws.disconnect(); exit(); }}
      />
    );
  }

  if (view.name === "sessions") {
    return (
      <SessionsView
        api={api}
        ws={ws}
        workspace={view.workspace}
        onSelectSession={(sessionId) =>
          setView({ name: "session-detail", sessionId, fromView: "sessions", workspace: view.workspace })
        }
        onBack={() => setView({ name: "workspaces" })}
        onTeams={() => setView({ name: "teams-list", fromView: "sessions", workspace: view.workspace })}
        onQuit={() => { ws.disconnect(); exit(); }}
      />
    );
  }

  if (view.name === "session-detail") {
    return (
      <SessionDetailView
        apiClient={api}
        wsClient={ws}
        sessionId={view.sessionId}
        onBack={() => {
          if (view.fromView === "sessions" && view.workspace) {
            setView({ name: "sessions", workspace: view.workspace });
          } else if (view.fromView === "team-detail" && view.teamName) {
            setView({ name: "team-detail", teamName: view.teamName, fromView: view.workspace ? "sessions" : "workspaces", workspace: view.workspace });
          } else {
            setView({ name: "workspaces" });
          }
        }}
      />
    );
  }

  if (view.name === "teams-list") {
    return (
      <TeamsListView
        apiClient={api}
        onSelectTeam={(teamName) =>
          setView({ name: "team-detail", teamName, fromView: view.fromView, workspace: view.workspace })
        }
        onBack={() => {
          if (view.fromView === "sessions" && view.workspace) {
            setView({ name: "sessions", workspace: view.workspace });
          } else {
            setView({ name: "workspaces" });
          }
        }}
      />
    );
  }

  if (view.name === "team-detail") {
    return (
      <TeamDetailView
        apiClient={api}
        teamName={view.teamName}
        onSelectSession={(sessionId) =>
          setView({ name: "session-detail", sessionId, fromView: "team-detail", workspace: view.workspace, teamName: view.teamName })
        }
        onBack={() => setView({ name: "teams-list", fromView: view.fromView, workspace: view.workspace })}
      />
    );
  }

  // Fallback (should never reach)
  return (
    <WorkspacesView
      api={api}
      ws={ws}
      onSelectWorkspace={(workspace) =>
        setView({ name: "sessions", workspace })
      }
      onTeams={() => setView({ name: "teams-list", fromView: "workspaces" })}
      onQuit={() => { ws.disconnect(); exit(); }}
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
