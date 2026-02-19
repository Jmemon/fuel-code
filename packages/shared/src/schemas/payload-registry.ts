/**
 * Payload validation registry.
 *
 * Maps event types to their specific Zod payload schemas. Not all event types
 * have schemas — unregistered types pass through without payload validation.
 * This allows incremental schema coverage: Phase 1 covers session.start and
 * session.end; future phases add git.*, remote.*, etc.
 *
 * Used by the event processor to validate the `data` field of each event
 * after the envelope has been validated by eventSchema.
 */

import { z } from "zod";
import type { EventType } from "../types/event.js";
import { sessionStartPayloadSchema } from "./session-start.js";
import { sessionEndPayloadSchema } from "./session-end.js";
import { sessionCompactPayloadSchema } from "./session-compact.js";
import { gitCommitPayloadSchema } from "./git-commit.js";
import { gitPushPayloadSchema } from "./git-push.js";
import { gitCheckoutPayloadSchema } from "./git-checkout.js";
import { gitMergePayloadSchema } from "./git-merge.js";

/**
 * Registry mapping event types to their payload Zod schemas.
 * Only types with explicit schemas are registered — the rest are Partial (undefined).
 */
export const PAYLOAD_SCHEMAS: Partial<Record<EventType, z.ZodSchema>> = {
  "session.start": sessionStartPayloadSchema,
  "session.end": sessionEndPayloadSchema,
  "session.compact": sessionCompactPayloadSchema,
  "git.commit": gitCommitPayloadSchema,
  "git.push": gitPushPayloadSchema,
  "git.checkout": gitCheckoutPayloadSchema,
  "git.merge": gitMergePayloadSchema,
};

/**
 * Validate the payload (`data` field) of an event against its registered schema.
 *
 * - If a schema is registered for the event type, validates and returns the result.
 * - If no schema is registered, the payload passes through as-is (success).
 *
 * This design means new event types can be emitted before their schemas are defined,
 * and validation is opt-in per type.
 */
export function validateEventPayload(
  type: EventType,
  data: unknown,
): { success: true; data: unknown } | { success: false; error: z.ZodError } {
  const schema = PAYLOAD_SCHEMAS[type];

  // No schema registered for this event type — passthrough
  if (!schema) {
    return { success: true, data };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, error: result.error };
}
