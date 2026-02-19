/**
 * Tests for S3 key construction utilities.
 *
 * Validates that key patterns match the expected format so that
 * producers (CLI) and consumers (backend) agree on object paths.
 */

import { describe, expect, test } from "bun:test";
import {
  buildTranscriptKey,
  buildParsedBackupKey,
  buildArtifactKey,
} from "../s3-keys.js";

describe("buildTranscriptKey", () => {
  test("returns correct path for a standard workspace and session", () => {
    const key = buildTranscriptKey("github.com/user/repo", "abc-123");
    expect(key).toBe("transcripts/github.com/user/repo/abc-123/raw.jsonl");
  });
});

describe("buildParsedBackupKey", () => {
  test("returns correct path for a standard workspace and session", () => {
    const key = buildParsedBackupKey("github.com/user/repo", "abc-123");
    expect(key).toBe("transcripts/github.com/user/repo/abc-123/parsed.json");
  });
});

describe("buildArtifactKey", () => {
  test("returns correct path for a session, artifact id, and extension", () => {
    const key = buildArtifactKey("abc-123", "artifact-1", "json");
    expect(key).toBe("artifacts/abc-123/artifact-1.json");
  });
});

describe("special characters in keys", () => {
  test("workspace canonical IDs with special characters are preserved as-is", () => {
    // Workspace canonical IDs can contain slashes, dots, and hyphens
    const key = buildTranscriptKey(
      "github.com/my-org/my-repo.v2",
      "sess-with-dashes",
    );
    expect(key).toBe(
      "transcripts/github.com/my-org/my-repo.v2/sess-with-dashes/raw.jsonl",
    );
  });

  test("parsed backup key preserves special characters", () => {
    const key = buildParsedBackupKey(
      "gitlab.com/team/sub-group/project",
      "session_123",
    );
    expect(key).toBe(
      "transcripts/gitlab.com/team/sub-group/project/session_123/parsed.json",
    );
  });

  test("artifact key preserves underscores and hyphens", () => {
    const key = buildArtifactKey("sess_abc-123", "artifact_456-def", "txt");
    expect(key).toBe("artifacts/sess_abc-123/artifact_456-def.txt");
  });
});
