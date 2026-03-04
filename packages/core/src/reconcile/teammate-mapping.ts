/**
 * Teammate mapping — Map subagents to their owning teammate.
 *
 * When a team session spawns subagents via SendMessage → Agent, each subagent
 * executes work on behalf of a specific teammate. This module extracts the
 * teammate identity from a parsed subagent transcript using two methods:
 *
 *   Method 1: `routing.sender` in SendMessage tool_result content blocks.
 *     The subagent's own transcript may contain SendMessage tool calls whose
 *     results include `{ routing: { sender: "alice" } }`. The sender field
 *     identifies which teammate this subagent is acting as.
 *
 *   Method 2: `<teammate-message teammate_id="alice">` XML tags in user
 *     messages. When the lead session dispatches work to a teammate, the
 *     subagent's first user message contains an XML wrapper identifying the
 *     recipient teammate.
 *
 * The team name is extracted from:
 *   - `teamName` field on the JSONL line (captured in message metadata)
 *   - Fallback: teams array in the ParseResult
 *
 * After extraction, `resolveTeammateId()` looks up the teammates table to
 * find the matching row and returns its ID for FK assignment on the subagent.
 */

import type { Sql } from "postgres";
import type { ParseResult, ParsedContentBlock, TranscriptMessage } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of extracting teammate identity from a subagent's parsed transcript */
export interface TeammateMapping {
  /** The teammate's display name (e.g., "alice", "bob") */
  teammateName: string | null;
  /** The team this subagent belongs to (e.g., "backend-team") */
  teamName: string | null;
}

// ---------------------------------------------------------------------------
// Pure extraction functions
// ---------------------------------------------------------------------------

/**
 * Extract the teammate name from a parsed subagent transcript.
 *
 * Tries two methods in priority order:
 *   1. `routing.sender` from SendMessage tool_result blocks
 *   2. `teammate_id` attribute from `<teammate-message>` XML tags in user messages
 *
 * Returns null if no teammate identity can be determined (non-team subagent).
 *
 * @param parseResult - The parsed transcript of a single subagent
 * @returns The teammate name, or null if unmapped
 */
export function extractTeammateName(parseResult: ParseResult): string | null {
  // Method 1: Scan tool_result blocks for routing.sender from SendMessage results.
  // When a subagent sends a message via SendMessage, the tool result echoes
  // back the routing info including which teammate (sender) originated it.
  const fromRouting = extractTeammateFromRouting(parseResult.contentBlocks);
  if (fromRouting) return fromRouting;

  // Method 2: Scan user messages for <teammate-message teammate_id="..."> XML tags.
  // The lead session wraps dispatched messages in this XML when delivering
  // work to a teammate's subagent.
  const fromXml = extractTeammateFromXml(parseResult.messages);
  if (fromXml) return fromXml;

  return null;
}

/**
 * Extract the team name from a parsed subagent transcript.
 *
 * Checks multiple sources in priority order:
 *   1. Message metadata `teamName` field (if captured by the parser)
 *   2. The raw_message object's `teamName` field (JSONL root-level field)
 *   3. The ParseResult's teams array (if the subagent's transcript references teams)
 *
 * @param parseResult - The parsed transcript of a single subagent
 * @returns The team name, or null if not in a team context
 */
export function extractTeamName(parseResult: ParseResult): string | null {
  // Check message metadata for teamName (may be set by enhanced parsers)
  for (const msg of parseResult.messages) {
    const metaTeamName = (msg.metadata as Record<string, unknown>)?.teamName;
    if (typeof metaTeamName === "string" && metaTeamName) return metaTeamName;
  }

  // Check raw_message for teamName — the JSONL root-level field may be
  // stored here depending on parser implementation.
  for (const msg of parseResult.messages) {
    const raw = msg.raw_message as Record<string, unknown> | null;
    if (raw?.teamName && typeof raw.teamName === "string") return raw.teamName;
  }

  // Fallback: check if the ParseResult's teams array has entries
  if (parseResult.teams.length > 0) {
    return parseResult.teams[0].team_name;
  }

  return null;
}

/**
 * Extract both teammate name and team name in one call for convenience.
 *
 * @param parseResult - The parsed transcript of a single subagent
 * @returns TeammateMapping with both fields (either or both may be null)
 */
export function extractTeammateMapping(parseResult: ParseResult): TeammateMapping {
  return {
    teammateName: extractTeammateName(parseResult),
    teamName: extractTeamName(parseResult),
  };
}

// ---------------------------------------------------------------------------
// Database resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a teammate name + team name to a teammate_id from the database.
 *
 * Looks up the `teammates` table by matching entity_name and team_name within
 * the given session. Returns null if no matching teammate row is found (which
 * is not an error — the subagent simply remains unmapped).
 *
 * @param sql           - Postgres connection
 * @param sessionId     - The session this subagent belongs to
 * @param teammateName  - The teammate's display name (from extraction)
 * @param teamName      - The team name (from extraction)
 * @returns The teammate's ULID, or null if no match found
 */
export async function resolveTeammateId(
  sql: Sql,
  sessionId: string,
  teammateName: string,
  teamName: string,
): Promise<string | null> {
  // Join teammates → teams to match by session_id, entity_name, and team_name.
  // The teammates table has entity_name (the teammate's display name) and
  // team_id FK pointing to teams, which has team_name.
  const rows = await sql`
    SELECT tm.id
    FROM teammates tm
    JOIN teams t ON tm.team_id = t.id
    WHERE tm.session_id = ${sessionId}
      AND tm.entity_name = ${teammateName}
      AND t.team_name = ${teamName}
    LIMIT 1
  `;

  if (rows.length > 0) {
    return rows[0].id as string;
  }

  return null;
}

/**
 * Convenience function: extract teammate info from a subagent's parsed
 * transcript and resolve it to a teammate_id in the database.
 *
 * Returns null if:
 *   - No teammate name could be extracted (non-team subagent)
 *   - No team name could be extracted
 *   - No matching teammate row exists in the database
 *
 * This is the primary entry point for wiring into parseSubagentTranscripts().
 *
 * @param sql         - Postgres connection
 * @param sessionId   - The session this subagent belongs to
 * @param parseResult - The parsed transcript of a single subagent
 * @param teamNameOverride - Optional team name override (e.g., from the
 *                           subagent row's team_name column, if still available)
 * @returns The teammate's ULID, or null if unmapped
 */
export async function resolveTeammateFromParseResult(
  sql: Sql,
  sessionId: string,
  parseResult: ParseResult,
  teamNameOverride?: string | null,
): Promise<string | null> {
  const teammateName = extractTeammateName(parseResult);
  if (!teammateName) return null;

  const teamName = teamNameOverride ?? extractTeamName(parseResult);
  if (!teamName) return null;

  return resolveTeammateId(sql, sessionId, teammateName, teamName);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract teammate name from routing.sender in SendMessage tool_result blocks.
 *
 * Scans all tool_result content blocks for JSON-parseable result_text that
 * contains a `routing.sender` field. Returns the first match found.
 *
 * Expected result_text format:
 * ```json
 * {
 *   "routing": { "sender": "alice", ... },
 *   ...
 * }
 * ```
 */
function extractTeammateFromRouting(contentBlocks: ParsedContentBlock[]): string | null {
  for (const block of contentBlocks) {
    if (block.block_type !== "tool_result") continue;
    if (!block.result_text) continue;

    try {
      const result = JSON.parse(block.result_text);
      const sender = result?.routing?.sender;
      if (typeof sender === "string" && sender) {
        return sender;
      }
    } catch {
      // Not valid JSON or doesn't have routing.sender — skip
    }
  }

  return null;
}

/**
 * Extract teammate name from <teammate-message> XML tags in user messages.
 *
 * Scans user messages for content strings containing XML tags like:
 *   `<teammate-message teammate_id="alice" color="green" ...>...</teammate-message>`
 *
 * Supports both string content and array content (where content blocks may
 * contain text with the XML tags). Returns the first match found.
 */
function extractTeammateFromXml(messages: TranscriptMessage[]): string | null {
  // Regex to match teammate_id attribute in teammate-message XML tags.
  // Handles both single and double quotes, and escaped quotes in JSON strings.
  const TEAMMATE_MSG_REGEX = /teammate_id\\?=\\?"([^"\\]+)\\?"/;

  for (const msg of messages) {
    if (msg.message_type !== "user") continue;

    const raw = msg.raw_message as Record<string, unknown> | null;
    if (!raw) continue;

    const content = raw.content;

    // Case 1: content is a plain string (most common for teammate messages)
    if (typeof content === "string") {
      const match = content.match(TEAMMATE_MSG_REGEX);
      if (match?.[1]) return match[1];
    }

    // Case 2: content is an array of content blocks (tool_result format)
    if (Array.isArray(content)) {
      for (const item of content) {
        // Check text content blocks
        if (typeof item === "object" && item !== null) {
          const blockContent = (item as Record<string, unknown>).content;
          if (typeof blockContent === "string") {
            const match = blockContent.match(TEAMMATE_MSG_REGEX);
            if (match?.[1]) return match[1];
          }
          const blockText = (item as Record<string, unknown>).text;
          if (typeof blockText === "string") {
            const match = blockText.match(TEAMMATE_MSG_REGEX);
            if (match?.[1]) return match[1];
          }
        }
      }
    }
  }

  return null;
}
