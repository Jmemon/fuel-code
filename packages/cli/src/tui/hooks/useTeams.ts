/**
 * Hooks for fetching teams data from the API.
 *
 * useTeams() — fetches the paginated teams list for TeamsListView.
 * useTeamDetail(teamName) — fetches a single team with its sub-agent members
 *                           for TeamDetailView.
 *
 * Both follow the same loading/error/refresh pattern as useWorkspaces and
 * useSessions hooks used elsewhere in the TUI.
 */

import { useState, useEffect, useCallback } from "react";
import type { FuelApiClient } from "../../lib/api-client.js";

// ---------------------------------------------------------------------------
// Types — mirroring the server's response shapes
// ---------------------------------------------------------------------------

/** Lead session info embedded in team responses */
export interface TeamLeadSession {
  id: string;
  initial_prompt: string | null;
  started_at: string;
  lifecycle: string;
}

/** A team summary as returned by GET /api/teams */
export interface TeamSummary {
  id: string;
  team_name: string;
  description: string | null;
  lead_session_id: string | null;
  lead_session: TeamLeadSession | null;
  created_at: string;
  ended_at: string | null;
  member_count: number;
  metadata: Record<string, unknown>;
}

/** A sub-agent member as returned by GET /api/teams/:name */
export interface TeamMember {
  id: string;
  agent_id: string;
  agent_type: string;
  agent_name: string | null;
  model: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  session_id: string | null;
}

/** Full team detail with members, as returned by GET /api/teams/:name */
export interface TeamDetail extends TeamSummary {
  members: TeamMember[];
}

// ---------------------------------------------------------------------------
// useTeams — list hook with cursor pagination
// ---------------------------------------------------------------------------

export interface UseTeamsResult {
  teams: TeamSummary[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  hasMore: boolean;
  loadMore: () => void;
}

export function useTeams(api: FuelApiClient): UseTeamsResult {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const refresh = useCallback(() => {
    setTeams([]);
    setNextCursor(null);
    setRefreshKey((k) => k + 1);
  }, []);

  // Fetch teams list via the generic request helper on FuelApiClient.
  // The API client doesn't have a dedicated teams method yet, so we use
  // a raw GET through the listTeams method we add below.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTeamsList(api, { limit: 50 })
      .then((result) => {
        if (!cancelled) {
          setTeams(result.teams);
          setNextCursor(result.next_cursor);
          setHasMore(result.has_more);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, refreshKey]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loading) return;

    setLoading(true);
    fetchTeamsList(api, { limit: 50, cursor: nextCursor })
      .then((result) => {
        setTeams((prev) => [...prev, ...result.teams]);
        setNextCursor(result.next_cursor);
        setHasMore(result.has_more);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [api, nextCursor, loading]);

  return { teams, loading, error, refresh, hasMore, loadMore };
}

// ---------------------------------------------------------------------------
// useTeamDetail — single team with members
// ---------------------------------------------------------------------------

export interface UseTeamDetailResult {
  team: TeamDetail | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useTeamDetail(
  api: FuelApiClient,
  teamName: string,
): UseTeamDetailResult {
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTeamDetail(api, teamName)
      .then((result) => {
        if (!cancelled) {
          setTeam(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, teamName, refreshKey]);

  return { team, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// Data fetching helpers — call the API endpoints directly via FuelApiClient
// ---------------------------------------------------------------------------

/** Response shape for GET /api/teams */
interface TeamsListResponse {
  teams: TeamSummary[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Fetch teams list from GET /api/teams.
 * Uses the FuelApiClient's listTeams method (added to api-client.ts).
 */
async function fetchTeamsList(
  api: FuelApiClient,
  params: { limit?: number; cursor?: string },
): Promise<TeamsListResponse> {
  return api.listTeams(params);
}

/**
 * Fetch team detail from GET /api/teams/:name.
 * Returns the team with its sub-agent members array.
 */
async function fetchTeamDetail(
  api: FuelApiClient,
  teamName: string,
): Promise<TeamDetail> {
  const res = await api.getTeam(teamName);
  return res.team;
}
