/**
 * Session lifecycle state machine for fuel-code.
 *
 * Formalizes the valid states a session can be in and the allowed transitions
 * between them. Provides guarded state transitions using optimistic locking
 * (WHERE lifecycle = $from), recovery utilities for stuck sessions, and a
 * reset mechanism for re-processing.
 *
 * State diagram:
 *   detected -> capturing -> ended -> parsed -> summarized -> archived
 *       \                      \        \          \
 *        +-> ended (skip)       +-> failed +-> failed +-> failed
 *        +-> failed
 *
 *   failed  -> (terminal — use resetSessionForReparse to move back to ended)
 *   archived -> (terminal)
 */

import type postgres from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid lifecycle states for a session */
export type SessionLifecycle =
  | "detected"
  | "capturing"
  | "ended"
  | "parsed"
  | "summarized"
  | "archived"
  | "failed";

/** Result of attempting a lifecycle transition */
export interface TransitionResult {
  success: boolean;
  previousLifecycle: SessionLifecycle | null;
  newLifecycle: SessionLifecycle | null;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Transition map
// ---------------------------------------------------------------------------

/**
 * Allowed transitions for each lifecycle state.
 *
 *   detected   -> [capturing, ended, failed]     (ended: short sessions skip capturing)
 *   capturing  -> [ended, failed]
 *   ended      -> [parsed, failed]
 *   parsed     -> [summarized, failed]
 *   summarized -> [archived]
 *   archived   -> []                              (terminal)
 *   failed     -> []                              (terminal; use resetSessionForReparse to move back)
 */
export const TRANSITIONS: Record<SessionLifecycle, SessionLifecycle[]> = {
  detected: ["capturing", "ended", "failed"],
  capturing: ["ended", "failed"],
  ended: ["parsed", "failed"],
  parsed: ["summarized", "failed"],
  summarized: ["archived"],
  archived: [],
  failed: [],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Check whether transitioning from `from` to `to` is a valid lifecycle move.
 * Returns true if `to` is listed in TRANSITIONS[from].
 */
export function isValidTransition(
  from: SessionLifecycle,
  to: SessionLifecycle,
): boolean {
  const allowed = TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Columns that callers may update alongside a lifecycle transition
// ---------------------------------------------------------------------------

/** Fields that can be set alongside a lifecycle transition */
type UpdatableSessionFields = Partial<{
  ended_at: string;
  end_reason: string;
  duration_ms: number;
  transcript_s3_key: string;
  parse_status: string;
  parse_error: string | null;
  summary: string;
  initial_prompt: string;
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
  tool_use_count: number;
  thinking_blocks: number;
  subagent_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_estimate_usd: number;
}>;

// ---------------------------------------------------------------------------
// Core transition function
// ---------------------------------------------------------------------------

/**
 * Transition a session from one lifecycle state to another, with optimistic
 * locking. The UPDATE's WHERE clause includes `lifecycle = ANY($from)` so
 * concurrent transitions are serialized by Postgres — only one succeeds.
 *
 * @param sql       - postgres.js tagged template client
 * @param sessionId - session primary key
 * @param from      - expected current state(s); can be a single state or array
 * @param to        - desired new state
 * @param updates   - optional extra columns to set alongside the transition
 * @returns TransitionResult indicating success or failure with diagnostics
 */
export async function transitionSession(
  sql: postgres.Sql,
  sessionId: string,
  from: SessionLifecycle | SessionLifecycle[],
  to: SessionLifecycle,
  updates?: UpdatableSessionFields,
): Promise<TransitionResult> {
  // Normalize `from` to an array for uniform handling
  const fromStates = Array.isArray(from) ? from : [from];

  // Validate that every from -> to pair is a legal transition
  for (const f of fromStates) {
    if (!isValidTransition(f, to)) {
      return {
        success: false,
        previousLifecycle: null,
        newLifecycle: null,
        reason: `Invalid transition: ${f} -> ${to}`,
      };
    }
  }

  // Build dynamic SET clause parts. We always set lifecycle and updated_at.
  // Additional columns are included only when provided in `updates`.
  const setClauses: string[] = [];
  const values: unknown[] = [];

  // $1 = new lifecycle
  setClauses.push("lifecycle = $1");
  values.push(to);

  // $2 = session ID (used in WHERE)
  values.push(sessionId);

  // $3 = from states array (used in WHERE)
  values.push(fromStates);

  // Dynamic update columns starting at $4
  let paramIndex = 4;
  if (updates) {
    for (const [col, val] of Object.entries(updates)) {
      if (val !== undefined) {
        setClauses.push(`${col} = $${paramIndex}`);
        values.push(val);
        paramIndex++;
      }
    }
  }

  // Always bump updated_at
  setClauses.push("updated_at = now()");

  // Build and execute the UPDATE using sql.unsafe since we need dynamic SET
  const query = `
    UPDATE sessions
    SET ${setClauses.join(", ")}
    WHERE id = $2 AND lifecycle = ANY($3)
    RETURNING lifecycle
  `;

  const result = await sql.unsafe(query, values as any[]);

  // If the UPDATE matched a row, the transition succeeded
  if (result.length > 0) {
    return {
      success: true,
      previousLifecycle: fromStates.length === 1 ? fromStates[0] : null,
      newLifecycle: to,
    };
  }

  // No rows updated — diagnose why. Look up the session's actual state.
  const current = await sql`
    SELECT lifecycle FROM sessions WHERE id = ${sessionId}
  `;

  if (current.length === 0) {
    return {
      success: false,
      previousLifecycle: null,
      newLifecycle: null,
      reason: "Session not found",
    };
  }

  const actualState = current[0].lifecycle as SessionLifecycle;
  return {
    success: false,
    previousLifecycle: actualState,
    newLifecycle: null,
    reason: `Session is in state '${actualState}', expected '${fromStates.join("' or '")}'`,
  };
}

// ---------------------------------------------------------------------------
// Convenience: fail a session
// ---------------------------------------------------------------------------

/** All non-terminal lifecycle states that can transition to failed */
const NON_TERMINAL_STATES: SessionLifecycle[] = [
  "detected",
  "capturing",
  "ended",
  "parsed",
  "summarized",
];

/**
 * Transition any non-terminal session to the "failed" state, recording the
 * error message. Convenience wrapper around transitionSession.
 *
 * @param sql        - postgres.js tagged template client
 * @param sessionId  - session primary key
 * @param error      - error message to record in parse_error
 * @param fromStates - optional override of which states to transition from;
 *                     defaults to all non-terminal states
 */
export async function failSession(
  sql: postgres.Sql,
  sessionId: string,
  error: string,
  fromStates?: SessionLifecycle[],
): Promise<TransitionResult> {
  const sources = fromStates ?? NON_TERMINAL_STATES;

  // We can't use transitionSession directly because not all non-terminal
  // states have "failed" in their transition list (e.g., "summarized" only
  // goes to "archived"). Instead, use sql.unsafe for a direct UPDATE that
  // enforces the source states at the DB level.
  const result = await sql.unsafe(
    `UPDATE sessions
     SET lifecycle = 'failed',
         parse_status = 'failed',
         parse_error = $1,
         updated_at = now()
     WHERE id = $2 AND lifecycle = ANY($3)
     RETURNING lifecycle`,
    [error, sessionId, sources],
  );

  if (result.length > 0) {
    return {
      success: true,
      previousLifecycle: null,
      newLifecycle: "failed",
    };
  }

  // Diagnose: session not found vs. already in terminal state
  const current = await sql`
    SELECT lifecycle FROM sessions WHERE id = ${sessionId}
  `;

  if (current.length === 0) {
    return {
      success: false,
      previousLifecycle: null,
      newLifecycle: null,
      reason: "Session not found",
    };
  }

  const actualState = current[0].lifecycle as SessionLifecycle;
  return {
    success: false,
    previousLifecycle: actualState,
    newLifecycle: null,
    reason: `Session is in state '${actualState}', expected one of '${sources.join("', '")}'`,
  };
}

// ---------------------------------------------------------------------------
// Reset for re-processing
// ---------------------------------------------------------------------------

/**
 * Reset a session back to "ended" for re-processing. Deletes parsed data
 * (transcript_messages, content_blocks) and clears all derived stats, but
 * preserves the raw transcript_s3_key in S3.
 *
 * Allowed source states: ended, parsed, summarized, failed.
 * NOT allowed from: detected, capturing (session hasn't ended yet).
 *
 * Runs in a transaction so the delete + update are atomic.
 *
 * @param sql       - postgres.js tagged template client
 * @param sessionId - session primary key
 */
export async function resetSessionForReparse(
  sql: postgres.Sql,
  sessionId: string,
): Promise<{ reset: boolean; previousLifecycle: SessionLifecycle | null }> {
  // Allowed source states for reset — session must have at least ended
  const allowedFrom: SessionLifecycle[] = [
    "ended",
    "parsed",
    "summarized",
    "failed",
  ];

  // Run in a transaction: delete parsed data, then reset the session row
  // TransactionSql type is missing template literal call signatures in postgres.js types
  const result = await sql.begin(async (tx: any) => {
    // Remove parsed content blocks first (FK: content_blocks -> transcript_messages)
    await tx`DELETE FROM content_blocks WHERE session_id = ${sessionId}`;

    // Remove parsed transcript messages
    await tx`DELETE FROM transcript_messages WHERE session_id = ${sessionId}`;

    // Reset the session row: clear all derived fields, set lifecycle to ended
    const updated = await tx`
      UPDATE sessions
      SET lifecycle      = 'ended',
          parse_status   = 'pending',
          parse_error    = NULL,
          summary        = NULL,
          initial_prompt = NULL,
          total_messages      = NULL,
          user_messages       = NULL,
          assistant_messages  = NULL,
          tool_use_count      = NULL,
          thinking_blocks     = NULL,
          subagent_count      = NULL,
          tokens_in           = NULL,
          tokens_out          = NULL,
          cache_read_tokens   = NULL,
          cache_write_tokens  = NULL,
          cost_estimate_usd   = NULL,
          updated_at          = now()
      WHERE id = ${sessionId}
        AND lifecycle IN ('ended', 'parsed', 'summarized', 'failed')
      RETURNING lifecycle
    `;

    return updated;
  });

  // The RETURNING clause returns the NEW lifecycle ('ended'), but we need
  // to know what it WAS. Since we don't get the old value from RETURNING,
  // we infer: if updated, the session was in one of the allowedFrom states.
  // For a more precise answer we'd need a CTE, but for this use-case
  // knowing it was reset is sufficient.
  if (result.length > 0) {
    return { reset: true, previousLifecycle: result[0].lifecycle as SessionLifecycle };
  }

  return { reset: false, previousLifecycle: null };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Look up a session's current lifecycle state, parse_status, and parse_error.
 * Returns null if the session doesn't exist.
 */
export async function getSessionState(
  sql: postgres.Sql,
  sessionId: string,
): Promise<{
  lifecycle: SessionLifecycle;
  parse_status: string;
  parse_error: string | null;
} | null> {
  const rows = await sql`
    SELECT lifecycle, parse_status, parse_error
    FROM sessions
    WHERE id = ${sessionId}
  `;

  if (rows.length === 0) return null;

  return {
    lifecycle: rows[0].lifecycle as SessionLifecycle,
    parse_status: rows[0].parse_status as string,
    parse_error: rows[0].parse_error as string | null,
  };
}

/**
 * Find sessions that are stuck in intermediate pipeline states. A session is
 * "stuck" if its lifecycle is 'ended' or 'parsed' and its parse_status is
 * 'pending' or 'parsing', and it hasn't been updated within the threshold.
 *
 * Used by the server on startup and periodically to recover sessions whose
 * parser crashed or timed out.
 *
 * @param sql             - postgres.js tagged template client
 * @param stuckDurationMs - how long a session must be stuck before it's
 *                          returned, in milliseconds (default: 10 minutes)
 */
export async function findStuckSessions(
  sql: postgres.Sql,
  stuckDurationMs: number = 600_000,
): Promise<
  Array<{
    id: string;
    lifecycle: SessionLifecycle;
    parse_status: string;
    updated_at: string;
  }>
> {
  // Convert ms to a Postgres interval string (e.g., "600000 milliseconds")
  const intervalMs = `${stuckDurationMs} milliseconds`;

  const rows = await sql`
    SELECT id, lifecycle, parse_status, updated_at
    FROM sessions
    WHERE lifecycle IN ('ended', 'parsed')
      AND parse_status IN ('pending', 'parsing')
      AND updated_at < now() - ${intervalMs}::interval
    ORDER BY updated_at ASC
  `;

  return rows.map((r) => ({
    id: r.id as string,
    lifecycle: r.lifecycle as SessionLifecycle,
    parse_status: r.parse_status as string,
    updated_at: (r.updated_at as Date).toISOString(),
  }));
}
