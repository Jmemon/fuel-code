# Task 5: Update Notification System

## parallel-group: B
## depends-on: T1
## blocks: none

---

## Description

Create a passive update checker that compares the running build's git SHA against the latest commit on the upstream `main` branch via the GitHub API. Results are cached for 1 hour. The checker is non-blocking, never throws, and can be disabled via env var. Update notifications appear in `fuel-code status` output and the TUI dashboard status bar.

---

## Relevant Files

### Create

**`packages/cli/src/lib/update-checker.ts`** — GitHub API update checker with caching.

```typescript
/**
 * Passive update checker for fuel-code.
 *
 * Compares the running build's git SHA against the latest commit on upstream main.
 * Results are cached for 1 hour in ~/.fuel-code/update-check.json.
 * Never blocks, never throws — returns null on any failure.
 *
 * Env vars:
 *   FUEL_CODE_UPSTREAM_REPO   — "owner/repo" format. Required for check to run.
 *   FUEL_CODE_DISABLE_UPDATE_CHECK — set to "true" to skip all checks.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BUILD_INFO } from "@fuel-code/shared";

export interface UpdateInfo {
  currentSha: string;
  latestSha: string;
  latestShort: string;
  latestDate: string;
}

interface CacheData {
  checkedAt: string;          // ISO timestamp of last check
  latestSha: string | null;   // null = up to date or check failed
  latestDate: string | null;
  currentSha: string;         // the SHA that was current when we last checked
}

const CACHE_DIR = join(homedir(), ".fuel-code");
const CACHE_FILE = join(CACHE_DIR, "update-check.json");
const CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour
const FETCH_TIMEOUT_MS = 5_000;          // 5 second timeout for GitHub API

/**
 * Check for available updates against the upstream repo.
 * Returns UpdateInfo if an update is available, null otherwise.
 * NEVER throws — all errors silently return null.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    // 1. Bail if disabled
    if (process.env.FUEL_CODE_DISABLE_UPDATE_CHECK === "true") return null;

    // 2. Bail in dev mode — "development" SHA can't meaningfully compare
    if (BUILD_INFO.commitSha === "development") return null;

    // 3. Determine upstream repo — required, no auto-derivation (YAGNI)
    const repo = process.env.FUEL_CODE_UPSTREAM_REPO;
    if (!repo) return null;

    // 4. Check cache — if fresh AND for the same current SHA, use cached result
    const cached = readCache();
    if (cached && cached.currentSha === BUILD_INFO.commitSha) {
      const age = Date.now() - new Date(cached.checkedAt).getTime();
      if (age < CACHE_TTL_MS) {
        if (cached.latestSha && cached.latestSha !== BUILD_INFO.commitSha) {
          return {
            currentSha: BUILD_INFO.commitShort,
            latestSha: cached.latestSha,
            latestShort: cached.latestSha.slice(0, 7),
            latestDate: cached.latestDate ?? "",
          };
        }
        return null; // up to date (cached)
      }
    }

    // 5. Fetch latest commit from GitHub API
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(
      `https://api.github.com/repos/${repo}/commits/main`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "fuel-code-update-checker",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);

    if (!res.ok) return null; // Rate limited, 404, etc.

    const data = (await res.json()) as {
      sha: string;
      commit: { committer: { date: string } };
    };
    const latestSha = data.sha;
    const latestDate = data.commit?.committer?.date ?? "";

    // 6. Write cache
    writeCache({
      checkedAt: new Date().toISOString(),
      latestSha: latestSha !== BUILD_INFO.commitSha ? latestSha : null,
      latestDate: latestSha !== BUILD_INFO.commitSha ? latestDate : null,
      currentSha: BUILD_INFO.commitSha,
    });

    // 7. Compare
    if (latestSha !== BUILD_INFO.commitSha) {
      return {
        currentSha: BUILD_INFO.commitShort,
        latestSha,
        latestShort: latestSha.slice(0, 7),
        latestDate,
      };
    }

    return null; // up to date
  } catch {
    return null; // Network error, parse error, timeout — never block the user
  }
}

function readCache(): CacheData | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as CacheData;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheData): void {
  try {
    // Ensure ~/.fuel-code/ exists (defensive — init creates it, but the update
    // checker might run before init in edge cases)
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2));
  } catch {
    // Cache write failure is non-fatal
  }
}
```

---

**`packages/cli/src/tui/hooks/useUpdateCheck.ts`** — React hook for async update check in TUI.

Follows the existing hook pattern (`useWsConnection.ts`, `useTodayStats.ts`).

```typescript
/**
 * React hook that checks for updates on mount.
 * Returns UpdateInfo if an update is available, null otherwise.
 * Non-blocking — uses dynamic import to avoid loading update-checker at module time.
 */

import { useState, useEffect } from "react";
import type { UpdateInfo } from "../../lib/update-checker.js";

export function useUpdateCheck(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let mounted = true;
    // Dynamic import to avoid adding update-checker to the critical render path
    import("../../lib/update-checker.js")
      .then(({ checkForUpdate }) =>
        checkForUpdate().then((result) => {
          if (mounted && result) setUpdate(result);
        }),
      )
      .catch(() => {}); // Never block the TUI

    return () => {
      mounted = false;
    };
  }, []);

  return update;
}
```

---

### Modify

**`packages/cli/src/commands/status.ts`** — Add update check and display.

1. Add import at top:
   ```typescript
   import { checkForUpdate, type UpdateInfo } from "../lib/update-checker.js";
   ```

2. In `runStatus()` (line 395), run the update check in parallel with status fetch for speed. Change the `fetchStatus()` call (around line 430) to:
   ```typescript
   const [data, updateInfo] = await Promise.all([
     fetchStatus(api, config),
     checkForUpdate(),
   ]);
   ```

3. Change the `formatStatus()` call (around line 432) to pass updateInfo:
   ```typescript
   outputResult(data, {
     json: opts?.json,
     format: (d) => formatStatus(d, updateInfo),
   });
   ```
   For JSON output, also include updateInfo in the data if present.

4. Update `formatStatus()` signature (line 279) to accept optional updateInfo:
   ```typescript
   export function formatStatus(data: StatusData, updateInfo?: UpdateInfo | null): string {
   ```

5. After the Version line (added in T1), conditionally add the Update line:
   ```typescript
   if (updateInfo) {
     const dateStr = updateInfo.latestDate ? updateInfo.latestDate.split("T")[0] : "";
     lines.push(
       `  Update:     ${pc.yellow("Available!")} ${updateInfo.latestShort}${dateStr ? ` (${dateStr})` : ""} — run: git pull && docker compose up --build -d`,
     );
   }
   ```

   Result when update available:
   ```
   fuel-code status

     Version:    abc1234 (2026-02-28, main)
     Update:     Available! def5678 (2026-03-01) — run: git pull && docker compose up --build -d
     Device:     MacBook-Pro (a1b2c3d4...)
     ...
   ```

   When up to date: no Update line shown (clean output).

---

**`packages/cli/src/tui/components/StatusBar.tsx`** — Add optional update indicator.

1. Add `updateAvailable` to `StatusBarProps`:
   ```typescript
   export interface StatusBarProps {
     stats: TodayStats;
     wsState: WsConnectionState;
     queuePending?: number;
     updateAvailable?: boolean;
   }
   ```

2. In the component body, add the prop to the destructure:
   ```typescript
   export function StatusBar({
     stats,
     wsState,
     queuePending = 0,
     updateAvailable = false,
   }: StatusBarProps): React.ReactElement {
   ```

3. Add an update indicator line after the Queue/Backend line (after the `</Box>` on line 54) and before the keyboard hints:
   ```tsx
   {updateAvailable && (
     <Box>
       <Text color="yellow">{"\u2191"} Update available</Text>
     </Box>
   )}
   ```

---

**`packages/cli/src/tui/Dashboard.tsx`** — Call update checker on mount.

1. Add import:
   ```typescript
   import { useUpdateCheck } from "./hooks/useUpdateCheck.js";
   ```

2. Inside the `Dashboard` component, add the hook call (after the existing hook calls, around line 81):
   ```typescript
   const updateInfo = useUpdateCheck();
   ```

3. Update the StatusBar render (line 283):
   ```tsx
   <StatusBar stats={stats} wsState={wsState} updateAvailable={!!updateInfo} />
   ```

---

### Read (for context)

- `packages/cli/src/tui/hooks/useTodayStats.ts` — existing hook pattern to follow
- `packages/cli/src/tui/hooks/useWsConnection.ts` — existing hook pattern
- `packages/cli/src/tui/Dashboard.tsx` — where StatusBar is rendered (line 283)
- `packages/cli/src/tui/components/StatusBar.tsx` — current StatusBarProps interface
- `packages/cli/src/commands/status.ts` — `formatStatus()` at line 279, `runStatus()` at line 395
- `packages/cli/src/lib/config.ts` — `~/.fuel-code/` path conventions

---

## Success Criteria

### Update Available
- With `FUEL_CODE_UPSTREAM_REPO=owner/repo` set and a stale build SHA: `fuel-code status` shows `Update: Available! def5678 (2026-03-01) — run: git pull && docker compose up --build -d` in yellow.
- TUI dashboard status bar shows `↑ Update available` in yellow.

### Up to Date
- With matching SHA (current build matches upstream main): no Update line in `fuel-code status`, no indicator in TUI.

### Caching
- After a successful check, `~/.fuel-code/update-check.json` is written with `checkedAt`, `latestSha`, `currentSha`.
- A second call within 1 hour reads from cache — no GitHub API request (verify by checking that `fetch` is not called, or by examining file mtime).
- If the user updates (pulls new SHA), the cache's `currentSha` no longer matches `BUILD_INFO.commitSha`, triggering a fresh check.

### Disabled Check
- With `FUEL_CODE_DISABLE_UPDATE_CHECK=true`: no GitHub API call, no update line, `fuel-code status` works normally.
- Without `FUEL_CODE_UPSTREAM_REPO` set: no check performed, no network call.

### Dev Mode
- With `BUILD_INFO.commitSha === "development"` (unstamped build): no update check performed. This prevents false "update available" messages in dev.

### Error Resilience
- Network timeout (offline or slow): `fuel-code status` works normally, no update line, no error output. The 5-second `AbortController` timeout prevents hanging.
- GitHub API rate limit (403): silently returns null.
- GitHub API 404 (repo not found): silently returns null.
- Cache file corruption (invalid JSON): treated as cache miss, fresh check runs.
- `~/.fuel-code/` directory doesn't exist: created by `mkdirSync({ recursive: true })` before cache write.

### TUI Integration
- The `useUpdateCheck` hook runs once on Dashboard mount.
- The check is non-blocking — the TUI renders immediately, update indicator appears when the check completes.
- Dynamic `import()` prevents the update checker from being part of the TUI's critical load path.

### Negative Tests
- The update checker NEVER throws — all errors return null.
- The update checker NEVER delays CLI execution beyond the 5-second fetch timeout.
- No console output from the update checker (no `console.log`, no `console.error`).
