/**
 * Hook to fetch the workspace list from the API.
 *
 * Returns workspaces sorted by last activity (most recent first), along
 * with loading/error states and a refresh function. Used by the Dashboard
 * to populate the left pane workspace list.
 */

import { useState, useEffect, useCallback } from "react";
import type { FuelApiClient, WorkspaceSummary } from "../../lib/api-client.js";
import { fetchWorkspaces } from "../../commands/workspaces.js";

export interface UseWorkspacesResult {
  workspaces: WorkspaceSummary[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

export function useWorkspaces(api: FuelApiClient): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
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

    fetchWorkspaces(api)
      .then((data) => {
        if (!cancelled) {
          setWorkspaces(data);
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

  return { workspaces, loading, error, refresh };
}
