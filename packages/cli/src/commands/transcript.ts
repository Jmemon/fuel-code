/**
 * `fuel-code transcript` command.
 *
 * Internal command for uploading transcript JSONL files to the backend.
 * Called by the Claude Code session.end hook helper after emitting the
 * session.end event. Not intended for direct user invocation.
 *
 * Design constraints (same as emit command):
 *   - Exit code MUST always be 0 (hooks must not fail)
 *   - No stdout on success (hooks capture stdout)
 *   - Errors logged to stderr only
 */

import { Command } from "commander";
import * as fs from "node:fs";
import pino from "pino";
import { loadConfig } from "../lib/config.js";

// ---------------------------------------------------------------------------
// Logger — writes to stderr to keep stdout clean for hooks
// ---------------------------------------------------------------------------

const logger = pino({
  name: "fuel-code:transcript",
  level: process.env.LOG_LEVEL ?? "warn",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 2 } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum recommended file size for uploads (200MB matches server limit) */
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

/** Upload timeout — transcripts can be large, allow generous time */
const UPLOAD_TIMEOUT_MS = 120_000;

/** Retry config for 404s — the session.end event may not be processed yet */
const RETRY_ON_404_MAX = 5;
const RETRY_ON_404_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * Create the `transcript` subcommand group for the fuel-code CLI.
 * Returns a Commander Command with the `upload` subcommand.
 */
export function createTranscriptCommand(): Command {
  const cmd = new Command("transcript").description(
    "Transcript management (internal)",
  );

  cmd
    .command("upload")
    .description("Upload a transcript JSONL file to the backend")
    .requiredOption("--session-id <id>", "Session ID")
    .requiredOption("--file <path>", "Path to transcript JSONL file")
    .action(async (opts: { sessionId: string; file: string }) => {
      await runTranscriptUpload(opts.sessionId, opts.file);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Core upload logic — extracted for testability
// ---------------------------------------------------------------------------

/**
 * Upload a transcript JSONL file to the backend.
 *
 * This function NEVER throws and NEVER sets a non-zero exit code.
 * All errors are logged to stderr and the function returns gracefully.
 *
 * @param sessionId - The session this transcript belongs to
 * @param filePath  - Absolute path to the JSONL transcript file on disk
 */
export async function runTranscriptUpload(
  sessionId: string,
  filePath: string,
): Promise<void> {
  // 1. Load config. If missing: exit gracefully (fuel-code not initialized)
  let config;
  try {
    config = loadConfig();
  } catch {
    logger.warn("Config not found — cannot upload transcript");
    return;
  }

  // 2. Check file exists
  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, "Transcript file not found — skipping upload");
    process.stderr.write(
      `fuel-code: transcript file not found: ${filePath}\n`,
    );
    return;
  }

  // 3. Check file size
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    logger.warn({ filePath }, "Transcript file is empty — skipping upload");
    return;
  }

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    logger.warn(
      { filePath, size: stat.size, maxSize: MAX_FILE_SIZE_BYTES },
      "Transcript file exceeds 200MB limit — attempting upload anyway",
    );
    process.stderr.write(
      `fuel-code: transcript file is ${Math.round(stat.size / 1024 / 1024)}MB (limit: 200MB)\n`,
    );
  }

  // 4. POST to server — stream the file body
  const url = `${config.backend.url.replace(/\/+$/, "")}/api/sessions/${sessionId}/transcript/upload`;

  // Read the file once — reused across retries
  const fileContent = fs.readFileSync(filePath);

  // Retry loop: the session.end event is processed async via Redis streams,
  // so the session row may not exist yet when this upload fires. Retry on 404
  // to give the event processor time to create the row (including backfill).
  for (let attempt = 1; attempt <= RETRY_ON_404_MAX; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${config.backend.api_key}`,
        },
        body: fileContent,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });

      if (response.status === 404 && attempt < RETRY_ON_404_MAX) {
        logger.info(
          { sessionId, attempt },
          "Session not found yet — retrying after delay",
        );
        await new Promise((r) => setTimeout(r, RETRY_ON_404_DELAY_MS));
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        logger.warn(
          { sessionId, status: response.status, body },
          `Transcript upload returned HTTP ${response.status}`,
        );
        process.stderr.write(
          `fuel-code: transcript upload failed (HTTP ${response.status})\n`,
        );
        return;
      }

      const result = await response.json().catch(() => ({}));
      logger.info(
        { sessionId, result },
        "Transcript uploaded successfully",
      );
      return;
    } catch (err) {
      // Network error, timeout, etc. — log and exit gracefully
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { sessionId, filePath, error: message },
        "Transcript upload failed",
      );
      process.stderr.write(
        `fuel-code: transcript upload failed: ${message}\n`,
      );
      return;
    }
  }
}
