/**
 * SessionHeader — renders the body content inside the session detail Panel.
 *
 * Now simplified to render only 2 lines inside the parent Panel:
 *   Line 1: Summary text (or "Session in progress..." for live sessions)
 *   Line 2: Started relative time + model + cost, separated by " · "
 *
 * The Panel title (workspace, device, tokens, lifecycle) is constructed
 * by SessionDetailView and passed to the wrapping Panel component.
 *
 * For live sessions, an elapsed timer interval keeps the duration updating.
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import type { SessionDetail } from "../../commands/session-detail.js";
import { formatDuration, formatRelativeTime, formatCost } from "../../lib/formatters.js";

export interface SessionHeaderProps {
  session: SessionDetail;
}

export function SessionHeader({ session }: SessionHeaderProps): React.ReactElement {
  const isLive = session.lifecycle === "detected" || session.lifecycle === "capturing";
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

  // Summary with live session fallback
  const summary = session.summary ?? session.initial_prompt ?? (isLive ? "Session in progress..." : null);

  // Second line parts: started relative time, model, cost — joined by " · "
  const metaParts: string[] = [];
  metaParts.push(`Started ${formatRelativeTime(session.started_at)}`);
  if (session.model) {
    metaParts.push(session.model);
  }
  const cost = formatCost(session.cost_estimate_usd);
  if (cost !== "\u2014") {
    metaParts.push(cost);
  }

  return (
    <Box flexDirection="column">
      {/* Line 1: Summary */}
      {summary && <Text>{summary}</Text>}
      {/* Line 2: Started · model · cost */}
      <Text dimColor>{metaParts.join(" · ")}</Text>
    </Box>
  );
}
