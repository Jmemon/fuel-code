/**
 * Transcript renderer for the fuel-code CLI.
 *
 * Renders parsed transcript messages into terminal-friendly text output.
 * Extracted as a reusable module so both CLI commands and TUI components
 * can render transcripts consistently.
 *
 * Rendering rules:
 *   - Each message shows: [ordinal] Role (HH:MM): with model+cost for assistants
 *   - Text content is word-wrapped to maxWidth-2 (indented 2 spaces)
 *   - Tool uses are shown as an indented tree with box-drawing characters
 *   - Tool results are NOT shown inline (too noisy)
 *   - Thinking blocks are collapsed by default: [thinking... N chars]
 *   - Truncation: "... N more messages" footer when exceeding maxMessages
 */

import pc from "picocolors";
import type { TranscriptMessage, ParsedContentBlock } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for controlling transcript rendering */
export interface TranscriptRenderOptions {
  /** Maximum terminal width for word wrapping (default: 100) */
  maxWidth?: number;
  /** Show full thinking block text instead of collapsed summary (default: false) */
  showThinking?: boolean;
  /** Maximum number of messages to render before truncation (default: 50) */
  maxMessages?: number;
  /** Enable color output via picocolors (default: true) */
  colorize?: boolean;
}

/** Internal defaults applied when options are not specified */
const DEFAULTS: Required<TranscriptRenderOptions> = {
  maxWidth: 100,
  showThinking: false,
  maxMessages: 50,
  colorize: true,
};

// ---------------------------------------------------------------------------
// Extended message type — messages with their content blocks joined
// ---------------------------------------------------------------------------

/**
 * A transcript message with its content blocks attached.
 * The API may return these as separate arrays or joined — we handle both.
 */
export interface TranscriptMessageWithBlocks extends TranscriptMessage {
  content_blocks?: ParsedContentBlock[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a full transcript as a terminal-friendly string.
 *
 * Respects maxMessages for truncation and word-wraps text content.
 * Messages are rendered in ordinal order.
 */
export function renderTranscript(
  messages: TranscriptMessageWithBlocks[],
  options?: TranscriptRenderOptions,
): string {
  const opts = { ...DEFAULTS, ...options };
  const sorted = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const visible = sorted.slice(0, opts.maxMessages);
  const lines: string[] = [];

  for (let i = 0; i < visible.length; i++) {
    lines.push(renderMessage(visible[i], visible[i].ordinal, opts));
    if (i < visible.length - 1) {
      lines.push(""); // blank line between messages
    }
  }

  // Truncation footer
  const remaining = sorted.length - visible.length;
  if (remaining > 0) {
    lines.push("");
    lines.push(
      opts.colorize
        ? pc.dim(`... ${remaining} more messages`)
        : `... ${remaining} more messages`,
    );
  }

  return lines.join("\n");
}

/**
 * Render a single transcript message as a terminal-friendly string.
 *
 * Format: [ordinal] Role (HH:MM):
 * For assistant messages, also shows model and cost.
 */
export function renderMessage(
  message: TranscriptMessageWithBlocks,
  index: number,
  options?: TranscriptRenderOptions,
): string {
  const opts = { ...DEFAULTS, ...options };
  const lines: string[] = [];

  // Header line: [N] Role (HH:MM):
  const role = message.role ?? message.message_type ?? "unknown";
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const time = message.timestamp ? formatMessageTime(message.timestamp) : "";
  let header = `[${index}] ${roleLabel}`;
  if (time) header += ` (${time})`;
  header += ":";

  // For assistant messages, append model and cost
  if (role === "assistant") {
    const extras: string[] = [];
    if (message.model) extras.push(message.model);
    if (message.cost_usd != null && message.cost_usd > 0) {
      extras.push(`$${message.cost_usd.toFixed(4)}`);
    }
    if (extras.length > 0) {
      header += ` ${opts.colorize ? pc.dim(extras.join(" ")) : extras.join(" ")}`;
    }
  }

  lines.push(opts.colorize ? pc.bold(header) : header);

  // Render content blocks if available
  const blocks = message.content_blocks ?? [];
  if (blocks.length > 0) {
    lines.push(renderContentBlocks(blocks, opts));
  }

  return lines.join("\n");
}

/**
 * Render tool uses from content blocks as an indented tree.
 *
 * Uses box-drawing characters for visual hierarchy.
 */
export function renderToolUseTree(
  contentBlocks: ParsedContentBlock[],
  options?: TranscriptRenderOptions,
): string {
  const opts = { ...DEFAULTS, ...options };
  const toolBlocks = contentBlocks.filter((b) => b.block_type === "tool_use");
  if (toolBlocks.length === 0) return "";

  const lines: string[] = [];
  for (let i = 0; i < toolBlocks.length; i++) {
    const isLast = i === toolBlocks.length - 1;
    const prefix = isLast ? "\u2514 " : "\u251C ";
    const summary = formatToolSummary(toolBlocks[i]);
    const line = `  ${prefix}${summary}`;
    lines.push(opts.colorize ? pc.cyan(line) : line);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Render all content blocks for a message — text, thinking, and tool uses.
 */
function renderContentBlocks(
  blocks: ParsedContentBlock[],
  opts: Required<TranscriptRenderOptions>,
): string {
  const lines: string[] = [];
  const toolBlocks = blocks.filter((b) => b.block_type === "tool_use");

  for (const block of blocks) {
    switch (block.block_type) {
      case "text": {
        if (block.content_text) {
          const wrapped = wordWrap(block.content_text, opts.maxWidth - 2);
          const indented = wrapped
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n");
          lines.push(indented);
        }
        break;
      }
      case "thinking": {
        const text = block.thinking_text ?? block.content_text ?? "";
        if (opts.showThinking && text) {
          const wrapped = wordWrap(text, opts.maxWidth - 2);
          const indented = wrapped
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n");
          lines.push(
            opts.colorize ? pc.dim(indented) : indented,
          );
        } else if (text) {
          const summary = `  [thinking... ${text.length} chars]`;
          lines.push(opts.colorize ? pc.dim(summary) : summary);
        }
        break;
      }
      // tool_use and tool_result are handled below / skipped
      case "tool_use":
      case "tool_result":
        break;
    }
  }

  // Render tool use tree if any tool blocks exist
  if (toolBlocks.length > 0) {
    lines.push(renderToolUseTree(blocks, opts));
  }

  return lines.join("\n");
}

/**
 * Generate a one-line summary for a tool use block.
 *
 * Tool-specific formatting:
 *   - Read: filepath
 *   - Edit: filepath (+N -M)
 *   - Write: filepath
 *   - Bash: command (truncated to 60 chars) (exit N)
 *   - Grep/Glob: pattern
 *   - Unknown: tool_name
 */
export function formatToolSummary(block: ParsedContentBlock): string {
  const name = block.tool_name ?? "unknown";
  const input = (block.tool_input ?? {}) as Record<string, unknown>;

  switch (name.toLowerCase()) {
    case "read": {
      const filePath = (input.file_path ?? input.path ?? "") as string;
      return `Read ${filePath || "(unknown file)"}`;
    }
    case "edit": {
      const filePath = (input.file_path ?? input.path ?? "") as string;
      // Edit operations may have old_string and new_string; approximate +/- from lengths
      const oldStr = (input.old_string ?? "") as string;
      const newStr = (input.new_string ?? "") as string;
      const added = newStr.split("\n").length;
      const removed = oldStr.split("\n").length;
      return `Edit ${filePath || "(unknown file)"} (+${added} -${removed})`;
    }
    case "write": {
      const filePath = (input.file_path ?? input.path ?? "") as string;
      return `Write ${filePath || "(unknown file)"}`;
    }
    case "bash": {
      const command = (input.command ?? "") as string;
      const truncated = command.length > 60 ? command.slice(0, 57) + "..." : command;
      return `Bash ${truncated}`;
    }
    case "grep": {
      const pattern = (input.pattern ?? "") as string;
      return `Grep ${pattern || "(no pattern)"}`;
    }
    case "glob": {
      const pattern = (input.pattern ?? "") as string;
      return `Glob ${pattern || "(no pattern)"}`;
    }
    default:
      return name;
  }
}

/**
 * Format a timestamp to HH:MM for display in message headers.
 */
function formatMessageTime(iso: string): string {
  try {
    const d = new Date(iso);
    const h = d.getHours();
    const m = d.getMinutes();
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

/**
 * Word-wrap text to the specified width.
 * Splits on word boundaries and respects existing newlines.
 */
function wordWrap(text: string, width: number): string {
  if (width <= 0) return text;

  const paragraphs = text.split("\n");
  const result: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= width) {
      result.push(paragraph);
      continue;
    }

    const words = paragraph.split(/\s+/);
    let currentLine = "";

    for (const word of words) {
      if (!currentLine) {
        currentLine = word;
      } else if (currentLine.length + 1 + word.length <= width) {
        currentLine += " " + word;
      } else {
        result.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) {
      result.push(currentLine);
    }
  }

  return result.join("\n");
}
