/**
 * Device API endpoints for fuel-code.
 *
 * Provides REST endpoints for querying devices:
 *   - GET /devices       — List all devices with aggregate session/workspace counts
 *   - GET /devices/:id   — Device detail with workspace associations and recent sessions
 *
 * All endpoints are read-only aggregation queries over existing tables.
 * Devices are populated by the event processor when events are ingested.
 * Auth is enforced by the upstream auth middleware on /api/*.
 *
 * No pagination needed: single-user system with a small number of devices.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the devices router for testability */
export interface DevicesRouterDeps {
  /** postgres.js SQL tagged template client */
  sql: Sql;
  /** Pino logger instance */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the devices router with injected dependencies.
 *
 * @param deps - Database and logger dependencies
 * @returns Express Router with device endpoints mounted at /devices/*
 */
export function createDevicesRouter(deps: DevicesRouterDeps): Router {
  const { sql, logger } = deps;
  const router = Router();

  // =========================================================================
  // GET /devices — List all devices with aggregate counts
  // =========================================================================
  router.get(
    "/devices",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Aggregate session and workspace counts per device using CTEs to
        // avoid cross-join inflation. A flat multi-join between sessions and
        // workspace_devices produces N*M rows per device, inflating SUM/COUNT
        // aggregates. Pre-aggregating each dimension in its own CTE keeps the
        // row counts correct.
        const rows = await sql`
          WITH device_sessions AS (
            SELECT s.device_id,
              COUNT(*)::int AS session_count,
              COUNT(CASE WHEN s.lifecycle IN ('detected', 'capturing') THEN 1 END)::int AS active_session_count,
              MAX(s.started_at) AS last_session_at,
              COALESCE(SUM(s.cost_estimate_usd), 0) AS total_cost_usd,
              COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms
            FROM sessions s
            GROUP BY s.device_id
          ),
          device_workspaces AS (
            SELECT wd.device_id,
              COUNT(DISTINCT wd.workspace_id)::int AS workspace_count
            FROM workspace_devices wd
            GROUP BY wd.device_id
          )
          SELECT d.*,
            COALESCE(ds.session_count, 0) AS session_count,
            COALESCE(dw.workspace_count, 0) AS workspace_count,
            COALESCE(ds.active_session_count, 0) AS active_session_count,
            ds.last_session_at,
            COALESCE(ds.total_cost_usd, 0) AS total_cost_usd,
            COALESCE(ds.total_duration_ms, 0) AS total_duration_ms
          FROM devices d
          LEFT JOIN device_sessions ds ON ds.device_id = d.id
          LEFT JOIN device_workspaces dw ON dw.device_id = d.id
          ORDER BY d.last_seen_at DESC
        `;

        res.json({ devices: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /devices/:id — Device detail with workspace associations and sessions
  // =========================================================================
  router.get(
    "/devices/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // --- Look up the device ---
        const deviceRows = await sql`
          SELECT * FROM devices WHERE id = ${id}
        `;

        if (deviceRows.length === 0) {
          res.status(404).json({ error: "Device not found" });
          return;
        }

        const device = deviceRows[0];

        // --- Parallel queries for detail data ---
        const [workspaces, recentSessions] = await Promise.all([
          // Workspaces associated with this device (via workspace_devices junction)
          sql`
            SELECT w.id, w.canonical_id, w.display_name, w.default_branch,
                   wd.local_path, wd.hooks_installed, wd.git_hooks_installed, wd.last_active_at
            FROM workspaces w
            JOIN workspace_devices wd ON wd.workspace_id = w.id
            WHERE wd.device_id = ${id}
            ORDER BY wd.last_active_at DESC
          `,

          // Recent sessions (last 10) on this device with workspace names
          sql`
            SELECT s.id, s.workspace_id, s.lifecycle, s.started_at, s.ended_at,
                   s.duration_ms, s.summary, s.cost_estimate_usd, s.total_messages,
                   s.tags, s.model, s.git_branch,
                   w.display_name AS workspace_name, w.canonical_id AS workspace_canonical_id
            FROM sessions s
            JOIN workspaces w ON s.workspace_id = w.id
            WHERE s.device_id = ${id}
            ORDER BY s.started_at DESC
            LIMIT 10
          `,
        ]);

        res.json({
          device,
          workspaces,
          recent_sessions: recentSessions,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
