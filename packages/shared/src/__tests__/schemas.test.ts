/**
 * Tests for Zod schemas: event envelope, session payloads, ingest request,
 * and the payload validation registry.
 *
 * Validates both the happy path (valid data parses) and error path
 * (invalid data is rejected with appropriate errors).
 */

import { describe, expect, test } from "bun:test";
import { ulid } from "ulidx";
import {
  eventSchema,
  ingestRequestSchema,
  sessionStartPayloadSchema,
  sessionEndPayloadSchema,
  validateEventPayload,
} from "../schemas/index.js";

/** Helper: build a valid event object for testing */
function makeValidEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: ulid(),
    type: "session.start",
    timestamp: new Date().toISOString(),
    device_id: "device-001",
    workspace_id: "ws-001",
    session_id: "sess-001",
    data: { cc_session_id: "test" },
    blob_refs: [],
    ...overrides,
  };
}

describe("eventSchema", () => {
  test("valid event passes parsing", () => {
    const event = makeValidEvent();
    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  test("event with invalid ULID id fails", () => {
    const event = makeValidEvent({ id: "not-a-ulid" });
    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  test("event with lowercase ulid characters fails", () => {
    // ULID uses uppercase Crockford Base32
    const event = makeValidEvent({ id: "01aryz6s41tse4nff4ndizdq7c" });
    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  test("event with unknown type fails", () => {
    const event = makeValidEvent({ type: "unknown.type" });
    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  test("event with invalid timestamp fails", () => {
    const event = makeValidEvent({ timestamp: "not-a-date" });
    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  test("event with null session_id passes", () => {
    const event = makeValidEvent({ session_id: null });
    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  test("blob_refs defaults to empty array when omitted", () => {
    const event = makeValidEvent();
    delete (event as Record<string, unknown>).blob_refs;
    const result = eventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blob_refs).toEqual([]);
    }
  });
});

describe("sessionStartPayloadSchema", () => {
  test("valid session.start payload passes", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      cwd: "/home/user/project",
      git_branch: "main",
      git_remote: "git@github.com:user/repo.git",
      cc_version: "1.0.0",
      model: "claude-opus-4-20250514",
      source: "startup" as const,
      transcript_path: "transcripts/sess-001.json",
    };
    const result = sessionStartPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("session.start payload missing cwd fails", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      // cwd intentionally omitted
      git_branch: "main",
      git_remote: null,
      cc_version: "1.0.0",
      model: null,
      source: "startup",
      transcript_path: "transcripts/sess-001.json",
    };
    const result = sessionStartPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("session.start payload with invalid source fails", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      cwd: "/home/user/project",
      git_branch: null,
      git_remote: null,
      cc_version: "1.0.0",
      model: null,
      source: "unknown-source",
      transcript_path: "transcripts/sess-001.json",
    };
    const result = sessionStartPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe("sessionEndPayloadSchema", () => {
  test("valid session.end payload passes", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      duration_ms: 120000,
      end_reason: "exit" as const,
      transcript_path: "transcripts/sess-001.json",
    };
    const result = sessionEndPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("session.end payload with negative duration fails", () => {
    const payload = {
      cc_session_id: "cc-sess-001",
      duration_ms: -100,
      end_reason: "exit",
      transcript_path: "transcripts/sess-001.json",
    };
    const result = sessionEndPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe("ingestRequestSchema", () => {
  test("valid ingest request passes", () => {
    const request = { events: [makeValidEvent()] };
    const result = ingestRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  test("rejects empty events array", () => {
    const request = { events: [] };
    const result = ingestRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });

  test("rejects more than 100 events", () => {
    const events = Array.from({ length: 101 }, () => makeValidEvent());
    const request = { events };
    const result = ingestRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });

  test("accepts exactly 100 events", () => {
    const events = Array.from({ length: 100 }, () => makeValidEvent());
    const request = { events };
    const result = ingestRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });
});

describe("validateEventPayload", () => {
  test("session.start with valid data returns success", () => {
    const data = {
      cc_session_id: "cc-sess-001",
      cwd: "/home/user/project",
      git_branch: "main",
      git_remote: null,
      cc_version: "1.0.0",
      model: null,
      source: "startup",
      transcript_path: "transcripts/sess-001.json",
    };
    const result = validateEventPayload("session.start", data);
    expect(result.success).toBe(true);
  });

  test("session.start with invalid data returns error", () => {
    const result = validateEventPayload("session.start", { invalid: true });
    expect(result.success).toBe(false);
  });

  test("unregistered event type (device.connected) passes through — no schema", () => {
    const result = validateEventPayload("device.connected", { any: "data" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ any: "data" });
    }
  });

  test("unregistered event type (system.heartbeat) passes through", () => {
    const result = validateEventPayload("system.heartbeat", {});
    expect(result.success).toBe(true);
  });
});
