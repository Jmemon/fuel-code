/**
 * `fuel-code session <id>` command — detailed session view.
 *
 * The most feature-rich CLI command. Without flags, displays a session summary
 * card. With flags, shows specific views (transcript, events, git) or performs
 * mutations (tag, reparse) and data export (JSON, Markdown).
 *
 * Flag priority order: --tag > --reparse > --export > --transcript > --events > --git > default
 *
 * Data-fetching functions are exported separately from presentation functions
 * so the TUI layer can reuse data fetching without pulling in CLI rendering.
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import pc from "picocolors";
import type { Session, Event, GitActivity, TranscriptMessage } from "@fuel-code/shared";
import { FuelApiClient, ApiError } from "../lib/api-client.js";
import {
  formatDuration,
  formatCost,
  formatRelativeTime,
  formatLifecycle,
  formatTokens,
  renderTable,
  truncate,
  formatError,
  outputResult,
} from "../lib/formatters.js";
import { resolveSessionId } from "../lib/session-resolver.js";
import {
  renderTranscript,
  type TranscriptMessageWithBlocks,
} from "../lib/transcript-renderer.js";

// ---------------------------------------------------------------------------
// Extended Session type — the API returns sessions with joined fields
// that are not in the base shared Session type
// ---------------------------------------------------------------------------

/** Session detail as returned by the API with joined workspace/device info and stats */
export interface SessionDetail extends Session {
  workspace_name?: string;
  workspace_canonical_id?: string;
  device_name?: string;
  device_type?: string;
  cost_estimate_usd?: number | null;
  summary?: string | null;
  initial_prompt?: string | null;
  tags?: string[];
  branch?: string | null;
  stats?: {
    tokens_in?: number | null;
    tokens_out?: number | null;
    tokens_cache?: number | null;
    total_messages?: number | null;
    tool_use_count?: number | null;
    commit_count?: number | null;
  };
}

/** Combined export data for --export flag */
export interface SessionExportData {
  session: SessionDetail;
  transcript: TranscriptMessage[];
  events: Event[];
  git_activity: GitActivity[];
  exported_at: string;
}

// ---------------------------------------------------------------------------
// Data Layer — exported for TUI reuse
// ---------------------------------------------------------------------------

/** Fetch full session detail by ID */
export async function fetchSessionDetail(api: FuelApiClient, sessionId: string): Promise<SessionDetail> {
  return (await api.getSession(sessionId)) as SessionDetail;
}

/** Fetch transcript messages for a session */
export async function fetchSessionTranscript(api: FuelApiClient, sessionId: string): Promise<TranscriptMessage[]> {
  return api.getTranscript(sessionId);
}

/** Fetch events for a session */
export async function fetchSessionEvents(api: FuelApiClient, sessionId: string): Promise<Event[]> {
  return api.getSessionEvents(sessionId);
}

/** Fetch git activity for a session */
export async function fetchSessionGit(api: FuelApiClient, sessionId: string): Promise<GitActivity[]> {
  return api.getSessionGit(sessionId);
}

/** Fetch all data needed for export */
export async function fetchSessionExportData(api: FuelApiClient, sessionId: string): Promise<SessionExportData> {
  const [session, transcript, events, git_activity] = await Promise.all([
    fetchSessionDetail(api, sessionId),
    fetchSessionTranscript(api, sessionId),
    fetchSessionEvents(api, sessionId),
    fetchSessionGit(api, sessionId),
  ]);
  return { session, transcript, events, git_activity, exported_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Presentation Layer — format functions
// ---------------------------------------------------------------------------

/**
 * Format a session summary card for terminal display.
 *
 * Shows session ID, workspace, device, status, timing, cost, model,
 * branch, summary text, stats, and tags.
 */
export function formatSessionSummary(session: SessionDetail): string {
  const lines: string[] = [];

  lines.push(pc.bold("Session Detail"));
  lines.push("=".repeat(60));
  lines.push("");
  lines.push(`  ${pc.bold("ID:")}          ${session.id}`);
  lines.push(`  ${pc.bold("Workspace:")}   ${session.workspace_name ?? session.workspace_id}${session.workspace_canonical_id ? pc.dim(` (${session.workspace_canonical_id})`) : ""}`);
  lines.push(`  ${pc.bold("Device:")}      ${session.device_name ?? session.device_id}${session.device_type ? pc.dim(` (${session.device_type})`) : ""}`);
  lines.push(`  ${pc.bold("Status:")}      ${formatLifecycle(session.lifecycle)}`);

  // Started — relative + absolute
  const relTime = formatRelativeTime(session.started_at);
  lines.push(`  ${pc.bold("Started:")}     ${relTime} (${session.started_at})`);

  // Duration
  lines.push(`  ${pc.bold("Duration:")}    ${formatDuration(session.duration_ms)}`);

  // Cost
  lines.push(`  ${pc.bold("Cost:")}        ${formatCost(session.cost_estimate_usd ?? null)}`);

  // Model
  if (session.model) {
    lines.push(`  ${pc.bold("Model:")}       ${session.model}`);
  }

  // Branch
  const branch = session.branch ?? session.git_branch;
  if (branch) {
    lines.push(`  ${pc.bold("Branch:")}      ${branch}`);
  }

  // Summary (word-wrapped)
  const summary = session.summary ?? session.initial_prompt;
  if (summary) {
    lines.push("");
    lines.push(`  ${pc.bold("Summary:")}`);
    // Simple word-wrap for summary
    const maxW = 56;
    const words = summary.split(/\s+/);
    let currentLine = "    ";
    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxW + 4) {
        lines.push(currentLine);
        currentLine = "    " + word;
      } else {
        currentLine += (currentLine.length > 4 ? " " : "") + word;
      }
    }
    if (currentLine.trim()) lines.push(currentLine);
  }

  // Stats
  const stats = session.stats;
  if (stats) {
    lines.push("");
    lines.push(`  ${pc.bold("Stats:")}`);
    if (stats.total_messages != null) lines.push(`    Messages:   ${stats.total_messages}`);
    if (stats.tool_use_count != null) lines.push(`    Tool uses:  ${stats.tool_use_count}`);
    lines.push(`    Tokens:     ${formatTokens(stats.tokens_in ?? null, stats.tokens_out ?? null, stats.tokens_cache ?? null)}`);
    if (stats.commit_count != null) lines.push(`    Commits:    ${stats.commit_count}`);
  }

  // Tags
  const tags = session.tags;
  if (tags && tags.length > 0) {
    lines.push("");
    lines.push(`  ${pc.bold("Tags:")}        ${tags.join(", ")}`);
  }

  lines.push("");
  lines.push(pc.dim("  Hint: use --transcript, --events, or --git for more detail"));

  return lines.join("\n");
}

/**
 * Format session events as a table.
 *
 * Columns: TIME | TYPE | DATA
 * Data column is type-specific (branch+model for session.start, hash+message for git.commit, etc.)
 */
export function formatSessionEvents(events: Event[]): string {
  if (events.length === 0) {
    return pc.dim("No events for this session.");
  }

  const rows = events.map((evt) => {
    const time = formatRelativeTime(evt.timestamp);
    const type = evt.type;
    const data = formatEventData(evt);
    return [time, type, data];
  });

  return renderTable({
    columns: [
      { header: "TIME", width: 16 },
      { header: "TYPE", width: 20 },
      { header: "DATA" },
    ],
    rows,
  });
}

/**
 * Format git activity as a table.
 *
 * Columns: HASH | MESSAGE | BRANCH | TIME | +/- | FILES
 * Non-commit activities (push, checkout, merge) are shown as separate lines below.
 */
export function formatSessionGitActivity(gitActivity: GitActivity[]): string {
  if (gitActivity.length === 0) {
    return pc.dim("No git activity during this session.");
  }

  const commits = gitActivity.filter((g) => g.type === "commit");
  const others = gitActivity.filter((g) => g.type !== "commit");

  const lines: string[] = [];

  if (commits.length > 0) {
    const rows = commits.map((g) => [
      g.commit_sha ? g.commit_sha.slice(0, 7) : "-",
      truncate(g.message ?? "-", 40),
      g.branch ?? "-",
      formatRelativeTime(g.timestamp),
      `+${g.insertions ?? 0} -${g.deletions ?? 0}`,
      String(g.files_changed ?? 0),
    ]);

    lines.push(
      renderTable({
        columns: [
          { header: "HASH", width: 7 },
          { header: "MESSAGE", width: 40 },
          { header: "BRANCH", width: 16 },
          { header: "TIME", width: 16 },
          { header: "+/-", width: 10 },
          { header: "FILES", width: 5, align: "right" },
        ],
        rows,
      }),
    );
  }

  // Non-commit activity lines
  for (const g of others) {
    switch (g.type) {
      case "push":
        lines.push(`  push: ${g.branch ?? "unknown"} -> ${(g.data?.remote as string) ?? "origin"}`);
        break;
      case "checkout":
        lines.push(`  checkout: ${(g.data?.from as string) ?? "?"} -> ${g.branch ?? "?"}`);
        break;
      case "merge":
        lines.push(`  merge: ${(g.data?.from as string) ?? "?"} into ${g.branch ?? "?"}`);
        break;
    }
  }

  return lines.join("\n");
}

/**
 * Generate a Markdown document for --export md.
 *
 * Includes: header, summary, stats, transcript (simplified), git activity.
 */
export function generateMarkdownExport(data: SessionExportData): string {
  const { session } = data;
  const lines: string[] = [];

  lines.push(`# Session ${session.id}`);
  lines.push("");
  lines.push(`- **Workspace:** ${session.workspace_name ?? session.workspace_id}`);
  lines.push(`- **Device:** ${session.device_name ?? session.device_id}`);
  lines.push(`- **Status:** ${session.lifecycle}`);
  lines.push(`- **Started:** ${session.started_at}`);
  lines.push(`- **Duration:** ${formatDuration(session.duration_ms)}`);
  lines.push(`- **Cost:** ${formatCost(session.cost_estimate_usd ?? null)}`);
  if (session.model) lines.push(`- **Model:** ${session.model}`);
  const branch = session.branch ?? session.git_branch;
  if (branch) lines.push(`- **Branch:** ${branch}`);

  const summary = session.summary ?? session.initial_prompt;
  if (summary) {
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push(summary);
  }

  // Stats
  const stats = session.stats;
  if (stats) {
    lines.push("");
    lines.push("## Stats");
    lines.push("");
    if (stats.total_messages != null) lines.push(`- Messages: ${stats.total_messages}`);
    if (stats.tool_use_count != null) lines.push(`- Tool uses: ${stats.tool_use_count}`);
    if (stats.commit_count != null) lines.push(`- Commits: ${stats.commit_count}`);
  }

  // Transcript
  if (data.transcript.length > 0) {
    lines.push("");
    lines.push("## Transcript");
    lines.push("");
    for (const msg of data.transcript) {
      const role = msg.role ?? msg.message_type ?? "unknown";
      lines.push(`**[${msg.ordinal}] ${role}:**`);
      lines.push("");
    }
  }

  // Git activity
  if (data.git_activity.length > 0) {
    lines.push("");
    lines.push("## Git Activity");
    lines.push("");
    lines.push("| Hash | Message | Branch | Time |");
    lines.push("|------|---------|--------|------|");
    for (const g of data.git_activity) {
      const sha = g.commit_sha ? g.commit_sha.slice(0, 7) : g.type;
      lines.push(`| ${sha} | ${g.message ?? g.type} | ${g.branch ?? "-"} | ${g.timestamp} |`);
    }
  }

  lines.push("");
  lines.push(`---`);
  lines.push(`*Exported at ${data.exported_at}*`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

/**
 * Create the `session` subcommand for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createSessionDetailCommand(): Command {
  const cmd = new Command("session")
    .description("Show session detail, transcript, events, or git activity")
    .argument("<id>", "Session ID (full ULID or 8+ char prefix)")
    .option("--transcript", "Show parsed transcript with tool use tree")
    .option("--events", "Show chronological event table")
    .option("--git", "Show git activity (commits, pushes, etc.)")
    .option("--export <format>", "Export session data (json or md)")
    .option("--tag <tag>", "Add a tag to the session")
    .option("--reparse", "Re-trigger transcript parsing")
    .option("--json", "Output summary as JSON")
    .action(async (idArg: string, opts: Record<string, unknown>) => {
      await runSessionDetail(idArg, opts);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Core Logic
// ---------------------------------------------------------------------------

/**
 * Main execution logic for the session detail command.
 * Resolves the session ID, then dispatches based on flag priority.
 */
export async function runSessionDetail(
  idArg: string,
  opts: Record<string, unknown>,
): Promise<void> {
  let api: FuelApiClient;
  try {
    api = FuelApiClient.fromConfig();
  } catch (err) {
    process.stdout.write(formatError(err) + "\n");
    process.exitCode = 1;
    return;
  }

  // Resolve session ID (supports prefix matching)
  let sessionId: string;
  try {
    sessionId = await resolveSessionId(api, idArg);
  } catch (err) {
    process.stdout.write(
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    process.exitCode = 1;
    return;
  }

  try {
    // Flag priority: --tag > --reparse > --export > --transcript > --events > --git > default

    if (opts.tag) {
      await handleTag(api, sessionId, opts.tag as string);
    } else if (opts.reparse) {
      await handleReparse(api, sessionId);
    } else if (opts.export) {
      await handleExport(api, sessionId, opts.export as string);
    } else if (opts.transcript) {
      await handleTranscript(api, sessionId);
    } else if (opts.events) {
      await handleEvents(api, sessionId);
    } else if (opts.git) {
      await handleGit(api, sessionId);
    } else {
      await handleDefault(api, sessionId, !!opts.json);
    }
  } catch (err) {
    process.stdout.write(formatError(err) + "\n");
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Flag Handlers
// ---------------------------------------------------------------------------

/** Default view: session summary card */
async function handleDefault(api: FuelApiClient, sessionId: string, json: boolean): Promise<void> {
  const session = await fetchSessionDetail(api, sessionId);
  outputResult(session, {
    json,
    format: formatSessionSummary,
  });
}

/** --transcript: show parsed transcript */
async function handleTranscript(api: FuelApiClient, sessionId: string): Promise<void> {
  const session = await fetchSessionDetail(api, sessionId);

  // Check lifecycle for transcript availability
  if (session.lifecycle === "detected" || session.lifecycle === "capturing") {
    process.stdout.write(
      `Transcript not yet available. Session is currently ${session.lifecycle}.\n`,
    );
    return;
  }

  if (session.lifecycle === "failed") {
    process.stdout.write(
      "Transcript parsing failed. Use --reparse to retry.\n",
    );
    return;
  }

  const messages = await fetchSessionTranscript(api, sessionId);
  if (messages.length === 0) {
    process.stdout.write("No transcript messages found.\n");
    return;
  }

  const output = renderTranscript(messages as TranscriptMessageWithBlocks[]);
  process.stdout.write(output + "\n");
}

/** --events: show chronological event table */
async function handleEvents(api: FuelApiClient, sessionId: string): Promise<void> {
  const events = await fetchSessionEvents(api, sessionId);
  process.stdout.write(formatSessionEvents(events) + "\n");
}

/** --git: show git activity */
async function handleGit(api: FuelApiClient, sessionId: string): Promise<void> {
  const gitActivity = await fetchSessionGit(api, sessionId);
  process.stdout.write(formatSessionGitActivity(gitActivity) + "\n");
}

/** --export: export session data to a file */
async function handleExport(api: FuelApiClient, sessionId: string, format: string): Promise<void> {
  if (format !== "json" && format !== "md") {
    process.stdout.write(`Invalid export format: "${format}". Use "json" or "md".\n`);
    process.exitCode = 1;
    return;
  }

  const data = await fetchSessionExportData(api, sessionId);
  const prefix = sessionId.slice(0, 8);
  const filename = `session-${prefix}.${format === "json" ? "json" : "md"}`;
  const filePath = path.resolve(filename);

  let content: string;
  if (format === "json") {
    content = JSON.stringify(data, null, 2);
  } else {
    content = generateMarkdownExport(data);
  }

  fs.writeFileSync(filePath, content, "utf-8");
  const size = Buffer.byteLength(content, "utf-8");
  process.stdout.write(`Exported to ${filePath} (${size} bytes)\n`);
}

/** --tag: add a tag to the session */
async function handleTag(api: FuelApiClient, sessionId: string, tag: string): Promise<void> {
  const session = await fetchSessionDetail(api, sessionId);
  const currentTags = session.tags ?? [];

  if (currentTags.includes(tag)) {
    process.stdout.write(`Tag "${tag}" already exists on this session.\n`);
    return;
  }

  const newTags = [...currentTags, tag];
  await api.updateSession(sessionId, { tags: newTags });
  process.stdout.write(`Tag "${tag}" added to session ${sessionId.slice(0, 8)}.\n`);
}

/** --reparse: re-trigger transcript parsing */
async function handleReparse(api: FuelApiClient, sessionId: string): Promise<void> {
  await api.reparseSession(sessionId);
  process.stdout.write(`Reparse triggered for session ${sessionId.slice(0, 8)}.\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format the DATA column for an event row based on event type.
 */
function formatEventData(evt: Event): string {
  const data = evt.data ?? {};
  switch (evt.type) {
    case "session.start":
      return [data.branch, data.model].filter(Boolean).join(" ") || "-";
    case "session.end":
      return [
        data.duration_ms ? formatDuration(data.duration_ms as number) : null,
        data.reason,
      ]
        .filter(Boolean)
        .join(" ") || "-";
    case "git.commit":
      return [
        data.commit_sha ? (data.commit_sha as string).slice(0, 7) : null,
        data.message ? truncate(data.message as string, 40) : null,
        data.files_changed ? `${data.files_changed} files` : null,
      ]
        .filter(Boolean)
        .join(" ") || "-";
    case "git.push":
      return [data.branch, data.remote].filter(Boolean).join(" -> ") || "-";
    default:
      return truncate(JSON.stringify(data), 50);
  }
}
