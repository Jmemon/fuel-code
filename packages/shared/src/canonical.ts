/**
 * Git remote URL normalization and workspace canonical ID derivation.
 *
 * Workspaces are identified by a canonical_id derived from their git remote URL.
 * This module normalizes URLs from various git hosting services and protocols
 * into a consistent format, then derives human-readable display names.
 *
 * Normalization rules:
 *   1. Strip protocol (https://, http://, ssh://, git://)
 *   2. Strip auth prefix (everything before @ in SCP-style URLs)
 *   3. Replace ":" with "/" for SCP-style (git@github.com:user/repo)
 *   4. Strip ".git" suffix
 *   5. Lowercase the host portion only (path case preserved)
 *   6. Trim trailing slashes
 *   7. Return null if input is empty or unparseable
 */

import { createHash } from "crypto";

/**
 * Normalize a git remote URL into a canonical form.
 *
 * Handles all common git URL formats:
 *   - HTTPS:  https://github.com/user/repo.git
 *   - SSH:    ssh://git@github.com/user/repo
 *   - SCP:    git@github.com:user/repo.git
 *   - Git:    git://github.com/repo.git
 *
 * Returns null for empty or unparseable input — never throws.
 *
 * @example
 *   normalizeGitRemote("git@github.com:user/repo.git") // "github.com/user/repo"
 *   normalizeGitRemote("https://GITHUB.COM/User/Repo") // "github.com/User/Repo"
 *   normalizeGitRemote("")                              // null
 */
export function normalizeGitRemote(remoteUrl: string): string | null {
  // Guard: empty or whitespace-only input
  if (!remoteUrl || !remoteUrl.trim()) {
    return null;
  }

  let url = remoteUrl.trim();

  // Step 1 & 2: Detect and handle SCP-style URLs (user@host:path)
  // These don't have a protocol prefix like "://"
  // Match pattern: [user@]host:path (where : is NOT followed by //)
  const scpMatch = url.match(/^(?:[^@]+@)?([^:/]+):(?!\/\/)(.+)$/);
  if (scpMatch) {
    // SCP-style: convert to normalized form (host/path)
    const host = scpMatch[1].toLowerCase();
    let path = scpMatch[2];

    // Strip .git suffix
    path = path.replace(/\.git$/, "");
    // Trim trailing slashes
    path = path.replace(/\/+$/, "");

    if (!host || !path) {
      return null;
    }

    return `${host}/${path}`;
  }

  // Step 1: Strip protocol prefixes
  url = url.replace(/^(?:https?|ssh|git):\/\//, "");

  // Step 2: Strip auth prefix (user@host → host)
  url = url.replace(/^[^@]+@/, "");

  // At this point we should have "host/path" format
  // Split into host and path at the first "/"
  const slashIndex = url.indexOf("/");
  if (slashIndex === -1 || slashIndex === 0) {
    // No path component — not a valid git remote
    return null;
  }

  let host = url.substring(0, slashIndex);
  let path = url.substring(slashIndex + 1);

  // Step 5: Lowercase host only
  host = host.toLowerCase();

  // Strip port from host if present (e.g., github.com:443 after protocol strip)
  // This handles the case where a URL like ssh://git@host:port/path has been processed
  host = host.replace(/:\d+$/, "");

  // Step 4: Strip .git suffix from path
  path = path.replace(/\.git$/, "");

  // Step 6: Trim trailing slashes from path
  path = path.replace(/\/+$/, "");

  if (!host || !path) {
    return null;
  }

  return `${host}/${path}`;
}

/**
 * Derive a workspace canonical ID from git remote and commit info.
 *
 * Priority:
 *   1. If a remote URL is available, normalize it
 *   2. If no remote but a first commit hash exists, use "local:<sha256>"
 *   3. If neither, return "_unassociated"
 *
 * @param remoteUrl - The git remote origin URL (or null)
 * @param firstCommitHash - The SHA of the first commit in the repo (or null)
 */
export function deriveWorkspaceCanonicalId(
  remoteUrl: string | null,
  firstCommitHash: string | null,
): string {
  // Priority 1: Normalize remote URL
  if (remoteUrl && remoteUrl.trim()) {
    const normalized = normalizeGitRemote(remoteUrl);
    return normalized ?? "_unassociated";
  }

  // Priority 2: Hash the first commit for local-only repos
  if (firstCommitHash && firstCommitHash.trim()) {
    const hash = createHash("sha256").update(firstCommitHash).digest("hex");
    return `local:${hash}`;
  }

  // Priority 3: No git info available
  return "_unassociated";
}

/**
 * Derive a human-readable display name from a workspace canonical ID.
 *
 * - "_unassociated" → "_unassociated"
 * - "local:abc123..." → "local-abc12345" (first 8 hex chars)
 * - "github.com/user/repo" → "repo" (last path segment)
 *
 * @param canonicalId - The workspace canonical_id
 */
export function deriveDisplayName(canonicalId: string): string {
  // Sentinel value — return as-is
  if (canonicalId === "_unassociated") {
    return "_unassociated";
  }

  // Local repo — show prefix + first 8 chars of hash
  if (canonicalId.startsWith("local:")) {
    const hash = canonicalId.slice("local:".length);
    return `local-${hash.slice(0, 8)}`;
  }

  // Remote URL — extract the last path segment (repo name)
  const segments = canonicalId.split("/").filter(Boolean);
  return segments[segments.length - 1] || canonicalId;
}
