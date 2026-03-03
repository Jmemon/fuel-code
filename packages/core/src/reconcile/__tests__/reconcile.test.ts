/**
 * Unit tests for the reconcile module: SessionSeed builders and computeGap.
 *
 * These are pure logic tests — no database or external services needed.
 * They verify that:
 *   1. buildSeedFromHook produces valid SessionSeed from a hook Event
 *   2. buildSeedFromFilesystem produces valid SessionSeed from a DiscoveredSession
 *   3. buildSeedFromRecovery produces valid SessionSeed from a DB session row
 *   4. computeGap returns all-false for "complete" sessions
 *   5. computeGap flags needsParsing for "transcript_ready" sessions
 *   6. computeGap flags needsSummary for "parsed" sessions
 *   7. Stale field detection catches backfill edge cases
 */

import { describe, expect, test } from "bun:test";
import {
  buildSeedFromHook,
  buildSeedFromFilesystem,
  buildSeedFromRecovery,
} from "../session-seed.js";
import { computeGap } from "../compute-gap.js";
import type { SessionSeed } from "../../types/reconcile.js";
import type { Event } from "@fuel-code/shared";
import type { DiscoveredSession } from "../../session-backfill.js";
import type { SessionForGap } from "../compute-gap.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHookEvent(overrides?: Partial<Event>): Event {
  return {
    id: "evt-001",
    type: "session.start",
    timestamp: "2026-03-03T10:00:00Z",
    device_id: "device-abc",
    workspace_id: "ws-123",
    session_id: null,
    data: {
      cc_session_id: "cc-sess-001",
      cwd: "/Users/john/project",
      git_branch: "main",
      git_remote: "git@github.com:org/repo.git",
      cc_version: "1.2.3",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: "/home/user/.claude/projects/-Users-john-project/abc.jsonl",
    },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

function makeEndEvent(): Event {
  return makeHookEvent({
    type: "session.end",
    timestamp: "2026-03-03T11:30:00Z",
    data: {
      cc_session_id: "cc-sess-001",
      cwd: "/Users/john/project",
      git_branch: "main",
      git_remote: "git@github.com:org/repo.git",
      cc_version: "1.2.3",
      model: "claude-sonnet-4-20250514",
      end_reason: "user_exit",
      duration_ms: 5400000,
      transcript_path: "/home/user/.claude/projects/-Users-john-project/abc.jsonl",
    },
  });
}

function makeDiscoveredSession(overrides?: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    sessionId: "disc-sess-001",
    transcriptPath: "/home/user/.claude/projects/-Users-john-project/abc.jsonl",
    projectDir: "-Users-john-project",
    resolvedCwd: "/Users/john/project",
    workspaceCanonicalId: "github.com/org/repo",
    gitBranch: "feature-branch",
    firstPrompt: "Help me fix this bug",
    firstTimestamp: "2026-03-01T09:00:00Z",
    lastTimestamp: "2026-03-01T10:30:00Z",
    fileSizeBytes: 102400,
    messageCount: 42,
    isLive: false,
    ...overrides,
  };
}

function makeSessionForGap(overrides?: Partial<SessionForGap>): SessionForGap {
  return {
    lifecycle: "transcript_ready",
    transcript_s3_key: "transcripts/cc-sess-001.jsonl",
    started_at: "2026-03-03T10:00:00Z",
    ended_at: "2026-03-03T11:30:00Z",
    duration_ms: 5400000,
    summary: null,
    subagent_count: 0,
    ...overrides,
  };
}

function makeSeed(overrides?: Partial<SessionSeed>): SessionSeed {
  return {
    ccSessionId: "cc-sess-001",
    origin: "hook",
    workspaceCanonicalId: "github.com/org/repo",
    deviceId: "device-abc",
    cwd: "/Users/john/project",
    gitBranch: "main",
    gitRemote: "git@github.com:org/repo.git",
    model: "claude-sonnet-4-20250514",
    ccVersion: "1.2.3",
    source: "hook:session.start",
    startedAt: "2026-03-03T10:00:00Z",
    endedAt: "2026-03-03T11:30:00Z",
    durationMs: 5400000,
    endReason: null,
    transcriptRef: { type: "disk", path: "/tmp/transcript.jsonl" },
    isLive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildSeedFromHook
// ---------------------------------------------------------------------------

describe("buildSeedFromHook", () => {
  test("produces valid SessionSeed from session.start event", () => {
    const event = makeHookEvent();
    const seed = buildSeedFromHook(event, "github.com/org/repo");

    expect(seed.ccSessionId).toBe("cc-sess-001");
    expect(seed.origin).toBe("hook");
    expect(seed.workspaceCanonicalId).toBe("github.com/org/repo");
    expect(seed.deviceId).toBe("device-abc");
    expect(seed.cwd).toBe("/Users/john/project");
    expect(seed.gitBranch).toBe("main");
    expect(seed.gitRemote).toBe("git@github.com:org/repo.git");
    expect(seed.model).toBe("claude-sonnet-4-20250514");
    expect(seed.ccVersion).toBe("1.2.3");
    expect(seed.source).toBe("hook:session.start");
    expect(seed.startedAt).toBe("2026-03-03T10:00:00Z");
    expect(seed.endedAt).toBeNull(); // session.start has no endedAt
    expect(seed.durationMs).toBeNull(); // session.start has no duration
    expect(seed.endReason).toBeNull();
    expect(seed.transcriptRef).toEqual({
      type: "disk",
      path: "/home/user/.claude/projects/-Users-john-project/abc.jsonl",
    });
    expect(seed.isLive).toBe(true); // session.start means session is live
  });

  test("produces valid SessionSeed from session.end event", () => {
    const event = makeEndEvent();
    const seed = buildSeedFromHook(event, "github.com/org/repo");

    expect(seed.ccSessionId).toBe("cc-sess-001");
    expect(seed.source).toBe("hook:session.end");
    expect(seed.endedAt).toBe("2026-03-03T11:30:00Z");
    expect(seed.durationMs).toBe(5400000);
    expect(seed.endReason).toBe("user_exit");
    expect(seed.isLive).toBe(false); // session.end means not live
  });

  test("handles missing optional fields gracefully", () => {
    const event = makeHookEvent({
      data: {
        cc_session_id: "cc-sess-002",
        cwd: "/tmp",
      },
    });
    const seed = buildSeedFromHook(event, "_unassociated");

    expect(seed.ccSessionId).toBe("cc-sess-002");
    expect(seed.gitBranch).toBeNull();
    expect(seed.gitRemote).toBeNull();
    expect(seed.model).toBeNull();
    expect(seed.ccVersion).toBeNull();
    expect(seed.transcriptRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSeedFromFilesystem
// ---------------------------------------------------------------------------

describe("buildSeedFromFilesystem", () => {
  test("produces valid SessionSeed from DiscoveredSession", () => {
    const discovered = makeDiscoveredSession();
    const seed = buildSeedFromFilesystem(discovered, "device-xyz");

    expect(seed.ccSessionId).toBe("disc-sess-001");
    expect(seed.origin).toBe("backfill");
    expect(seed.workspaceCanonicalId).toBe("github.com/org/repo");
    expect(seed.deviceId).toBe("device-xyz");
    expect(seed.cwd).toBe("/Users/john/project");
    expect(seed.gitBranch).toBe("feature-branch");
    expect(seed.gitRemote).toBeNull(); // not available from filesystem
    expect(seed.model).toBeNull(); // not reliably available
    expect(seed.ccVersion).toBeNull(); // not available from filesystem
    expect(seed.source).toBe("backfill:scan");
    expect(seed.startedAt).toBe("2026-03-01T09:00:00Z");
    expect(seed.endedAt).toBe("2026-03-01T10:30:00Z");
    expect(seed.endReason).toBeNull();
    expect(seed.transcriptRef).toEqual({
      type: "disk",
      path: "/home/user/.claude/projects/-Users-john-project/abc.jsonl",
    });
    expect(seed.isLive).toBe(false);
  });

  test("computes durationMs from timestamps", () => {
    const discovered = makeDiscoveredSession({
      firstTimestamp: "2026-03-01T09:00:00Z",
      lastTimestamp: "2026-03-01T10:30:00Z",
    });
    const seed = buildSeedFromFilesystem(discovered, "device-xyz");

    // 1.5 hours = 5400000ms
    expect(seed.durationMs).toBe(5400000);
  });

  test("returns null durationMs when timestamps are missing", () => {
    const discovered = makeDiscoveredSession({
      firstTimestamp: null,
      lastTimestamp: null,
    });
    const seed = buildSeedFromFilesystem(discovered, "device-xyz");
    expect(seed.durationMs).toBeNull();
  });

  test("marks live sessions correctly", () => {
    const discovered = makeDiscoveredSession({ isLive: true });
    const seed = buildSeedFromFilesystem(discovered, "device-xyz");
    expect(seed.isLive).toBe(true);
  });

  test("handles null resolvedCwd", () => {
    const discovered = makeDiscoveredSession({ resolvedCwd: null });
    const seed = buildSeedFromFilesystem(discovered, "device-xyz");
    expect(seed.cwd).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildSeedFromRecovery
// ---------------------------------------------------------------------------

describe("buildSeedFromRecovery", () => {
  test("produces valid SessionSeed from DB session row", () => {
    const sessionRow = {
      id: "rec-sess-001",
      workspace_id: "ws-456",
      device_id: "device-xyz",
      cwd: "/Users/john/project",
      git_branch: "main",
      git_remote: "git@github.com:org/repo.git",
      model: "claude-sonnet-4-20250514",
      lifecycle: "transcript_ready",
      started_at: "2026-03-02T14:00:00Z",
      ended_at: "2026-03-02T15:30:00Z",
      duration_ms: 5400000,
      end_reason: "user_exit",
      transcript_s3_key: "transcripts/rec-sess-001.jsonl",
    };

    const seed = buildSeedFromRecovery(sessionRow, "github.com/org/repo");

    expect(seed.ccSessionId).toBe("rec-sess-001");
    expect(seed.origin).toBe("recovery");
    expect(seed.workspaceCanonicalId).toBe("github.com/org/repo");
    expect(seed.deviceId).toBe("device-xyz");
    expect(seed.cwd).toBe("/Users/john/project");
    expect(seed.gitBranch).toBe("main");
    expect(seed.gitRemote).toBe("git@github.com:org/repo.git");
    expect(seed.model).toBe("claude-sonnet-4-20250514");
    expect(seed.ccVersion).toBeNull(); // not stored in DB
    expect(seed.source).toBe("recovery:sweep");
    expect(seed.startedAt).toBe("2026-03-02T14:00:00Z");
    expect(seed.endedAt).toBe("2026-03-02T15:30:00Z");
    expect(seed.durationMs).toBe(5400000);
    expect(seed.endReason).toBe("user_exit");
    expect(seed.transcriptRef).toEqual({
      type: "s3",
      key: "transcripts/rec-sess-001.jsonl",
    });
    expect(seed.isLive).toBe(false);
  });

  test("handles missing transcript_s3_key", () => {
    const sessionRow = {
      id: "rec-sess-002",
      workspace_id: "ws-456",
      device_id: "device-xyz",
      lifecycle: "ended",
      started_at: "2026-03-02T14:00:00Z",
    };

    const seed = buildSeedFromRecovery(sessionRow, "github.com/org/repo");
    expect(seed.transcriptRef).toBeNull();
  });

  test("handles minimal session row (missing optional fields)", () => {
    const sessionRow = {
      id: "rec-sess-003",
      workspace_id: "ws-456",
      device_id: "device-xyz",
      lifecycle: "detected",
      started_at: "2026-03-02T14:00:00Z",
    };

    const seed = buildSeedFromRecovery(sessionRow, "_unassociated");
    expect(seed.cwd).toBe("");
    expect(seed.gitBranch).toBeNull();
    expect(seed.gitRemote).toBeNull();
    expect(seed.model).toBeNull();
    expect(seed.endedAt).toBeNull();
    expect(seed.durationMs).toBeNull();
    expect(seed.endReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeGap
// ---------------------------------------------------------------------------

describe("computeGap", () => {
  test("returns all-false for 'complete' session", () => {
    const session = makeSessionForGap({ lifecycle: "complete" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.needsTranscriptUpload).toBe(false);
    expect(gap.needsParsing).toBe(false);
    expect(gap.needsSubagentParsing).toBe(false);
    expect(gap.needsTeamDetection).toBe(false);
    expect(gap.needsStats).toBe(false);
    expect(gap.needsSummary).toBe(false);
    expect(gap.needsTeammateSummaries).toBe(false);
    expect(gap.needsLifecycleAdvance).toBe(false);
    // Stale fields can still be true for complete sessions if data mismatches,
    // but staleSubagentCount is false for terminal
    expect(gap.staleSubagentCount).toBe(false);
  });

  test("returns all-false for 'failed' session", () => {
    const session = makeSessionForGap({ lifecycle: "failed" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.needsTranscriptUpload).toBe(false);
    expect(gap.needsParsing).toBe(false);
    expect(gap.needsSummary).toBe(false);
    expect(gap.needsLifecycleAdvance).toBe(false);
    expect(gap.staleSubagentCount).toBe(false);
  });

  test("flags needsParsing for 'transcript_ready' session", () => {
    const session = makeSessionForGap({ lifecycle: "transcript_ready" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.needsParsing).toBe(true);
    expect(gap.needsSubagentParsing).toBe(true);
    expect(gap.needsTeamDetection).toBe(true);
    expect(gap.needsStats).toBe(true);
    expect(gap.needsSummary).toBe(false); // not yet — needs parsing first
    expect(gap.needsLifecycleAdvance).toBe(true);
  });

  test("flags needsSummary for 'parsed' session", () => {
    const session = makeSessionForGap({ lifecycle: "parsed" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.needsParsing).toBe(false);
    expect(gap.needsSummary).toBe(true);
    expect(gap.needsTeammateSummaries).toBe(true);
    expect(gap.needsLifecycleAdvance).toBe(true);
  });

  test("flags needsTeammateSummaries for 'summarized' session", () => {
    const session = makeSessionForGap({ lifecycle: "summarized" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.needsParsing).toBe(false);
    expect(gap.needsSummary).toBe(false);
    expect(gap.needsTeammateSummaries).toBe(true);
    expect(gap.needsLifecycleAdvance).toBe(true);
  });

  test("flags needsTranscriptUpload when no S3 key and disk ref", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      transcript_s3_key: null,
    });
    const seed = makeSeed({
      transcriptRef: { type: "disk", path: "/tmp/transcript.jsonl" },
    });
    const gap = computeGap(session, seed);

    expect(gap.needsTranscriptUpload).toBe(true);
  });

  test("does NOT flag needsTranscriptUpload when S3 key already exists", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      transcript_s3_key: "transcripts/existing.jsonl",
    });
    const seed = makeSeed({
      transcriptRef: { type: "disk", path: "/tmp/transcript.jsonl" },
    });
    const gap = computeGap(session, seed);

    expect(gap.needsTranscriptUpload).toBe(false);
  });

  test("does NOT flag needsTranscriptUpload when ref is S3 (already uploaded)", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      transcript_s3_key: null,
    });
    const seed = makeSeed({
      transcriptRef: { type: "s3", key: "transcripts/abc.jsonl" },
    });
    const gap = computeGap(session, seed);

    expect(gap.needsTranscriptUpload).toBe(false);
  });

  test("does NOT flag needsTranscriptUpload when ref is null", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      transcript_s3_key: null,
    });
    const seed = makeSeed({ transcriptRef: null });
    const gap = computeGap(session, seed);

    expect(gap.needsTranscriptUpload).toBe(false);
  });

  // Stale field detection

  test("detects staleStartedAt when DB has started_at === ended_at but seed differs", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      started_at: "2026-03-03T11:30:00Z",
      ended_at: "2026-03-03T11:30:00Z",
    });
    const seed = makeSeed({
      startedAt: "2026-03-03T10:00:00Z",
      endedAt: "2026-03-03T11:30:00Z",
    });
    const gap = computeGap(session, seed);

    expect(gap.staleStartedAt).toBe(true);
  });

  test("does NOT flag staleStartedAt when DB timestamps differ", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      started_at: "2026-03-03T10:00:00Z",
      ended_at: "2026-03-03T11:30:00Z",
    });
    const seed = makeSeed({
      startedAt: "2026-03-03T10:00:00Z",
      endedAt: "2026-03-03T11:30:00Z",
    });
    const gap = computeGap(session, seed);

    expect(gap.staleStartedAt).toBe(false);
  });

  test("detects staleDurationMs when DB has 0 but seed has real duration", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      duration_ms: 0,
    });
    const seed = makeSeed({ durationMs: 5400000 });
    const gap = computeGap(session, seed);

    expect(gap.staleDurationMs).toBe(true);
  });

  test("does NOT flag staleDurationMs when DB already has a value", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      duration_ms: 5400000,
    });
    const seed = makeSeed({ durationMs: 5400000 });
    const gap = computeGap(session, seed);

    expect(gap.staleDurationMs).toBe(false);
  });

  test("detects staleDurationMs when DB has null duration", () => {
    const session = makeSessionForGap({
      lifecycle: "ended",
      duration_ms: null,
    });
    const seed = makeSeed({ durationMs: 3000 });
    const gap = computeGap(session, seed);

    expect(gap.staleDurationMs).toBe(true);
  });

  test("flags staleSubagentCount for non-terminal sessions", () => {
    const session = makeSessionForGap({ lifecycle: "parsed" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.staleSubagentCount).toBe(true);
  });

  test("'detected' session has needsLifecycleAdvance but no parsing/summary flags", () => {
    const session = makeSessionForGap({ lifecycle: "detected" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.needsLifecycleAdvance).toBe(true);
    expect(gap.needsParsing).toBe(false);
    expect(gap.needsSummary).toBe(false);
    expect(gap.needsTeammateSummaries).toBe(false);
  });

  test("'ended' session has needsLifecycleAdvance but no parsing flags", () => {
    const session = makeSessionForGap({ lifecycle: "ended" });
    const seed = makeSeed();
    const gap = computeGap(session, seed);

    expect(gap.needsLifecycleAdvance).toBe(true);
    expect(gap.needsParsing).toBe(false);
    expect(gap.needsSummary).toBe(false);
  });
});
