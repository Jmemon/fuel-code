/**
 * TypeScript helper for the Claude Code SessionEnd/Stop hook.
 *
 * Reads CC hook context JSON from stdin, resolves workspace identity,
 * and emits a session.end event via `fuel-code emit`.
 *
 * This script runs standalone via `bun run session-end.ts`. It is NOT
 * imported as a module — it reads stdin and spawns a child process.
 *
 * Constraints:
 *   - Must produce NO stdout/stderr (could confuse CC)
 *   - Must handle ALL errors silently (never crash, never block CC)
 *   - Should complete within 2-3 seconds
 */

import { resolveWorkspace } from "./resolve-workspace.js";

/**
 * Main entry point. Wrapped in an async IIFE so we can use await.
 * The outer try/catch ensures we NEVER crash — exit 0 on any error.
 */
(async () => {
  try {
    // 1. Read stdin (CC pipes hook context JSON)
    const input = await readStdin();

    // 2. Parse JSON — exit silently if invalid
    let context: Record<string, unknown>;
    try {
      context = JSON.parse(input);
    } catch {
      process.exit(0);
    }

    // 3. Extract session_id — can't track without it
    const sessionId = String(context.session_id ?? "").trim();
    if (!sessionId) {
      process.exit(0);
    }

    // 4. Extract remaining fields with defaults
    const cwd = String(context.cwd ?? process.cwd()).trim();
    const transcriptPath = String(context.transcript_path ?? "").trim();
    const endReason = String(context.end_reason ?? "exit").trim();

    // 5. Resolve workspace identity from CWD
    const workspace = await resolveWorkspace(cwd);

    // 6. Construct session.end payload
    //    duration_ms: 0 signals the server to compute actual duration from started_at and ended_at.
    const payload = {
      cc_session_id: sessionId,
      duration_ms: 0,
      end_reason: endReason,
      transcript_path: transcriptPath,
    };

    // 7. Call `fuel-code emit session.end`
    const dataJson = JSON.stringify(payload);
    const proc = Bun.spawn(
      [
        "fuel-code",
        "emit",
        "session.end",
        "--data",
        dataJson,
        "--workspace-id",
        workspace.workspaceId,
        "--session-id",
        sessionId,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );

    // Wait for the emit process (has its own 2s timeout)
    await proc.exited;

    // After the emit completes, spawn a background transcript upload.
    // This runs detached so the hook script can exit immediately.
    // The upload command handles all errors internally and always exits 0.
    if (transcriptPath) {
      Bun.spawn(
        [
          "fuel-code",
          "transcript",
          "upload",
          "--session-id",
          sessionId,
          "--file",
          transcriptPath,
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
          // Don't wait — runs in background after this script exits
        },
      );
    }
  } catch {
    // Swallow all errors — hooks must never fail
  }

  // 8. Always exit 0
  process.exit(0);
})();

/**
 * Read all of stdin into a string.
 * Returns empty string if stdin is not available or empty.
 */
async function readStdin(): Promise<string> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch {
    return "";
  }
}
