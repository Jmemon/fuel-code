/**
 * Session ID resolution logic for the fuel-code CLI.
 *
 * Supports three forms of session identification:
 *   1. Full ULID (26 chars) — passed directly to the API
 *   2. Prefix (8+ chars) — fetches sessions and filters client-side by ID prefix
 *   3. Short prefix (<8 chars) — rejected with a helpful error message
 *
 * Extracted as a separate module so both CLI commands and TUI components
 * can reuse the same resolution logic.
 */

import type { FuelApiClient } from "./api-client.js";
import { formatRelativeTime } from "./formatters.js";

/** Result of resolving a session ID — either a full ULID or an error */
export interface ResolveResult {
  /** The resolved full session ID (ULID) */
  id: string;
}

/**
 * Resolve a session ID argument to a full ULID.
 *
 * Resolution rules:
 *   - 26 chars: treat as full ULID, pass through directly
 *   - 8-25 chars: fetch recent sessions and find by prefix match
 *     - Exactly one match: return it
 *     - Zero matches: throw "Session not found: <prefix>"
 *     - Multiple matches: throw with list of candidates
 *   - <8 chars: throw with minimum length requirement
 *
 * @throws Error when the prefix is too short, not found, or ambiguous
 */
export async function resolveSessionId(api: FuelApiClient, idArg: string): Promise<string> {
  const trimmed = idArg.trim();

  // Reject short prefixes
  if (trimmed.length < 8) {
    throw new Error(
      `Session ID prefix must be at least 8 characters. Got ${trimmed.length}.`,
    );
  }

  // Full ULID — pass through directly (no validation call needed)
  if (trimmed.length === 26) {
    return trimmed;
  }

  // Prefix match: fetch sessions and filter client-side
  const { data: sessions } = await api.listSessions({ limit: 50 });
  const matches = sessions.filter((s) =>
    s.id.toLowerCase().startsWith(trimmed.toLowerCase()),
  );

  if (matches.length === 0) {
    throw new Error(`Session not found: ${trimmed}`);
  }

  if (matches.length === 1) {
    return matches[0].id;
  }

  // Multiple matches — list candidates with rich metadata for disambiguation
  const candidates = matches
    .map((s) => {
      const short = s.id.slice(0, 8);
      const ws = (s as Record<string, unknown>).workspace_name ?? s.workspace_id;
      const relTime = formatRelativeTime(s.started_at);
      const summary = (s as Record<string, unknown>).summary
        ?? (s as Record<string, unknown>).initial_prompt
        ?? "(no summary)";
      return `  ${short}  ${ws}  ${relTime}  "${summary}"`;
    })
    .join("\n");
  throw new Error(
    `Ambiguous session prefix "${trimmed}". Matches:\n${candidates}`,
  );
}
