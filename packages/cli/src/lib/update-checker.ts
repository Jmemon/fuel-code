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
