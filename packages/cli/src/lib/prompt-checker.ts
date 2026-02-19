/**
 * Prompt checker for fuel-code CLI.
 *
 * Polls the backend for pending prompts (e.g., git hook installation)
 * that should be shown to the user on the next interactive CLI command.
 *
 * Design goals:
 *   - Non-blocking: uses a 2-second timeout so the CLI stays snappy
 *   - Silent failure: if the backend is unreachable, returns empty array
 *   - Lightweight: only called on interactive commands (not emit/queue)
 */

import type { FuelCodeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pending prompt retrieved from the backend */
export interface PendingPrompt {
  /** The type of prompt — currently only git_hooks_install */
  type: "git_hooks_install";
  /** Workspace ULID to identify which workspace this prompt is for */
  workspaceId: string;
  /** Human-readable workspace name (e.g., "fuel-code") */
  workspaceName: string;
  /** Canonical workspace ID (e.g., "github.com/user/fuel-code") */
  workspaceCanonicalId: string;
}

/** Timeout in milliseconds for the prompt check API call */
const PROMPT_CHECK_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the backend for pending prompts for this device.
 *
 * Returns an empty array if:
 *   - The backend is unreachable
 *   - The request times out (>2 seconds)
 *   - The response is not valid JSON
 *   - Any other error occurs
 *
 * This ensures the CLI never blocks or errors due to prompt checking.
 */
export async function checkPendingPrompts(
  config: FuelCodeConfig,
): Promise<PendingPrompt[]> {
  const baseUrl = config.backend.url.replace(/\/+$/, "");
  const url = `${baseUrl}/api/prompts/pending?device_id=${encodeURIComponent(config.device.id)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.backend.api_key}`,
      },
      signal: AbortSignal.timeout(PROMPT_CHECK_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Non-2xx response — silently ignore
      return [];
    }

    const body = (await response.json()) as {
      prompts: Array<{
        type: string;
        workspace_id: string;
        workspace_name: string;
        workspace_canonical_id: string;
      }>;
    };

    // Transform backend response into PendingPrompt objects
    return (body.prompts ?? []).map((p) => ({
      type: p.type as "git_hooks_install",
      workspaceId: p.workspace_id,
      workspaceName: p.workspace_name,
      workspaceCanonicalId: p.workspace_canonical_id,
    }));
  } catch {
    // Network error, timeout, JSON parse error — all silently ignored
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dismiss helper
// ---------------------------------------------------------------------------

/**
 * Dismiss a prompt by notifying the backend of the user's action.
 *
 * Fires and forgets — errors are silently swallowed since the worst case
 * is that the user gets prompted again on the next interactive command.
 */
export async function dismissPrompt(
  config: FuelCodeConfig,
  workspaceId: string,
  action: "accepted" | "declined",
): Promise<void> {
  const baseUrl = config.backend.url.replace(/\/+$/, "");
  const url = `${baseUrl}/api/prompts/dismiss`;

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.backend.api_key}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        device_id: config.device.id,
        action,
      }),
      signal: AbortSignal.timeout(PROMPT_CHECK_TIMEOUT_MS),
    });
  } catch {
    // Silently swallow — prompt will reappear next time if dismiss fails
  }
}
