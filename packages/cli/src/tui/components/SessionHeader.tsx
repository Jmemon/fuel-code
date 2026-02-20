/**
 * SessionHeader — top metadata panel for the session detail view.
 *
 * Displays session context in 4 lines:
 *   Line 1: Workspace + Device
 *   Line 2: Started + Duration + Cost
 *   Line 3: Tokens (125K in / 48K out / 890K cache)
 *   Line 4: Summary
 *
 * For live sessions (lifecycle === 'capturing'):
 *   - Duration shows an elapsed time counter updated every second
 *   - Cost shows running estimate
 *   - Summary shows "Session in progress..." if no summary yet
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { SessionDetail } from "../../commands/session-detail.js";
import { formatDuration, formatCost, formatRelativeTime, formatNumber } from "../../lib/formatters.js";

export interface SessionHeaderProps {
  session: SessionDetail;
}

export function SessionHeader({ session }: SessionHeaderProps): React.ReactElement {
  const isLive = session.lifecycle === "capturing";
  const [elapsedMs, setElapsedMs] = useState<number>(() => {
    if (isLive) {
      return Date.now() - new Date(session.started_at).getTime();
    }
    return session.duration_ms ?? 0;
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isLive) {
      intervalRef.current = setInterval(() => {
        setElapsedMs(Date.now() - new Date(session.started_at).getTime());
      }, 1000);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
    // For non-live sessions, use the static duration_ms
    setElapsedMs(session.duration_ms ?? 0);
  }, [isLive, session.started_at, session.duration_ms]);

  const workspaceName = session.workspace_name ?? session.workspace_id;
  const deviceName = session.device_name ?? session.device_id;
  const duration = isLive ? formatDuration(elapsedMs) : formatDuration(session.duration_ms);
  const cost = formatCost(session.cost_estimate_usd ?? null);

  // Token counts
  const stats = session.stats;
  const tokensIn = formatNumber(stats?.tokens_in ?? null);
  const tokensOut = formatNumber(stats?.tokens_out ?? null);
  const tokensCache = formatNumber(stats?.tokens_cache ?? null);
  const tokenStr = stats?.tokens_cache
    ? `${tokensIn} in / ${tokensOut} out / ${tokensCache} cache`
    : `${tokensIn} in / ${tokensOut} out`;

  // Summary with live session fallback
  const summary = session.summary ?? session.initial_prompt ?? (isLive ? "Session in progress..." : null);

  return (
    <Box flexDirection="column">
      {/* Line 1: Workspace + Device */}
      <Box>
        <Text bold>Workspace: </Text>
        <Text>{workspaceName}</Text>
        <Text>  </Text>
        <Text bold>Device: </Text>
        <Text>{deviceName}</Text>
        {isLive && (
          <>
            <Text>  </Text>
            <Text color="green" bold>LIVE</Text>
          </>
        )}
      </Box>

      {/* Line 2: Started + Duration + Cost */}
      <Box>
        <Text bold>Started: </Text>
        <Text>{formatRelativeTime(session.started_at)}</Text>
        <Text>  </Text>
        <Text bold>Duration: </Text>
        <Text>{duration}</Text>
        <Text>  </Text>
        <Text bold>Cost: </Text>
        <Text>{cost}</Text>
      </Box>

      {/* Line 3: Tokens */}
      <Box>
        <Text bold>Tokens: </Text>
        <Text>{tokenStr}</Text>
      </Box>

      {/* Line 4: Summary */}
      {summary && (
        <Box>
          <Text bold>Summary: </Text>
          <Text>{summary}</Text>
        </Box>
      )}
    </Box>
  );
}
