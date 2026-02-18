#!/usr/bin/env bash
# fuel-code: Claude Code SessionEnd/Stop hook
#
# This script is registered in ~/.claude/settings.json by `fuel-code hooks install`.
# It fires when Claude Code ends a session (CC uses "Stop" as the hook name).
# All logic is delegated to the TypeScript helper.
set -euo pipefail

# Pipe stdin (hook context JSON) to the TS helper.
# Run in background so we don't block Claude Code shutdown.
bun run "$(dirname "$0")/_helpers/session-end.ts" &

# Exit immediately — do not wait for the helper
exit 0
