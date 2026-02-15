# Task 5: Transcript Parser

## Parallel Group: C

## Description

Build the JSONL transcript parser that converts a Claude Code transcript into structured `TranscriptMessage[]` and `ParsedContentBlock[]` arrays ready for database insertion. This is a pure function in `packages/core/` — no HTTP, no S3, no DB writes. It takes a string or readable stream in, returns structured data out.

Real Claude Code transcripts range from 3KB to 144MB and have complex structure: assistant messages stream across multiple JSONL lines sharing the same `message.id`, content blocks can be text, thinking, tool_use, or tool_result, and non-message lines (progress, file-history-snapshot, summary) must be classified and handled.

### Files to Create

**`packages/core/src/transcript-parser.ts`**:

```typescript
interface ParseOptions {
  // Max size of content_text/result_text to store inline (bytes). Default 256KB.
  maxInlineContentBytes?: number;
  // Callback for per-line errors (corrupt JSON, unknown type).
  onLineError?: (lineNumber: number, error: string) => void;
  // Abort signal for cancellation.
  signal?: AbortSignal;
}

// Main entry point: takes raw JSONL content, returns structured data
async function parseTranscript(
  sessionId: string,
  input: string | ReadableStream,
  options?: ParseOptions
): Promise<ParseResult>
```

**Parsing algorithm** (critical — must handle all observed transcript formats):

1. **Split into lines**: If input is a string, split on `\n`. If ReadableStream, read line-by-line using a line-splitting transform. Filter out empty lines.

2. **Classify each line**: Parse JSON. If JSON parse fails, record in `errors` and skip. Classify by `type` field:
   - `"user"` or `"assistant"`: conversation message. Process.
   - `"system"`: system message. Process (creates a transcript_message).
   - `"summary"`: CC compaction summary. Process (creates a transcript_message with `message_type = "summary"`).
   - `"progress"`, `"file-history-snapshot"`, `"queue-operation"`: skip (metadata, not conversation content).
   - Unknown/missing type: skip with error.

3. **Group assistant message lines by `message.id`**: Multiple JSONL lines can share the same `message.id` (Claude Code streams assistant responses, writing one content block per line). Build a map: `Map<messageId, { lines: RawTranscriptLine[], firstLineNumber: number }>`. Only assistant lines have this behavior. User and system lines are standalone.

4. **Build messages in order**: Process lines in original JSONL order. For user/system/summary lines, create one `TranscriptMessage` per line. For assistant lines, create one `TranscriptMessage` per unique `message.id` group (placed at the ordinal position of the first line).

5. **Extract content blocks for each message**:
   - **User text message** (content is a string): One block with `block_type = "text"`, `content_text = content`.
   - **User tool_result message** (content is array with tool_result objects): One block per tool_result with `block_type = "tool_result"`, `tool_result_id = tool_use_id`, `is_error`, `result_text` (truncated to `maxInlineContentBytes`). Set `has_tool_result = true`.
   - **Assistant text block** (`content[].type = "text"`): `block_type = "text"`, `content_text = text`. Set `has_text = true`.
   - **Assistant thinking block** (`content[].type = "thinking"`): `block_type = "thinking"`, `thinking_text = thinking`. Set `has_thinking = true`.
   - **Assistant tool_use block** (`content[].type = "tool_use"`): `block_type = "tool_use"`, `tool_name = name`, `tool_use_id = id`, `tool_input = input`. Set `has_tool_use = true`.

6. **Extract token usage**: For each assistant message group, take usage from the first line's `message.usage`:
   - `tokens_in = usage.input_tokens`
   - `tokens_out = usage.output_tokens`
   - `cache_read = usage.cache_read_input_tokens`
   - `cache_write = usage.cache_creation_input_tokens`

7. **Compute cost per message**: Use approximate Claude pricing (can refine later):
   - Input: $3.00/MTok, Output: $15.00/MTok, Cache read: $0.30/MTok, Cache write: $3.75/MTok
   - `cost_usd = (tokens_in * 3 + tokens_out * 15 + cache_read * 0.30 + cache_write * 3.75) / 1_000_000`

8. **Generate IDs**: Each `TranscriptMessage` gets a ULID via `generateId()`. Each `ParsedContentBlock` gets a ULID. The `session_id` is passed through to both.

9. **Extract metadata**: From the first user or assistant line, capture `sessionId`, `cwd`, `version`, `gitBranch`. Capture `firstTimestamp` from the first line and `lastTimestamp` from the last line.

10. **Compute stats**: Aggregate across all messages:
    - `total_messages`: count of all messages
    - `user_messages`: count where `message_type = "user"`
    - `assistant_messages`: count where `message_type = "assistant"`
    - `tool_use_count`: count of content blocks where `block_type = "tool_use"`
    - `thinking_blocks`: count where `block_type = "thinking"`
    - `subagent_count`: count where `tool_name = "Task"` (Claude Code's subagent tool)
    - `tokens_in/out/cache_read/cache_write`: sums (nulls as 0)
    - `cost_estimate_usd`: sum of per-message costs
    - `duration_ms`: `lastTimestamp - firstTimestamp` in ms
    - `initial_prompt`: text of first user message (first 1000 chars, truncated with `...`)

11. **Edge cases**:
    - Empty transcript (0 lines): return empty `ParseResult` with zero stats.
    - Malformed JSON line: record in `errors`, skip, continue.
    - Line exceeding 5MB: skip with error "Line exceeds max size".
    - Tool result content > `maxInlineContentBytes`: truncate `result_text`, note in metadata.
    - Assistant line with string content instead of array: treat as single text block.
    - `null`/`undefined` content: skip block extraction, message has all `has_*` = false.
    - AbortSignal fires mid-parse: stop and return partial result.

### Tests

**`packages/core/src/__tests__/transcript-parser.test.ts`**:

Create test JSONL strings inline (not from files) for precise control:

1. **Simple conversation**: 1 user text + 1 assistant text response. Verify: 2 messages, 2 content blocks, correct ordinals (0, 1).
2. **Multi-block assistant**: 1 user + assistant with thinking + text + tool_use (3 JSONL lines, same `message.id`). Verify: 2 messages (not 4), 3 content blocks on assistant message, `has_thinking = true`, `has_text = true`, `has_tool_use = true`.
3. **Tool round-trip**: Assistant tool_use → user tool_result. Verify: `tool_use_id` matches `tool_result_id`, flags correct.
4. **Token extraction**: Assistant message with usage data. Verify: `tokens_in`, `tokens_out`, `cache_read`, `cache_write` extracted.
5. **Cost computation**: Known token counts → expected cost (within 0.001 tolerance).
6. **Empty transcript**: Empty string → empty messages, zero stats, no errors.
7. **Malformed line**: Mix of valid and invalid JSON. Valid parsed, invalid in errors.
8. **Metadata-only transcript**: Only `progress` and `file-history-snapshot` lines. Empty messages.
9. **Large tool result**: Tool result > 256KB. `result_text` truncated, metadata flag set.
10. **Initial prompt extraction**: First user message text is `stats.initial_prompt`.
11. **Summary line**: Line with `type = "summary"` creates a `message_type = "summary"` message.
12. **Duration computation**: First line at t=0, last at t=30m → `duration_ms = 1800000`.
13. **Subagent detection**: Tool use with `tool_name = "Task"` counted in `subagent_count`.

Also create a small fixture file for realistic parsing:
**`packages/core/src/__tests__/fixtures/sample-transcript.jsonl`** — a 10-line realistic transcript with user, assistant, thinking, tool_use, and tool_result lines.

## Relevant Files
- `packages/core/src/transcript-parser.ts` (create)
- `packages/core/src/__tests__/transcript-parser.test.ts` (create)
- `packages/core/src/__tests__/fixtures/sample-transcript.jsonl` (create)
- `packages/core/src/index.ts` (modify — re-export parseTranscript)

## Success Criteria
1. A realistic multi-line transcript parses without error, producing expected message and content block counts.
2. Assistant messages streamed across multiple JSONL lines (same `message.id`) are grouped into a single `TranscriptMessage` with multiple `ParsedContentBlock` rows.
3. `has_text`, `has_thinking`, `has_tool_use`, `has_tool_result` flags are correct for each message.
4. Token usage is extracted from assistant messages only. User messages have null token fields.
5. Ordinals are sequential and reflect conversation order (not JSONL line order for grouped messages).
6. Empty transcripts produce a valid `ParseResult` with zero stats and no errors.
7. Malformed JSON lines are captured in `errors` without crashing the parser.
8. Non-message lines (`progress`, `file-history-snapshot`, `queue-operation`) are skipped.
9. `initial_prompt` is extracted from the first user text message (first 1000 chars).
10. `duration_ms` is computed from first to last timestamp.
11. Tool results larger than 256KB have truncated `result_text`.
12. `parseTranscript` completes in < 5 seconds for a 5MB transcript string.
13. Streaming input (ReadableStream) works for very large transcripts without OOM.
