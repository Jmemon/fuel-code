#!/usr/bin/env bash
# fuel-code: Claude Code SessionStart hook
#
# This script is registered in ~/.claude/settings.json by `fuel-code hooks install`.
# It fires when Claude Code starts a new session. All logic is delegated to the
# TypeScript helper — bash only exists to fork into the background so we never
# block Claude Code startup (must exit in <1s).
set -euo pipefail

# Pipe stdin (hook context JSON) to the TS helper.
# Run in background so we don't block Claude Code startup.
bun run "$(dirname "$0")/_helpers/session-start.ts" &

# Exit immediately — do not wait for the helper
exit 0
