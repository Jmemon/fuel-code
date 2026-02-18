/**
 * Event processor — the core function that the Redis consumer calls for each event.
 *
 * Responsibilities:
 *   1. Resolve workspace (canonical ID -> ULID) and device
 *   2. Link workspace to device
 *   3. Insert the event row into Postgres (deduped by ULID)
 *   4. Dispatch to a type-specific handler via the EventHandlerRegistry
 *
 * Handlers are registered externally, so the processor is extensible without
 * modifying this file. Phase 1 registers session.start and session.end.
 *
 * This module is pure domain logic with injected dependencies (sql, logger).
 * No HTTP, no CLI, no UI knowledge.
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { Event, EventType } from "@fuel-code/shared";

import { resolveOrCreateWorkspace } from "./workspace-resolver.js";
import { resolveOrCreateDevice } from "./device-resolver.js";
import { ensureWorkspaceDeviceLink } from "./workspace-device-link.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to every event handler */
export interface EventHandlerContext {
  /** postgres.js tagged template client */
  sql: Sql;
  /** The event being processed */
  event: Event;
  /** Resolved workspace ULID (not the canonical string) */
  workspaceId: string;
  /** Pino logger scoped to this event */
  logger: Logger;
}

/** An event handler function — receives context and performs type-specific logic */
export type EventHandler = (ctx: EventHandlerContext) => Promise<void>;

/** Result of processing a single event */
export interface ProcessResult {
  /** The event's ULID */
  eventId: string;
  /** Whether the event was newly processed, a duplicate, or errored during resolution */
  status: "processed" | "duplicate" | "error";
  /** Results from dispatching to registered handlers */
  handlerResults: Array<{ type: string; success: boolean; error?: string }>;
}

// ---------------------------------------------------------------------------
// Handler Registry
// ---------------------------------------------------------------------------

/**
 * Registry mapping EventType -> EventHandler.
 *
 * Only one handler per type (last registration wins). The processor looks up
 * the handler at dispatch time, so handlers can be registered/replaced at any
 * point before events of that type arrive.
 */
export class EventHandlerRegistry {
  /** Internal map of event type to handler function */
  private handlers = new Map<EventType, EventHandler>();

  /**
   * Register a handler for a given event type.
   * Overwrites any previously registered handler for that type.
   */
  register(eventType: EventType, handler: EventHandler, logger?: Logger): void {
    this.handlers.set(eventType, handler);
    logger?.info({ eventType }, `Registered handler for ${eventType}`);
  }

  /** Look up the handler for a given event type (undefined if none registered) */
  getHandler(eventType: EventType): EventHandler | undefined {
    return this.handlers.get(eventType);
  }

  /** List all event types that have a registered handler */
  listRegisteredTypes(): EventType[] {
    return [...this.handlers.keys()];
  }
}

// ---------------------------------------------------------------------------
// Hint extraction
// ---------------------------------------------------------------------------

/**
 * Extract workspace hints from an event's data payload.
 *
 * For session.start events, the git_branch is used as a default_branch hint
 * so the workspace record captures the branch on first sight.
 */
function extractHints(
  event: Event,
): { default_branch?: string } | undefined {
  if (event.type === "session.start") {
    const branch = event.data.git_branch;
    if (typeof branch === "string" && branch.length > 0) {
      return { default_branch: branch };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process a single event: resolve entities, persist the event row, and dispatch
 * to the type-specific handler.
 *
 * This is the function the Redis stream consumer calls for every event.
 *
 * @param sql - postgres.js tagged template client
 * @param event - The fully validated Event to process
 * @param registry - Handler registry for type-specific dispatch
 * @param logger - Pino logger (will be child-scoped per event)
 * @returns ProcessResult with status and per-handler outcomes
 */
export async function processEvent(
  sql: Sql,
  event: Event,
  registry: EventHandlerRegistry,
  logger: Logger,
): Promise<ProcessResult> {
  const log = logger.child({ eventId: event.id, eventType: event.type });

  // 1. Resolve workspace: canonical ID string -> ULID
  const resolvedWorkspaceId = await resolveOrCreateWorkspace(
    sql,
    event.workspace_id,
    extractHints(event),
  );

  // 2. Resolve device: ensure device row exists
  await resolveOrCreateDevice(sql, event.device_id);

  // 3. Link workspace to device with the working directory from the event
  const localPath =
    typeof event.data.cwd === "string" ? event.data.cwd : "unknown";
  await ensureWorkspaceDeviceLink(sql, resolvedWorkspaceId, event.device_id, localPath);

  // 4. Insert event row — using resolved workspace ULID, NOT the canonical string.
  //    ON CONFLICT (id) DO NOTHING deduplicates by event ULID.
  const insertResult = await sql`
    INSERT INTO events (id, type, timestamp, device_id, workspace_id, session_id, data, blob_refs, ingested_at)
    VALUES (
      ${event.id},
      ${event.type},
      ${event.timestamp},
      ${event.device_id},
      ${resolvedWorkspaceId},
      ${event.session_id},
      ${JSON.stringify(event.data)},
      ${JSON.stringify(event.blob_refs)},
      ${new Date().toISOString()}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  // If no rows returned, the event already existed (duplicate)
  if (insertResult.length === 0) {
    log.debug("Duplicate event, skipping handler dispatch");
    return { eventId: event.id, status: "duplicate", handlerResults: [] };
  }

  // 5. Dispatch to type-specific handler
  const handlerResults: ProcessResult["handlerResults"] = [];
  const handler = registry.getHandler(event.type);

  if (handler) {
    try {
      await handler({
        sql,
        event,
        workspaceId: resolvedWorkspaceId,
        logger: log,
      });
      handlerResults.push({ type: event.type, success: true });
    } catch (err) {
      // Handler errors are logged but do NOT fail the overall process —
      // the event row is already persisted.
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err, handlerType: event.type }, "Handler failed");
      handlerResults.push({ type: event.type, success: false, error: errorMsg });
    }
  } else {
    log.debug({ eventType: event.type }, "No handler registered for event type");
  }

  return { eventId: event.id, status: "processed", handlerResults };
}
