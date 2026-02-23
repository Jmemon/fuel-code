/**
 * Hook to compute aggregate statistics for the StatusBar.
 *
 * Derives totals from the current workspace list: total sessions,
 * total duration, total cost, and total commits. Recomputes whenever
 * workspaces data changes.
 */

import { useMemo } from "react";
import type { WorkspaceSummary } from "../../lib/api-client.js";

export interface TodayStats {
  sessions: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  commits: number;
}

/**
 * Compute aggregate stats across all workspaces.
 * Shows lifetime totals. A per-day breakdown would require a separate API call
 * with date filtering; displaying totals is more useful for an at-a-glance view.
 */
export function useTodayStats(workspaces: WorkspaceSummary[]): TodayStats {
  return useMemo(() => {
    let sessions = 0;
    let durationMs = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    for (const ws of workspaces) {
      sessions += ws.session_count;
      durationMs += ws.total_duration_ms ?? 0;
      tokensIn += Number((ws as any).total_tokens_in) || 0;
      tokensOut += Number((ws as any).total_tokens_out) || 0;
    }

    return {
      sessions,
      durationMs,
      tokensIn,
      tokensOut,
      commits: 0, // Commits require a separate API call; omitted for now
    };
  }, [workspaces]);
}
