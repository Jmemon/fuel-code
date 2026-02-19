/**
 * LLM-powered session summary generator.
 *
 * Takes parsed transcript messages and content blocks, renders a condensed
 * markdown representation, calls Claude Sonnet via the Anthropic API, and
 * returns a 1-3 sentence past-tense summary of what was accomplished.
 *
 * This is a pure function — no database access, no side effects beyond the
 * API call. Error handling is total: the function never throws, always
 * returning a SummaryResult with success/failure info.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { TranscriptMessage, ParsedContentBlock } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the summary generator */
export interface SummaryConfig {
  /** Whether summary generation is enabled */
  enabled: boolean;
  /** Claude model ID to use (default: "claude-sonnet-4-5-20250929") */
  model: string;
  /** Generation temperature, 0-1 (default: 0.3 for deterministic output) */
  temperature: number;
  /** Maximum tokens in the summary response (default: 150) */
  maxOutputTokens: number;
  /** Anthropic API key — required for generation */
  apiKey: string;
}

/** Result of a summary generation attempt — never throws */
export interface SummaryResult {
  success: boolean;
  /** The generated summary text, or undefined if disabled/empty */
  summary?: string;
  /** Error message if generation failed */
  error?: string;
  /** Seconds to wait before retrying (set on 429 rate limit) */
  retryAfterSeconds?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** System prompt instructing the model to produce a concise activity summary */
const SUMMARY_SYSTEM_PROMPT = `You are a technical activity summarizer. Write a 1-3 sentence summary of this Claude Code session in past tense. Focus on WHAT was accomplished, not HOW. Be specific about files, features, or bugs. Do not start with "The user" or "This session". Example: "Refactored the authentication middleware to use JWT tokens and added comprehensive test coverage for the login flow."`;

/** Maximum character length for the rendered prompt before truncation */
const MAX_PROMPT_LENGTH = 8000;

/** Characters to keep from the start when truncating */
const TRUNCATE_HEAD = 3000;

/** Characters to keep from the end when truncating */
const TRUNCATE_TAIL = 3000;

/** Max characters per user message in the rendered prompt */
const USER_MESSAGE_CHAR_LIMIT = 500;

/** Max characters per assistant text block in the rendered prompt */
const ASSISTANT_TEXT_CHAR_LIMIT = 300;

/** API call timeout in milliseconds */
const API_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render transcript messages and content blocks into a condensed markdown
 * string suitable for prompting the summary model.
 *
 * Rules:
 *   - User messages: "[User]: {text}" (first 500 chars)
 *   - Assistant text blocks: "[Assistant]: {text}" (first 300 chars)
 *   - Tool use blocks: "- Used {tool_name}" (name only, no input/output)
 *   - Thinking blocks: skipped entirely
 *   - Tool result blocks: skipped entirely
 *   - If total exceeds 8000 chars: keep first 3000 + last 3000 with truncation marker
 *
 * @param messages - Parsed transcript messages
 * @param contentBlocks - Parsed content blocks associated with the messages
 * @returns A markdown-formatted string for prompting
 */
export function renderTranscriptForSummary(
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[]
): string {
  // Build a lookup: message_id -> content blocks (ordered by block_order)
  const blocksByMessage = new Map<string, ParsedContentBlock[]>();
  for (const block of contentBlocks) {
    const existing = blocksByMessage.get(block.message_id) ?? [];
    existing.push(block);
    blocksByMessage.set(block.message_id, existing);
  }
  // Sort each message's blocks by block_order
  for (const blocks of blocksByMessage.values()) {
    blocks.sort((a, b) => a.block_order - b.block_order);
  }

  // Compute header stats
  const totalMessages = messages.length;
  const toolUseCount = contentBlocks.filter((b) => b.block_type === "tool_use").length;
  const models = new Set(messages.map((m) => m.model).filter(Boolean));
  const modelStr = models.size > 0 ? [...models].join(", ") : "unknown";

  // Compute duration from first/last message timestamps
  const timestamps = messages
    .map((m) => m.timestamp)
    .filter(Boolean)
    .map((t) => new Date(t!).getTime())
    .filter((t) => !isNaN(t));
  let durationStr = "unknown";
  if (timestamps.length >= 2) {
    const durationMs = Math.max(...timestamps) - Math.min(...timestamps);
    const minutes = Math.round(durationMs / 60_000);
    durationStr = minutes > 0 ? `${minutes}m` : "<1m";
  }

  // Render header
  const lines: string[] = [
    `# Session Transcript`,
    `Model: ${modelStr} | Messages: ${totalMessages} | Tool uses: ${toolUseCount} | Duration: ${durationStr}`,
    ``,
  ];

  // Render each message's relevant content
  for (const msg of messages) {
    const blocks = blocksByMessage.get(msg.id) ?? [];

    if (msg.role === "user") {
      // For user messages, gather text from content blocks or raw_message
      const textBlocks = blocks.filter((b) => b.block_type === "text" && b.content_text);
      if (textBlocks.length > 0) {
        for (const tb of textBlocks) {
          const text = truncateText(tb.content_text!, USER_MESSAGE_CHAR_LIMIT);
          lines.push(`[User]: ${text}`);
        }
      } else if (msg.has_text) {
        // Fallback: message has text but no parsed blocks — use a placeholder
        lines.push(`[User]: (message content)`);
      }
    } else if (msg.role === "assistant") {
      // For assistant messages, render text blocks and tool use separately
      for (const block of blocks) {
        if (block.block_type === "text" && block.content_text) {
          const text = truncateText(block.content_text, ASSISTANT_TEXT_CHAR_LIMIT);
          lines.push(`[Assistant]: ${text}`);
        } else if (block.block_type === "tool_use" && block.tool_name) {
          lines.push(`- Used ${block.tool_name}`);
        }
        // Skip thinking blocks and tool_result blocks
      }
    }
    // Skip system/summary/progress/other message types
  }

  let rendered = lines.join("\n");

  // Truncate the middle if the rendered prompt exceeds the limit
  if (rendered.length > MAX_PROMPT_LENGTH) {
    const head = rendered.slice(0, TRUNCATE_HEAD);
    const tail = rendered.slice(-TRUNCATE_TAIL);
    // Estimate how many messages were truncated (rough: count newlines in removed section)
    const removedSection = rendered.slice(TRUNCATE_HEAD, rendered.length - TRUNCATE_TAIL);
    const removedLineCount = removedSection.split("\n").length;
    rendered = `${head}\n\n... [truncated ${removedLineCount} messages] ...\n\n${tail}`;
  }

  return rendered;
}

// ---------------------------------------------------------------------------
// Initial prompt extraction (used by Task 11 backfill)
// ---------------------------------------------------------------------------

/**
 * Extract the text of the first user message from a parsed transcript.
 *
 * Returns the first 1000 characters of the first user message text,
 * truncated with "..." if longer. Returns null if no user messages exist.
 *
 * @param messages - Parsed transcript messages
 * @param contentBlocks - Parsed content blocks
 * @returns The initial prompt text or null
 */
export function extractInitialPrompt(
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[]
): string | null {
  // Find the first user message by ordinal order
  const userMessages = messages
    .filter((m) => m.role === "user")
    .sort((a, b) => a.ordinal - b.ordinal);

  if (userMessages.length === 0) {
    return null;
  }

  const firstUserMsg = userMessages[0];

  // Look for text content blocks belonging to this message
  const textBlocks = contentBlocks
    .filter((b) => b.message_id === firstUserMsg.id && b.block_type === "text" && b.content_text)
    .sort((a, b) => a.block_order - b.block_order);

  if (textBlocks.length > 0) {
    const fullText = textBlocks.map((b) => b.content_text!).join("\n");
    return truncateText(fullText, 1000);
  }

  // No text blocks found for this user message
  return null;
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a 1-3 sentence summary of a parsed Claude Code session.
 *
 * Renders the transcript into a condensed markdown prompt, calls Claude Sonnet
 * via the Anthropic API, and returns the summary text. Never throws — all
 * errors are captured in the SummaryResult.
 *
 * Early returns:
 *   - config.enabled === false -> { success: true, summary: undefined }
 *   - empty messages array -> { success: true, summary: "Empty session." }
 *   - missing API key -> { success: false, error: "ANTHROPIC_API_KEY not configured" }
 *
 * @param messages - Parsed transcript messages
 * @param contentBlocks - Parsed content blocks
 * @param config - Summary generation configuration
 * @returns SummaryResult with the generated summary or error details
 */
export async function generateSummary(
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[],
  config: SummaryConfig
): Promise<SummaryResult> {
  // Guard: disabled
  if (!config.enabled) {
    return { success: true, summary: undefined };
  }

  // Guard: no messages
  if (messages.length === 0) {
    return { success: true, summary: "Empty session." };
  }

  // Guard: missing API key
  if (!config.apiKey) {
    return { success: false, error: "ANTHROPIC_API_KEY not configured" };
  }

  // Render the transcript into a condensed prompt
  const renderedPrompt = renderTranscriptForSummary(messages, contentBlocks);

  try {
    // Create Anthropic client and call the API with a timeout
    const anthropic = new Anthropic({ apiKey: config.apiKey });
    const response = await anthropic.messages.create(
      {
        model: config.model,
        max_tokens: config.maxOutputTokens,
        temperature: config.temperature,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: renderedPrompt }],
      },
      { signal: AbortSignal.timeout(API_TIMEOUT_MS) }
    );

    // Extract text from the response content blocks
    const summaryText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    return { success: true, summary: summaryText || undefined };
  } catch (error: unknown) {
    return handleApiError(error);
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Convert an API error into a SummaryResult. Handles Anthropic SDK errors,
 * abort/timeout errors, and generic errors.
 */
function handleApiError(error: unknown): SummaryResult {
  // Handle AbortError from AbortSignal.timeout
  if (error instanceof DOMException && error.name === "AbortError") {
    return { success: false, error: "Summary generation timed out (30s)" };
  }

  // Handle timeout error (could also be a TimeoutError in some environments)
  if (error instanceof Error && error.name === "TimeoutError") {
    return { success: false, error: "Summary generation timed out (30s)" };
  }

  // Handle Anthropic API errors (they have a status property)
  if (error instanceof Anthropic.APIError) {
    const status = error.status;

    if (status === 429) {
      // Rate limited — try to extract retry-after from headers or error
      const retryAfter = extractRetryAfter(error);
      return {
        success: false,
        error: "Rate limited",
        retryAfterSeconds: retryAfter,
      };
    }

    if (status === 401) {
      return { success: false, error: "Invalid Anthropic API key" };
    }

    if (status >= 500) {
      return { success: false, error: `Anthropic API error: ${status}` };
    }

    // Other HTTP errors (400, 403, etc.)
    return { success: false, error: `Anthropic API error: ${status}` };
  }

  // Generic/unknown error
  const message = error instanceof Error ? error.message : String(error);
  return { success: false, error: `Summary generation failed: ${message}` };
}

/**
 * Attempt to extract a retry-after value (in seconds) from an Anthropic
 * rate limit error. Returns undefined if not available.
 */
function extractRetryAfter(error: Anthropic.APIError): number | undefined {
  // The Anthropic SDK exposes headers on the error object
  const headers = error.headers;
  if (headers) {
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}
