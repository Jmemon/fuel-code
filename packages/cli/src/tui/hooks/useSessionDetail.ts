/**
 * useSessionDetail — React hook for parallel data fetching + WS subscription.
 *
 * Fetches session detail, transcript, and git activity in parallel on mount.
 * Events are fetched lazily (only when the events tab is first opened).
 * For live sessions, subscribes to the session via WebSocket and updates
 * header data on session.update messages.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { FuelApiClient } from "../../lib/api-client.js";
import type { WsClient } from "../../lib/ws-client.js";
import type { Event, GitActivity, TranscriptMessage } from "@fuel-code/shared";
import {
  fetchSessionDetail,
  fetchSessionTranscript,
  fetchSessionGit,
  fetchSessionEvents,
  type SessionDetail,
  type SessionExportData,
} from "../../commands/session-detail.js";
import type { TranscriptMessageWithBlocks } from "../components/MessageBlock.js";

export interface UseSessionDetailResult {
  session: SessionDetail | null;
  transcript: TranscriptMessageWithBlocks[] | null;
  events: Event[] | null;
  gitActivity: GitActivity[];
  loading: boolean;
  error: string | null;
  /** Fetch events lazily (called when switching to events tab) */
  fetchEvents: () => void;
  /** Whether events have been fetched */
  eventsFetched: boolean;
  /** Whether the session is live (capturing) */
  isLive: boolean;
  /** Export data for the session */
  getExportData: () => SessionExportData | null;
}

export function useSessionDetail(
  apiClient: FuelApiClient,
  wsClient: WsClient | null,
  sessionId: string,
): UseSessionDetailResult {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessageWithBlocks[] | null>(null);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [gitActivity, setGitActivity] = useState<GitActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eventsFetched, setEventsFetched] = useState(false);
  // Track which sessionId was last fetched so we re-fetch if sessionId changes
  const lastFetchedId = useRef<string | null>(null);

  // Parallel fetch on mount: session + transcript + git
  useEffect(() => {
    if (lastFetchedId.current === sessionId) return;
    lastFetchedId.current = sessionId;

    async function load() {
      try {
        setLoading(true);
        const [sess, trans, git] = await Promise.all([
          fetchSessionDetail(apiClient, sessionId),
          fetchSessionTranscript(apiClient, sessionId).catch(() => null),
          fetchSessionGit(apiClient, sessionId).catch(() => []),
        ]);
        setSession(sess);
        setTranscript(trans as TranscriptMessageWithBlocks[] | null);
        setGitActivity(git);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [apiClient, sessionId]);

  // WS subscription for live sessions
  useEffect(() => {
    if (!session || !wsClient || session.lifecycle !== "capturing") return;

    // Subscribe to this session's updates
    wsClient.subscribe({ session_id: sessionId });

    const handleUpdate = (update: {
      session_id: string;
      lifecycle: string;
      summary?: string;
      stats?: { total_messages?: number; total_cost_usd?: number; duration_ms?: number };
    }) => {
      if (update.session_id !== sessionId) return;
      setSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          lifecycle: update.lifecycle as SessionDetail["lifecycle"],
          ...(update.summary !== undefined && { summary: update.summary }),
          ...(update.stats && {
            cost_estimate_usd: update.stats.total_cost_usd ?? prev.cost_estimate_usd,
            duration_ms: update.stats.duration_ms ?? prev.duration_ms,
            stats: {
              ...prev.stats,
              total_messages: update.stats.total_messages ?? prev.stats?.total_messages,
            },
          }),
        };
      });
    };

    wsClient.on("session.update", handleUpdate);

    return () => {
      wsClient.unsubscribe({ session_id: sessionId });
      wsClient.off("session.update", handleUpdate);
    };
  }, [session?.lifecycle, wsClient, sessionId]);

  // Lazy event fetching
  const fetchEventsCallback = useCallback(async () => {
    if (eventsFetched) return;
    try {
      const evts = await fetchSessionEvents(apiClient, sessionId);
      setEvents(evts);
      setEventsFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [apiClient, sessionId, eventsFetched]);

  // Export data getter
  const getExportData = useCallback((): SessionExportData | null => {
    if (!session) return null;
    return {
      session,
      transcript: transcript ?? [],
      events: events ?? [],
      git_activity: gitActivity,
      exported_at: new Date().toISOString(),
    };
  }, [session, transcript, events, gitActivity]);

  return {
    session,
    transcript,
    events,
    gitActivity,
    loading,
    error,
    fetchEvents: fetchEventsCallback,
    eventsFetched,
    isLive: session?.lifecycle === "capturing",
    getExportData,
  };
}
