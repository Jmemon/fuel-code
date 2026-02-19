/**
 * Tests for the session.compact Zod schema and its registration
 * in the payload validation registry.
 */

import { describe, expect, test } from "bun:test";
import { sessionCompactPayloadSchema } from "../schemas/session-compact.js";
import { validateEventPayload } from "../schemas/payload-registry.js";

describe("sessionCompactPayloadSchema", () => {
  test("validates a correct payload", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      compact_sequence: 0,
      transcript_path: "transcripts/github.com/user/repo/sess-001/raw.jsonl",
    };
    const result = sessionCompactPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("accepts compact_sequence > 0", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      compact_sequence: 3,
      transcript_path: "transcripts/sess.jsonl",
    };
    const result = sessionCompactPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("rejects missing cc_session_id", () => {
    const payload = {
      compact_sequence: 0,
      transcript_path: "transcripts/sess.jsonl",
    };
    const result = sessionCompactPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects empty cc_session_id", () => {
    const payload = {
      cc_session_id: "",
      compact_sequence: 0,
      transcript_path: "transcripts/sess.jsonl",
    };
    const result = sessionCompactPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects negative compact_sequence", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      compact_sequence: -1,
      transcript_path: "transcripts/sess.jsonl",
    };
    const result = sessionCompactPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects non-integer compact_sequence", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      compact_sequence: 1.5,
      transcript_path: "transcripts/sess.jsonl",
    };
    const result = sessionCompactPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe("validateEventPayload with session.compact", () => {
  test("valid session.compact data returns success", () => {
    const data = {
      cc_session_id: "cc-sess-001",
      compact_sequence: 0,
      transcript_path: "transcripts/sess.jsonl",
    };
    const result = validateEventPayload("session.compact", data);
    expect(result.success).toBe(true);
  });

  test("invalid session.compact data returns error", () => {
    const result = validateEventPayload("session.compact", { invalid: true });
    expect(result.success).toBe(false);
  });
});
