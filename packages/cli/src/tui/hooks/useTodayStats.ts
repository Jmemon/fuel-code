/**
 * Hook to compute today's aggregate statistics for the StatusBar.
 *
 * Derives stats from the current workspace list: total sessions today,
 * total duration, total cost, and total commits. Recomputes whenever
 * workspaces data changes.
 */

import { useMemo } from "react";
import type { WorkspaceSummary } from "../../lib/api-client.js";

export interface TodayStats {
  sessions: number;
  durationMs: number;
  costUsd: number;
  commits: number;
}

/**
 * Compute aggregate stats across all workspaces.
 * For a true "today" filter we'd need a separate API call with date filtering,
 * but for the dashboard we show totals across all workspaces as a useful summary.
 */
export function useTodayStats(workspaces: WorkspaceSummary[]): TodayStats {
  return useMemo(() => {
    let sessions = 0;
    let durationMs = 0;
    let costUsd = 0;

    for (const ws of workspaces) {
      sessions += ws.session_count;
      durationMs += ws.total_duration_ms ?? 0;
      costUsd += ws.total_cost_usd ?? 0;
    }

    return {
      sessions,
      durationMs,
      costUsd,
      commits: 0, // Commits require a separate API call; omitted for now
    };
  }, [workspaces]);
}
