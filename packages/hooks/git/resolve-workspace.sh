#!/usr/bin/env bash
# resolve-workspace.sh
# Outputs workspace canonical ID to stdout.
# Exits 1 if no remote found (not a git repo, no origin remote, etc.)
#
# Normalization logic mirrors normalizeGitRemote() in shared/src/canonical.ts:
#   SSH:   git@github.com:user/repo.git  -> github.com/user/repo
#   HTTPS: https://github.com/user/repo.git -> github.com/user/repo
#   No remote + commits -> local:<sha256 of first commit hash>
#   No remote + no commits (empty repo) -> exit 1

REMOTE_URL=$(git remote get-url origin 2>/dev/null)

# No origin? Try first remote alphabetically.
if [ -z "$REMOTE_URL" ]; then
  FIRST_REMOTE=$(git remote 2>/dev/null | sort | head -1)
  if [ -n "$FIRST_REMOTE" ]; then
    REMOTE_URL=$(git remote get-url "$FIRST_REMOTE" 2>/dev/null)
  fi
fi

if [ -z "$REMOTE_URL" ]; then
  # No remote at all. Check if it's a git repo with commits (local-only repo).
  FIRST_COMMIT=$(git rev-list --max-parents=0 HEAD 2>/dev/null | head -1)
  if [ -n "$FIRST_COMMIT" ]; then
    # local:<sha256 of first commit hash> — deterministic per repo
    echo "local:$(echo -n "$FIRST_COMMIT" | shasum -a 256 | cut -d' ' -f1)"
    exit 0
  fi
  # Not a git repo or empty repo
  exit 1
fi

# Normalize SSH: git@github.com:user/repo.git -> github.com/user/repo
if [[ "$REMOTE_URL" =~ ^[a-zA-Z0-9._-]+@([^:]+):(.+)$ ]]; then
  HOST="${BASH_REMATCH[1]}"
  # Lowercase host to match TS normalizeGitRemote()
  HOST=$(echo "$HOST" | tr '[:upper:]' '[:lower:]')
  PATH_PART="${BASH_REMATCH[2]}"
  # Strip .git suffix
  PATH_PART="${PATH_PART%.git}"
  echo "${HOST}/${PATH_PART}"
  exit 0
fi

# Normalize HTTPS: https://github.com/user/repo.git -> github.com/user/repo
if [[ "$REMOTE_URL" =~ ^https?://([^/]+)/(.+)$ ]]; then
  HOST="${BASH_REMATCH[1]}"
  # Lowercase host to match TS normalizeGitRemote()
  HOST=$(echo "$HOST" | tr '[:upper:]' '[:lower:]')
  PATH_PART="${BASH_REMATCH[2]}"
  PATH_PART="${PATH_PART%.git}"
  # Strip trailing slash
  PATH_PART="${PATH_PART%/}"
  echo "${HOST}/${PATH_PART}"
  exit 0
fi

# Unknown format — use as-is (e.g., file:// URLs)
echo "$REMOTE_URL"
exit 0
