/**
 * Per-teammate summary generation.
 *
 * After a session reaches PARSED, this module generates a 1-2 sentence summary
 * for each teammate based on their stitched message feed (messages and content
 * blocks filtered by teammate_id).
 *
 * Summaries are stored in teammates.summary. Failures are non-fatal — a missing
 * summary never blocks the session lifecycle. Sessions with no teammates skip
 * this step entirely.
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { TranscriptMessage, ParsedContentBlock } from "@fuel-code/shared";
import {
  generateSummary,
  type SummaryConfig,
} from "../summary-generator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into generateTeammateSummaries — keeps it testable */
export interface TeammateSummaryDeps {
  sql: Sql;
  summaryConfig: SummaryConfig;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Generate per-teammate summaries for all teammates in a session.
 *
 * Iterates over teammates rows for the given session, loads each teammate's
 * messages and content blocks (filtered by teammate_id), renders them using
 * the existing renderTranscriptForSummary function, and calls generateSummary
 * with a teammate-specific system prompt.
 *
 * Early returns:
 *   - summaryConfig.enabled === false -> skip silently
 *   - No teammates in the session -> skip silently
 *   - Teammate with zero messages -> sets summary to "No recorded activity"
 *
 * Failures on individual teammates do not block other teammates or the session
 * lifecycle. All errors are logged and returned in the result array.
 *
 * @param deps      - Injected dependencies (sql, summaryConfig, logger)
 * @param sessionId - The session whose teammates need summaries
 * @returns Array of per-teammate results (for observability)
 */
export async function generateTeammateSummaries(
  deps: TeammateSummaryDeps,
  sessionId: string,
): Promise<TeammateSummaryResult[]> {
  const { sql, summaryConfig, logger } = deps;
  const log = logger.child({ sessionId, component: "teammate-summary" });
  const results: TeammateSummaryResult[] = [];

  // Guard: summaries disabled — skip silently
  if (!summaryConfig.enabled) {
    log.debug("Summary generation disabled — skipping teammate summaries");
    return results;
  }

  // Guard: no API key — skip silently (same as disabled)
  if (!summaryConfig.apiKey) {
    log.debug("No API key configured — skipping teammate summaries");
    return results;
  }

  try {
    // Load all teammates for this session
    const teammates = await sql`
      SELECT id, entity_name, role, entity_type
      FROM teammates
      WHERE session_id = ${sessionId}
    `;

    if (teammates.length === 0) {
      log.debug("No teammates found — skipping");
      return results;
    }

    log.info({ teammateCount: teammates.length }, "Generating teammate summaries");

    for (const teammate of teammates) {
      const teammateId = teammate.id as string;
      const entityName = teammate.entity_name as string | null;

      try {
        // Load this teammate's messages and content blocks
        const messages = await sql`
          SELECT * FROM transcript_messages
          WHERE teammate_id = ${teammateId}
          ORDER BY ordinal
        `;
        const blocks = await sql`
          SELECT * FROM content_blocks
          WHERE teammate_id = ${teammateId}
          ORDER BY block_order
        `;

        // Empty message feed — set a sensible default summary
        if (messages.length === 0) {
          await sql`
            UPDATE teammates SET summary = ${"No recorded activity"} WHERE id = ${teammateId}
          `;
          results.push({ teammateId, entityName, success: true, summary: "No recorded activity" });
          log.debug({ teammateId, entityName }, "Teammate has no messages — set default summary");
          continue;
        }

        // Generate summary using a teammate-specific config override.
        // generateSummary internally calls renderTranscriptForSummary to build
        // the prompt. We override maxOutputTokens to 100 since teammate
        // summaries are shorter than session summaries (1-2 sentences).
        const result = await generateSummary(
          messages as unknown as TranscriptMessage[],
          blocks as unknown as ParsedContentBlock[],
          {
            ...summaryConfig,
            maxOutputTokens: 100,
          },
        );

        if (result.success && result.summary) {
          await sql`
            UPDATE teammates SET summary = ${result.summary} WHERE id = ${teammateId}
          `;
          results.push({ teammateId, entityName, success: true, summary: result.summary });
          log.info({ teammateId, entityName }, "Teammate summary generated");
        } else if (result.success) {
          // Summary was empty/disabled — set a fallback
          await sql`
            UPDATE teammates SET summary = ${"No recorded activity"} WHERE id = ${teammateId}
          `;
          results.push({ teammateId, entityName, success: true, summary: "No recorded activity" });
        } else {
          // Generation failed — log but don't block
          log.warn(
            { teammateId, entityName, error: result.error },
            "Teammate summary generation failed",
          );
          results.push({ teammateId, entityName, success: false, error: result.error });
        }
      } catch (err) {
        // Non-fatal: individual teammate failure doesn't block others
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ teammateId, entityName, error: errMsg }, "Teammate summary threw — skipping");
        results.push({ teammateId, entityName, success: false, error: errMsg });
      }
    }
  } catch (err) {
    // Top-level error (e.g., failed to query teammates) — log and return empty
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ error: errMsg }, "Failed to generate teammate summaries");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result of generating a summary for a single teammate */
export interface TeammateSummaryResult {
  teammateId: string;
  entityName: string | null;
  success: boolean;
  summary?: string;
  error?: string;
}
