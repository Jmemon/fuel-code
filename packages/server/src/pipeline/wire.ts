/**
 * Wiring layer that creates the event handler and connects core internals
 * to the consumer without exposing core's internal structure.
 *
 * This indirection means the consumer only depends on the registry and a
 * process function — it doesn't need to know about createHandlerRegistry,
 * processEvent, or their import paths.
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { Event } from "@fuel-code/shared";
import {
  createHandlerRegistry,
  processEvent,
  type EventHandlerRegistry,
  type ProcessResult,
} from "@fuel-code/core";

/**
 * Create the event handler registry and a wrapped process function.
 *
 * The registry is pre-populated with Phase 1 handlers (session.start, session.end).
 * The process function closes over sql/registry/logger so callers just pass an event.
 *
 * @param sql - postgres.js tagged template client
 * @param logger - Pino logger for handler registration and processing logs
 * @returns The registry (for introspection) and a bound process function
 */
export function createEventHandler(
  sql: Sql,
  logger: Logger,
): {
  registry: EventHandlerRegistry;
  process: (event: Event) => Promise<ProcessResult>;
} {
  const registry = createHandlerRegistry(logger);

  return {
    registry,
    process: (event: Event) => processEvent(sql, event, registry, logger),
  };
}
