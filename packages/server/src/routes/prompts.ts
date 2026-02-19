/**
 * Prompts API endpoints for fuel-code.
 *
 * These endpoints support the CLI's auto-prompt system for git hook installation.
 * When the server detects that a workspace on a device could benefit from git hooks
 * (via the session.start handler), it flags the workspace_devices row. The CLI
 * polls these endpoints on interactive commands to discover and act on pending prompts.
 *
 * Endpoints:
 *   GET  /api/prompts/pending  — List pending prompts for a device
 *   POST /api/prompts/dismiss  — Accept or decline a prompt
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the prompts router for testability */
export interface PromptsRouterDeps {
  /** postgres.js SQL tagged template client */
  sql: Sql;
  /** Pino logger instance */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the prompts router with injected dependencies.
 *
 * @param deps - Database and logger dependencies
 * @returns Express Router with prompt endpoints mounted at /prompts/*
 */
export function createPromptsRouter(deps: PromptsRouterDeps): Router {
  const { sql, logger } = deps;
  const router = Router();

  // =========================================================================
  // GET /prompts/pending — List pending git hook install prompts for a device
  // =========================================================================
  router.get(
    "/prompts/pending",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const deviceId = req.query.device_id as string | undefined;

        if (!deviceId) {
          res.status(400).json({
            error: "Missing required query parameter: device_id",
          });
          return;
        }

        // Find all workspace+device pairs that are flagged for prompting:
        // - pending_git_hooks_prompt is true (flagged by session.start handler)
        // - git_hooks_installed is false (not already installed)
        // - git_hooks_prompted is false (user hasn't been asked yet)
        const rows = await sql`
          SELECT wd.workspace_id, w.canonical_id, w.display_name, wd.device_id
          FROM workspace_devices wd
          JOIN workspaces w ON w.id = wd.workspace_id
          WHERE wd.device_id = ${deviceId}
            AND wd.pending_git_hooks_prompt = true
            AND wd.git_hooks_installed = false
            AND wd.git_hooks_prompted = false
        `;

        // Transform DB rows into prompt objects the CLI expects
        const prompts = rows.map((row: any) => ({
          type: "git_hooks_install" as const,
          workspace_id: row.workspace_id,
          workspace_name: row.display_name,
          workspace_canonical_id: row.canonical_id,
        }));

        res.json({ prompts });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // POST /prompts/dismiss — Accept or decline a git hook install prompt
  // =========================================================================
  router.post(
    "/prompts/dismiss",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { workspace_id, device_id, action } = req.body;

        // Validate required fields
        if (!workspace_id || !device_id || !action) {
          res.status(400).json({
            error: "Missing required fields: workspace_id, device_id, action",
          });
          return;
        }

        if (action !== "accepted" && action !== "declined") {
          res.status(400).json({
            error: "action must be 'accepted' or 'declined'",
          });
          return;
        }

        if (action === "accepted") {
          // User accepted: mark hooks as installed, clear prompt flag, record prompted
          await sql`
            UPDATE workspace_devices
            SET git_hooks_installed = true,
                pending_git_hooks_prompt = false,
                git_hooks_prompted = true,
                last_active_at = now()
            WHERE workspace_id = ${workspace_id} AND device_id = ${device_id}
          `;
          logger.info({ workspace_id, device_id }, "Git hooks prompt accepted");
        } else {
          // User declined: clear prompt flag, record prompted (won't ask again)
          await sql`
            UPDATE workspace_devices
            SET pending_git_hooks_prompt = false,
                git_hooks_prompted = true,
                last_active_at = now()
            WHERE workspace_id = ${workspace_id} AND device_id = ${device_id}
          `;
          logger.info({ workspace_id, device_id }, "Git hooks prompt declined");
        }

        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
