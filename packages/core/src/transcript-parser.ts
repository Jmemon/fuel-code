/**
 * JSONL transcript parser for Claude Code transcripts.
 *
 * Pure function: takes a raw JSONL string (or ReadableStream) and produces
 * structured TranscriptMessage[] and ParsedContentBlock[] arrays ready for
 * Postgres insertion. No I/O, no DB, no S3 — just data transformation.
 *
 * Parsing pipeline:
 *   1. Split input into lines, filter empties
 *   2. JSON-parse each line, classify by `type` field
 *   3. Group assistant lines by `message.id` (CC streams multi-line responses)
 *   4. Build TranscriptMessage + ParsedContentBlock rows in JSONL order
 *   5. Compute per-message cost, aggregate stats, extract metadata
 */

import type {
  TranscriptMessage,
  ParsedContentBlock,
  ParseResult,
  TranscriptStats,
  RawTranscriptLine,
  ContentBlockType,
  RawContentBlock,
} from "@fuel-code/shared";
import { generateId } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max size for inline tool result content (256 KB) */
const DEFAULT_MAX_INLINE_BYTES = 262_144;

/** Maximum allowed size for a single JSONL line (5 MB) */
const MAX_LINE_BYTES = 5 * 1024 * 1024;

/** Claude pricing per million tokens (USD) */
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_OUTPUT_PER_MTOK = 15.0;
const PRICE_CACHE_READ_PER_MTOK = 0.3;
const PRICE_CACHE_WRITE_PER_MTOK = 3.75;

/** Max length (chars) of the initial_prompt captured in stats */
const MAX_INITIAL_PROMPT_CHARS = 1000;

/** JSONL line types we skip — internal CC bookkeeping, not conversation */
const SKIP_TYPES = new Set(["progress", "file-history-snapshot", "queue-operation"]);

/** JSONL line types we process into messages */
const PROCESS_TYPES = new Set(["user", "assistant", "system", "summary"]);

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** Max bytes for inline tool result text. Larger results are truncated. Default 256 KB. */
  maxInlineContentBytes?: number;
  /** Called when a JSONL line cannot be parsed. Errors also appear in result.errors. */
  onLineError?: (lineNumber: number, error: string) => void;
  /** AbortSignal to cancel parsing mid-stream. Partial results are returned. */
  signal?: AbortSignal;
}

/**
 * Parse a Claude Code JSONL transcript into structured data.
 *
 * @param sessionId - The session this transcript belongs to (used as FK on rows)
 * @param input     - Raw JSONL text or a ReadableStream of bytes
 * @param options   - Optional parsing configuration
 * @returns ParseResult with messages, contentBlocks, stats, errors, and metadata
 */
export async function parseTranscript(
  sessionId: string,
  input: string | ReadableStream,
  options?: ParseOptions,
): Promise<ParseResult> {
  const maxInline = options?.maxInlineContentBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const onLineError = options?.onLineError;
  const signal = options?.signal;

  // Collect raw lines from string or stream
  const rawLines = typeof input === "string"
    ? splitStringLines(input)
    : await readStreamLines(input, signal);

  // Accumulators
  const errors: ParseResult["errors"] = [];
  const messages: TranscriptMessage[] = [];
  const contentBlocks: ParsedContentBlock[] = [];

  // Metadata extracted from first relevant line
  let metaSessionId: string | null = null;
  let metaCwd: string | null = null;
  let metaVersion: string | null = null;
  let metaGitBranch: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  // ---------------------------------------------------------------------------
  // Pass 1: Parse JSON, classify, group assistant lines by message.id
  // ---------------------------------------------------------------------------

  /** Parsed line with its 1-based line number */
  interface ClassifiedLine {
    lineNumber: number;
    parsed: RawTranscriptLine;
  }

  const classifiedLines: ClassifiedLine[] = [];

  /**
   * For assistant messages, multiple JSONL lines may share the same message.id
   * (Claude Code streams content blocks as separate lines). We group them and
   * emit a single TranscriptMessage per group.
   *
   * Key: message.id, Value: indices into classifiedLines that belong to that group.
   */
  const assistantGroups = new Map<string, number[]>();

  /** Track which assistant message.ids we've already emitted (for ordering) */
  const emittedAssistantIds = new Set<string>();

  for (let i = 0; i < rawLines.length; i++) {
    // Check for abort between lines
    if (signal?.aborted) break;

    const lineNumber = i + 1; // 1-based for human-readable error messages
    const rawLine = rawLines[i];

    // Skip empty lines
    if (rawLine.trim().length === 0) continue;

    // Check line size limit (5 MB)
    if (new TextEncoder().encode(rawLine).byteLength > MAX_LINE_BYTES) {
      const err = "Line exceeds max size";
      errors.push({ lineNumber, error: err });
      onLineError?.(lineNumber, err);
      continue;
    }

    // Attempt JSON parse
    let parsed: RawTranscriptLine;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      const err = "Invalid JSON";
      errors.push({ lineNumber, error: err });
      onLineError?.(lineNumber, err);
      continue;
    }

    // Classify by type
    const lineType = parsed.type;

    if (!lineType) {
      const err = "Missing type field";
      errors.push({ lineNumber, error: err });
      onLineError?.(lineNumber, err);
      continue;
    }

    // Skip non-conversation types
    if (SKIP_TYPES.has(lineType)) continue;

    // Unknown type that is neither processable nor skippable
    if (!PROCESS_TYPES.has(lineType)) {
      const err = `Unknown line type: ${lineType}`;
      errors.push({ lineNumber, error: err });
      onLineError?.(lineNumber, err);
      continue;
    }

    // Track timestamps
    if (parsed.timestamp) {
      if (!firstTimestamp) firstTimestamp = parsed.timestamp;
      lastTimestamp = parsed.timestamp;
    }

    // Extract metadata from first relevant line that has it
    if (!metaSessionId && parsed.sessionId) metaSessionId = parsed.sessionId;
    if (!metaCwd && parsed.cwd) metaCwd = parsed.cwd;
    if (!metaVersion && parsed.version) metaVersion = parsed.version;
    if (!metaGitBranch && parsed.gitBranch) metaGitBranch = parsed.gitBranch;

    const idx = classifiedLines.length;
    classifiedLines.push({ lineNumber, parsed });

    // Group assistant lines by message.id for multi-line streaming responses
    if (lineType === "assistant" && parsed.message?.id) {
      const msgId = parsed.message.id;
      if (!assistantGroups.has(msgId)) {
        assistantGroups.set(msgId, []);
      }
      assistantGroups.get(msgId)!.push(idx);
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 2: Build messages and content blocks in JSONL order
  // ---------------------------------------------------------------------------

  let ordinal = 0;

  for (let i = 0; i < classifiedLines.length; i++) {
    if (signal?.aborted) break;

    const { lineNumber, parsed } = classifiedLines[i];
    const lineType = parsed.type;

    if (lineType === "assistant") {
      const msgId = parsed.message?.id;

      // If this assistant line has a message.id we've already emitted, skip
      // (was already processed as part of its group)
      if (msgId && emittedAssistantIds.has(msgId)) continue;

      // Mark this message.id as emitted
      if (msgId) emittedAssistantIds.add(msgId);

      // Gather all lines in this group (or just this one if no message.id)
      const groupIndices = msgId ? assistantGroups.get(msgId) ?? [i] : [i];
      const groupLines = groupIndices.map((idx) => classifiedLines[idx]);

      buildAssistantMessage(
        sessionId,
        groupLines,
        ordinal,
        maxInline,
        messages,
        contentBlocks,
      );
      ordinal++;
    } else {
      // user, system, summary — one message per line
      buildStandaloneMessage(
        sessionId,
        lineNumber,
        parsed,
        ordinal,
        maxInline,
        messages,
        contentBlocks,
      );
      ordinal++;
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 3: Compute stats
  // ---------------------------------------------------------------------------

  const stats = computeStats(messages, contentBlocks, firstTimestamp, lastTimestamp);

  return {
    messages,
    contentBlocks,
    stats,
    errors,
    metadata: {
      sessionId: metaSessionId,
      cwd: metaCwd,
      version: metaVersion,
      gitBranch: metaGitBranch,
      firstTimestamp,
      lastTimestamp,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: line splitting
// ---------------------------------------------------------------------------

/** Split a string into lines on newline boundaries, preserving line content. */
function splitStringLines(input: string): string[] {
  return input.split("\n");
}

/**
 * Read lines from a ReadableStream of bytes. Handles partial lines
 * that span chunk boundaries by buffering leftover bytes.
 */
async function readStreamLines(
  stream: ReadableStream,
  signal?: AbortSignal,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      // Decode chunk (could be Uint8Array or string)
      buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });

      // Split on newlines, keeping the last partial line in the buffer
      const parts = buffer.split("\n");
      buffer = parts.pop()!; // last element is either empty or a partial line
      lines.push(...parts);
    }

    // Flush any remaining buffer content as the final line
    if (buffer.length > 0) {
      lines.push(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Internal: message builders
// ---------------------------------------------------------------------------

/**
 * Build a single TranscriptMessage from a group of assistant JSONL lines
 * that share the same message.id. Content blocks are merged from all lines.
 * Token usage comes from the LAST line (most complete data).
 */
function buildAssistantMessage(
  sessionId: string,
  groupLines: Array<{ lineNumber: number; parsed: RawTranscriptLine }>,
  ordinal: number,
  maxInline: number,
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[],
): void {
  const messageId = generateId();
  const firstLine = groupLines[0];
  const lastLine = groupLines[groupLines.length - 1];

  // Merge content blocks from all lines in the group
  const allBlocks: ParsedContentBlock[] = [];
  let hasText = false;
  let hasThinking = false;
  let hasToolUse = false;
  let hasToolResult = false;
  let blockOrder = 0;

  for (const { parsed } of groupLines) {
    const content = parsed.message?.content;

    if (content == null) continue;

    // Handle string content (assistant message with plain text instead of array)
    if (typeof content === "string") {
      const block = makeTextBlock(messageId, sessionId, blockOrder, content);
      allBlocks.push(block);
      hasText = true;
      blockOrder++;
      continue;
    }

    // Array of content blocks (normal assistant response)
    if (Array.isArray(content)) {
      for (const rawBlock of content as RawContentBlock[]) {
        const block = convertContentBlock(
          rawBlock,
          messageId,
          sessionId,
          blockOrder,
          maxInline,
        );
        if (!block) continue;

        allBlocks.push(block);

        if (block.block_type === "text") hasText = true;
        if (block.block_type === "thinking") hasThinking = true;
        if (block.block_type === "tool_use") hasToolUse = true;
        if (block.block_type === "tool_result") hasToolResult = true;

        blockOrder++;
      }
    }
  }

  // Token usage from the LAST line (most complete data in streaming)
  const usage = lastLine.parsed.message?.usage;
  const tokensIn = usage?.input_tokens ?? null;
  const tokensOut = usage?.output_tokens ?? null;
  const cacheRead = usage?.cache_read_input_tokens ?? null;
  const cacheWrite = usage?.cache_creation_input_tokens ?? null;
  const costUsd = computeCost(tokensIn, tokensOut, cacheRead, cacheWrite);

  const msg: TranscriptMessage = {
    id: messageId,
    session_id: sessionId,
    line_number: firstLine.lineNumber,
    ordinal,
    message_type: "assistant",
    role: lastLine.parsed.message?.role ?? "assistant",
    model: lastLine.parsed.message?.model ?? null,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    cost_usd: costUsd,
    compact_sequence: 0,
    is_compacted: false,
    timestamp: firstLine.parsed.timestamp ?? null,
    raw_message: lastLine.parsed.message ?? null,
    metadata: {},
    has_text: hasText,
    has_thinking: hasThinking,
    has_tool_use: hasToolUse,
    has_tool_result: hasToolResult,
  };

  messages.push(msg);
  contentBlocks.push(...allBlocks);
}

/**
 * Build a TranscriptMessage for a standalone line (user, system, summary).
 * User lines can have string content (text) or array content (tool_result).
 */
function buildStandaloneMessage(
  sessionId: string,
  lineNumber: number,
  parsed: RawTranscriptLine,
  ordinal: number,
  maxInline: number,
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[],
): void {
  const messageId = generateId();
  const lineType = parsed.type;

  // Determine the message_type: "summary" for summary lines, otherwise use line type
  const messageType = lineType === "summary" ? "summary" : lineType;
  const role = parsed.message?.role ?? lineType;

  const allBlocks: ParsedContentBlock[] = [];
  let hasText = false;
  let hasThinking = false;
  let hasToolUse = false;
  let hasToolResult = false;
  let blockOrder = 0;

  const content = parsed.message?.content;

  if (content != null) {
    if (typeof content === "string") {
      // Simple text message (most user messages)
      const block = makeTextBlock(messageId, sessionId, blockOrder, content);
      allBlocks.push(block);
      hasText = true;
      blockOrder++;
    } else if (Array.isArray(content)) {
      // Array content: tool_result blocks from user, or mixed blocks
      for (const rawBlock of content as RawContentBlock[]) {
        const block = convertContentBlock(rawBlock, messageId, sessionId, blockOrder, maxInline);
        if (!block) continue;

        allBlocks.push(block);

        if (block.block_type === "text") hasText = true;
        if (block.block_type === "thinking") hasThinking = true;
        if (block.block_type === "tool_use") hasToolUse = true;
        if (block.block_type === "tool_result") hasToolResult = true;

        blockOrder++;
      }
    }
  }

  const msg: TranscriptMessage = {
    id: messageId,
    session_id: sessionId,
    line_number: lineNumber,
    ordinal,
    message_type: messageType,
    role,
    model: parsed.message?.model ?? null,
    tokens_in: null,
    tokens_out: null,
    cache_read: null,
    cache_write: null,
    cost_usd: null,
    compact_sequence: 0,
    is_compacted: false,
    timestamp: parsed.timestamp ?? null,
    raw_message: parsed.message ?? null,
    metadata: {},
    has_text: hasText,
    has_thinking: hasThinking,
    has_tool_use: hasToolUse,
    has_tool_result: hasToolResult,
  };

  messages.push(msg);
  contentBlocks.push(...allBlocks);
}

// ---------------------------------------------------------------------------
// Internal: content block conversion
// ---------------------------------------------------------------------------

/**
 * Convert a raw content block from the JSONL into a ParsedContentBlock.
 * Returns null for unrecognized block types (ignores them silently).
 */
function convertContentBlock(
  raw: RawContentBlock,
  messageId: string,
  sessionId: string,
  blockOrder: number,
  maxInline: number,
): ParsedContentBlock | null {
  switch (raw.type) {
    case "text":
      return makeTextBlock(messageId, sessionId, blockOrder, raw.text ?? "");

    case "thinking":
      return {
        id: generateId(),
        message_id: messageId,
        session_id: sessionId,
        block_order: blockOrder,
        block_type: "thinking",
        content_text: null,
        thinking_text: raw.thinking ?? "",
        tool_name: null,
        tool_use_id: null,
        tool_input: null,
        tool_result_id: null,
        is_error: false,
        result_text: null,
        result_s3_key: null,
        metadata: {},
      };

    case "tool_use":
      return {
        id: generateId(),
        message_id: messageId,
        session_id: sessionId,
        block_order: blockOrder,
        block_type: "tool_use",
        content_text: null,
        thinking_text: null,
        tool_name: raw.name ?? null,
        tool_use_id: raw.id ?? null,
        tool_input: raw.input ?? null,
        tool_result_id: null,
        is_error: false,
        result_text: null,
        result_s3_key: null,
        metadata: {},
      };

    case "tool_result":
      return makeToolResultBlock(raw, messageId, sessionId, blockOrder, maxInline);

    default:
      // Unknown block type — skip silently
      return null;
  }
}

/** Create a text content block */
function makeTextBlock(
  messageId: string,
  sessionId: string,
  blockOrder: number,
  text: string,
): ParsedContentBlock {
  return {
    id: generateId(),
    message_id: messageId,
    session_id: sessionId,
    block_order: blockOrder,
    block_type: "text",
    content_text: text,
    thinking_text: null,
    tool_name: null,
    tool_use_id: null,
    tool_input: null,
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
  };
}

/**
 * Create a tool_result content block. If the result text exceeds the
 * inline size limit, truncate it and note the truncation in metadata.
 */
function makeToolResultBlock(
  raw: RawContentBlock,
  messageId: string,
  sessionId: string,
  blockOrder: number,
  maxInline: number,
): ParsedContentBlock {
  // tool_result content can be a string or a nested structure
  let resultText: string | null = null;
  if (typeof raw.content === "string") {
    resultText = raw.content;
  } else if (raw.content != null) {
    resultText = JSON.stringify(raw.content);
  }

  const metadata: Record<string, unknown> = {};

  // Truncate if exceeds max inline bytes
  if (resultText != null) {
    const byteLength = new TextEncoder().encode(resultText).byteLength;
    if (byteLength > maxInline) {
      // Truncate to approximately maxInline bytes (safe substring approach)
      resultText = truncateToBytes(resultText, maxInline);
      metadata.truncated = true;
      metadata.original_byte_length = byteLength;
    }
  }

  return {
    id: generateId(),
    message_id: messageId,
    session_id: sessionId,
    block_order: blockOrder,
    block_type: "tool_result",
    content_text: null,
    thinking_text: null,
    tool_name: null,
    tool_use_id: null,
    tool_input: null,
    tool_result_id: raw.tool_use_id ?? null,
    is_error: raw.is_error ?? false,
    result_text: resultText,
    result_s3_key: null,
    metadata,
  };
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes.
 * Avoids splitting multi-byte characters by encoding and re-decoding.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return text;

  // Slice the encoded bytes and decode back to string (lossy for partial chars)
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(encoded.slice(0, maxBytes));
}

// ---------------------------------------------------------------------------
// Internal: cost computation
// ---------------------------------------------------------------------------

/**
 * Compute approximate USD cost for a single message based on token counts.
 * Returns null if no usage data is available.
 */
function computeCost(
  tokensIn: number | null,
  tokensOut: number | null,
  cacheRead: number | null,
  cacheWrite: number | null,
): number | null {
  // If all token counts are null, no cost to compute
  if (tokensIn == null && tokensOut == null && cacheRead == null && cacheWrite == null) {
    return null;
  }

  const cost =
    ((tokensIn ?? 0) * PRICE_INPUT_PER_MTOK +
      (tokensOut ?? 0) * PRICE_OUTPUT_PER_MTOK +
      (cacheRead ?? 0) * PRICE_CACHE_READ_PER_MTOK +
      (cacheWrite ?? 0) * PRICE_CACHE_WRITE_PER_MTOK) /
    1_000_000;

  return cost;
}

// ---------------------------------------------------------------------------
// Internal: stats computation
// ---------------------------------------------------------------------------

/**
 * Compute aggregate statistics from parsed messages and content blocks.
 */
function computeStats(
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[],
  firstTimestamp: string | null,
  lastTimestamp: string | null,
): TranscriptStats {
  let userMessages = 0;
  let assistantMessages = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let initialPrompt: string | null = null;

  for (const msg of messages) {
    if (msg.message_type === "user") {
      userMessages++;
      // Capture initial prompt from the first user message
      if (initialPrompt == null) {
        initialPrompt = extractInitialPrompt(msg, contentBlocks);
      }
    } else if (msg.message_type === "assistant") {
      assistantMessages++;
    }

    totalTokensIn += msg.tokens_in ?? 0;
    totalTokensOut += msg.tokens_out ?? 0;
    totalCacheRead += msg.cache_read ?? 0;
    totalCacheWrite += msg.cache_write ?? 0;
    totalCost += msg.cost_usd ?? 0;
  }

  // Count specific block types
  let toolUseCount = 0;
  let thinkingBlocks = 0;
  let subagentCount = 0;

  for (const block of contentBlocks) {
    if (block.block_type === "tool_use") {
      toolUseCount++;
      // "Task" is Claude Code's subagent tool name
      if (block.tool_name === "Task") {
        subagentCount++;
      }
    }
    if (block.block_type === "thinking") {
      thinkingBlocks++;
    }
  }

  // Compute duration from first to last timestamp
  let durationMs = 0;
  if (firstTimestamp && lastTimestamp) {
    const first = new Date(firstTimestamp).getTime();
    const last = new Date(lastTimestamp).getTime();
    if (!isNaN(first) && !isNaN(last)) {
      durationMs = Math.max(0, last - first);
    }
  }

  return {
    total_messages: messages.length,
    user_messages: userMessages,
    assistant_messages: assistantMessages,
    tool_use_count: toolUseCount,
    thinking_blocks: thinkingBlocks,
    subagent_count: subagentCount,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cache_read_tokens: totalCacheRead,
    cache_write_tokens: totalCacheWrite,
    cost_estimate_usd: totalCost,
    duration_ms: durationMs,
    initial_prompt: initialPrompt,
  };
}

/**
 * Extract the initial prompt text from the first user message.
 * Looks at the message's content blocks for the first text block.
 * Truncates to MAX_INITIAL_PROMPT_CHARS with "..." suffix if longer.
 */
function extractInitialPrompt(
  msg: TranscriptMessage,
  contentBlocks: ParsedContentBlock[],
): string | null {
  // Find the first text block belonging to this message
  for (const block of contentBlocks) {
    if (block.message_id === msg.id && block.block_type === "text" && block.content_text) {
      const text = block.content_text;
      if (text.length > MAX_INITIAL_PROMPT_CHARS) {
        return text.slice(0, MAX_INITIAL_PROMPT_CHARS) + "...";
      }
      return text;
    }
  }

  return null;
}
