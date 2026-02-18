/**
 * Tests for git remote URL normalization and workspace canonical ID derivation.
 *
 * Covers all URL formats (HTTPS, SSH, SCP-style, Git protocol),
 * edge cases (empty input, trailing slashes, enterprise hosts),
 * and the full canonical ID / display name derivation pipeline.
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeGitRemote,
  deriveWorkspaceCanonicalId,
  deriveDisplayName,
} from "../canonical.js";

describe("normalizeGitRemote", () => {
  test("SCP-style git URL: git@github.com:user/repo.git", () => {
    expect(normalizeGitRemote("git@github.com:user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("HTTPS URL: https://github.com/user/repo.git", () => {
    expect(normalizeGitRemote("https://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("SSH URL: ssh://git@github.com/user/repo", () => {
    expect(normalizeGitRemote("ssh://git@github.com/user/repo")).toBe(
      "github.com/user/repo",
    );
  });

  test("host is lowercased, path case is preserved", () => {
    expect(normalizeGitRemote("https://GITHUB.COM/User/Repo.git")).toBe(
      "github.com/User/Repo",
    );
  });

  test("enterprise GitHub: git@github.company.com:org/repo.git", () => {
    expect(normalizeGitRemote("git@github.company.com:org/repo.git")).toBe(
      "github.company.com/org/repo",
    );
  });

  test("empty string returns null", () => {
    expect(normalizeGitRemote("")).toBeNull();
  });

  test("not a URL returns null", () => {
    expect(normalizeGitRemote("not-a-url")).toBeNull();
  });

  test("URL with trailing slash is trimmed", () => {
    expect(normalizeGitRemote("https://github.com/user/repo/")).toBe(
      "github.com/user/repo",
    );
  });

  test("git:// protocol URL", () => {
    expect(normalizeGitRemote("git://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("http:// protocol URL", () => {
    expect(normalizeGitRemote("http://github.com/user/repo.git")).toBe(
      "github.com/user/repo",
    );
  });

  test("whitespace-only input returns null", () => {
    expect(normalizeGitRemote("   ")).toBeNull();
  });

  test("URL without .git suffix is handled", () => {
    expect(normalizeGitRemote("https://github.com/user/repo")).toBe(
      "github.com/user/repo",
    );
  });
});

describe("deriveDisplayName", () => {
  test("extracts repo name from remote canonical ID", () => {
    expect(deriveDisplayName("github.com/user/fuel-code")).toBe("fuel-code");
  });

  test("returns _unassociated for sentinel value", () => {
    expect(deriveDisplayName("_unassociated")).toBe("_unassociated");
  });

  test("returns local- prefix with first 8 hash chars", () => {
    const hash = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    expect(deriveDisplayName(`local:${hash}`)).toBe("local-abcdef12");
  });

  test("handles nested org paths", () => {
    expect(deriveDisplayName("gitlab.com/org/subgroup/repo")).toBe("repo");
  });
});

describe("deriveWorkspaceCanonicalId", () => {
  test("returns _unassociated when both null", () => {
    expect(deriveWorkspaceCanonicalId(null, null)).toBe("_unassociated");
  });

  test("normalizes remote URL when provided", () => {
    expect(
      deriveWorkspaceCanonicalId("git@github.com:user/repo.git", null),
    ).toBe("github.com/user/repo");
  });

  test("returns local:<sha256> when only commit hash provided", () => {
    const result = deriveWorkspaceCanonicalId(null, "abc123");
    expect(result).toMatch(/^local:[0-9a-f]{64}$/);
  });

  test("prefers remote URL over commit hash", () => {
    const result = deriveWorkspaceCanonicalId(
      "git@github.com:user/repo.git",
      "abc123",
    );
    expect(result).toBe("github.com/user/repo");
  });

  test("returns _unassociated for empty remote with no commit", () => {
    expect(deriveWorkspaceCanonicalId("", null)).toBe("_unassociated");
  });
});
