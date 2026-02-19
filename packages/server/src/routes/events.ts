/**
 * Event ingestion endpoint for fuel-code.
 *
 * POST /api/events/ingest — receives batched events from the CLI,
 * validates envelopes and type-specific payloads, publishes valid
 * events to the Redis Stream, and returns quickly.
 *
 * Processing flow:
 *   1. Parse request body with ingestRequestSchema (Zod) — rejects the
 *      entire request on envelope validation failure (bad ULIDs, missing
 *      fields, batch size out of range).
 *   2. For each event, validate the type-specific payload using the
 *      payload registry. Events with unregistered types pass through
 *      (forward-compatible). Events with registered types that fail
 *      validation are rejected individually (batch is NOT rejected).
 *   3. Publish valid events to Redis Stream via publishBatchToStream.
 *   4. Return 202 with per-event accept/reject results.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type Redis from "ioredis";
import { ZodError } from "zod";

import {
  ingestRequestSchema,
  validateEventPayload,
} from "@fuel-code/shared";
import type { Event } from "@fuel-code/shared";
import { publishBatchToStream } from "../redis/stream.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-event result reported in the 202 response */
interface EventResult {
  index: number;
  status: "accepted" | "rejected";
}

/** Per-event error detail reported in the 202 response */
interface EventError {
  index: number;
  error: string;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the events router with injected dependencies.
 *
 * @param deps.redis - ioredis client for publishing to the event stream
 * @returns Express Router with POST /events/ingest
 */
export function createEventsRouter(deps: { redis: Redis }): Router {
  const router = Router();

  router.post(
    "/events/ingest",
    async (req: Request, res: Response, next: NextFunction) => {
      // --- Step 1: Validate the request envelope (batch structure, ULIDs, etc.) ---
      let parsed: ReturnType<typeof ingestRequestSchema.parse>;
      try {
        parsed = ingestRequestSchema.parse(req.body);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({
            error: "Validation failed",
            details: err.issues,
          });
          return;
        }
        // Unexpected error — let the global error handler deal with it
        next(err);
        return;
      }

      // --- Step 2: Validate type-specific payloads and separate valid/rejected ---
      const valid: Event[] = [];
      const results: EventResult[] = [];
      const errors: EventError[] = [];

      for (let i = 0; i < parsed.events.length; i++) {
        const event = parsed.events[i];

        // Validate the type-specific payload (e.g., session.start requires cwd)
        const payloadResult = validateEventPayload(event.type, event.data);

        if (!payloadResult.success) {
          // Payload validation failed — reject this event, not the batch
          results.push({ index: i, status: "rejected" });
          errors.push({
            index: i,
            error: `${event.type} payload validation failed: ${payloadResult.error.issues.map((issue) => issue.message).join(", ")}`,
          });
          continue;
        }

        // Set server-side ingestion timestamp and push as a full Event
        const fullEvent = { ...event, ingested_at: new Date().toISOString() } as Event;
        valid.push(fullEvent);
        results.push({ index: i, status: "accepted" });
      }

      // --- Step 3: Publish valid events to Redis Stream ---
      let publishedCount = 0;

      if (valid.length > 0) {
        try {
          const publishResult = await publishBatchToStream(deps.redis, valid);

          publishedCount = publishResult.succeeded.length;

          // Handle per-event publish failures — mark them as rejected
          for (const failure of publishResult.failed) {
            // Find the original index by matching event IDs
            const originalIndex = parsed.events.findIndex(
              (e) => e.id === failure.eventId,
            );
            if (originalIndex !== -1) {
              // Update the result from accepted to rejected
              const resultEntry = results.find(
                (r) => r.index === originalIndex,
              );
              if (resultEntry) {
                resultEntry.status = "rejected";
              }
              errors.push({
                index: originalIndex,
                error: `Failed to publish to stream: ${failure.error}`,
              });
            }
          }
        } catch (err) {
          // Total Redis failure — return 503 with retry hint
          logger.error(
            { err },
            "Redis stream publish failed entirely — event pipeline unavailable",
          );
          res.status(503).json({
            error: "Event pipeline temporarily unavailable",
            retry_after_seconds: 30,
          });
          return;
        }
      }

      // --- Step 4: Return 202 with per-event results ---
      const rejectedCount = results.filter(
        (r) => r.status === "rejected",
      ).length;

      res.status(202).json({
        ingested: publishedCount,
        duplicates: 0,
        rejected: rejectedCount,
        results,
        ...(errors.length > 0 ? { errors } : {}),
      });
    },
  );

  return router;
}
