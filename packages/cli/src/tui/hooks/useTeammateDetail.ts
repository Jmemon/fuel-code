/**
 * useTeammateDetail — React hook for fetching a single teammate's info
 * and their stitched message feed.
 *
 * Fetches two endpoints in parallel on mount:
 *   - GET /api/sessions/:sessionId/teammates (to find this teammate's info)
 *   - GET /api/sessions/:sessionId/teammates/:teammateId/messages (stitched feed)
 *
 * Returns { teammate, messages, loading, error, refresh }.
 * Follows the same loading/error/refresh pattern as useTeamDetail and
 * useSessionDetail hooks elsewhere in the TUI.
 */

import { useState, useEffect, useCallback } from "react";
import type { FuelApiClient, TeammateResponse, TeammateMessageResponse } from "../../lib/api-client.js";

// ---------------------------------------------------------------------------
// Hook result interface
// ---------------------------------------------------------------------------

export interface UseTeammateDetailResult {
  teammate: TeammateResponse | null;
  messages: TeammateMessageResponse[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useTeammateDetail(
  api: FuelApiClient,
  sessionId: string,
  teammateId: string,
): UseTeammateDetailResult {
  const [teammate, setTeammate] = useState<TeammateResponse | null>(null);
  const [messages, setMessages] = useState<TeammateMessageResponse[]>([]);
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

    // Fetch teammate info and messages in parallel.
    // The teammates list endpoint returns all teammates for the session;
    // we find the one matching teammateId from the array.
    Promise.all([
      api.getSessionTeammates(sessionId),
      api.getTeammateMessages(sessionId, teammateId),
    ])
      .then(([teammates, msgs]) => {
        if (!cancelled) {
          const match = teammates.find((t) => t.id === teammateId) ?? null;
          setTeammate(match);
          setMessages(msgs);
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
  }, [api, sessionId, teammateId, refreshKey]);

  return { teammate, messages, loading, error, refresh };
}
