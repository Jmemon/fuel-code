/**
 * Hook to fetch sessions for a given workspace from the API.
 *
 * Supports imperative updates (updateSession, prependSession) so the
 * Dashboard can apply WebSocket live updates without a full re-fetch.
 * Re-fetches automatically when workspaceId changes.
 */

import { useState, useEffect, useCallback } from "react";
import type { Session } from "@fuel-code/shared";
import type { FuelApiClient } from "../../lib/api-client.js";
import { fetchSessions } from "../../commands/sessions.js";

export interface UseSessionsResult {
  sessions: Session[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  /** Update a session in-place by ID (merges fields) */
  updateSession: (sessionId: string, patch: Partial<Session>) => void;
  /** Prepend a new session to the top of the list */
  prependSession: (session: Session) => void;
}

export function useSessions(
  api: FuelApiClient,
  workspaceId: string | null,
): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const updateSession = useCallback(
    (sessionId: string, patch: Partial<Session>) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  const prependSession = useCallback((session: Session) => {
    setSessions((prev) => [session, ...prev]);
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setSessions([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSessions(api, { workspaceId, limit: 50 })
      .then((result) => {
        if (!cancelled) {
          setSessions(result.sessions);
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
  }, [api, workspaceId, refreshKey]);

  return { sessions, loading, error, refresh, updateSession, prependSession };
}
