# Task 6: Summary Generator

## Parallel Group: C

## Description

Build the LLM-powered summary generator that produces a 1–3 sentence past-tense summary of a parsed session. It renders a condensed transcript representation as markdown, calls Claude Sonnet via the Anthropic API, and returns the summary text. This is a pure function in `packages/core/` — it takes parsed messages/blocks in and returns a summary string. The lifecycle transition and database write happen in the pipeline orchestrator (Task 7).

### Dependencies to Install
```bash
cd packages/core && bun add @anthropic-ai/sdk
```

### Files to Create

**`packages/core/src/summary-generator.ts`**:

```typescript
interface SummaryConfig {
  enabled: boolean;
  model: string;          // default "claude-sonnet-4-5-20250929"
  temperature: number;    // default 0.3
  maxOutputTokens: number; // default 150
  apiKey: string;         // ANTHROPIC_API_KEY
}

interface SummaryResult {
  success: boolean;
  summary?: string;
  error?: string;
  retryAfterSeconds?: number;  // if rate limited (429)
}

// Generate a summary from parsed transcript messages + content blocks
async function generateSummary(
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[],
  config: SummaryConfig
): Promise<SummaryResult>
```

Implementation:

1. If `config.enabled === false`: return `{ success: true, summary: null }`.

2. If messages array is empty: return `{ success: true, summary: "Empty session." }`.

3. **Render prompt context** via `renderTranscriptForSummary`:
   - Include a header: model used, total messages, tool use count, duration.
   - Include user messages as `[User]: {text}` (first 500 chars each).
   - Include assistant text blocks as `[Assistant]: {text}` (first 300 chars each).
   - Include tool use as bullet points: `- Used {tool_name}` (name only, not full input/output).
   - Skip thinking blocks entirely (internal reasoning, not useful for summary).
   - Skip tool results entirely (too verbose).
   - If rendered prompt exceeds 8000 characters, truncate the middle (keep first 3000 and last 3000 chars with `... [truncated {N} messages] ...`).

4. **Call Claude Sonnet**:
   ```typescript
   const anthropic = new Anthropic({ apiKey: config.apiKey });
   const response = await anthropic.messages.create({
     model: config.model,
     max_tokens: config.maxOutputTokens,
     temperature: config.temperature,
     system: SUMMARY_SYSTEM_PROMPT,
     messages: [{ role: "user", content: renderedPrompt }],
   });
   ```
   - Timeout: 30 seconds via `AbortSignal.timeout(30_000)`.

5. **System prompt**:
   ```
   You are a technical activity summarizer. Write a 1-3 sentence summary of this
   Claude Code session in past tense. Focus on WHAT was accomplished, not HOW.
   Be specific about files, features, or bugs. Do not start with "The user" or
   "This session". Example: "Refactored the authentication middleware to use JWT
   tokens and added comprehensive test coverage for the login flow."
   ```

6. Extract summary text from response content blocks.

7. **Error handling**:
   - Anthropic 429 (rate limit): return `{ success: false, error: "Rate limited", retryAfterSeconds }`.
   - Anthropic 401 (auth): return `{ success: false, error: "Invalid Anthropic API key" }`.
   - Anthropic 500+: return `{ success: false, error: "Anthropic API error: {status}" }`.
   - Timeout: return `{ success: false, error: "Summary generation timed out (30s)" }`.
   - Missing API key: return `{ success: false, error: "ANTHROPIC_API_KEY not configured" }`.
   - Never throw — always return `SummaryResult`.

**`packages/core/src/summary-config.ts`**:

```typescript
// Load summary configuration from environment variables
function loadSummaryConfig(): SummaryConfig
  // SUMMARY_ENABLED: "true" (default) or "false"
  // SUMMARY_MODEL: default "claude-sonnet-4-5-20250929"
  // SUMMARY_TEMPERATURE: default "0.3"
  // SUMMARY_MAX_OUTPUT_TOKENS: default "150"
  // ANTHROPIC_API_KEY: required if SUMMARY_ENABLED=true
```

**Exported helper** (used by Task 11 backfill for initial prompt extraction):

```typescript
// Extract the initial prompt from the first user message
// Returns first 1000 characters, truncated with "..." if longer
function extractInitialPrompt(
  messages: TranscriptMessage[],
  contentBlocks: ParsedContentBlock[]
): string | null
```

### Tests

**`packages/core/src/__tests__/summary-generator.test.ts`**:

1. `renderTranscriptForSummary` with 3 messages: produces readable markdown with user/assistant turns.
2. `renderTranscriptForSummary` with 200+ messages: output truncated to < 8000 chars.
3. `renderTranscriptForSummary` excludes thinking blocks and tool results.
4. `renderTranscriptForSummary` includes tool use names as bullet list.
5. `extractInitialPrompt` returns first user message text (first 1000 chars).
6. `extractInitialPrompt` with no user messages: returns null.
7. `generateSummary` with `enabled = false`: returns `{ success: true, summary: null }`.
8. `generateSummary` with empty messages: returns `{ success: true, summary: "Empty session." }`.
9. `generateSummary` with missing API key: returns `{ success: false, error: "ANTHROPIC_API_KEY not configured" }`.
10. (Integration test, skipped without API key) Full summary generation against real Anthropic API — verify response is 1-3 sentences, past tense.

## Relevant Files
- `packages/core/src/summary-generator.ts` (create)
- `packages/core/src/summary-config.ts` (create)
- `packages/core/src/__tests__/summary-generator.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export)

## Success Criteria
1. `renderTranscriptForSummary` produces a concise markdown representation of a session.
2. Long transcripts (>8000 chars) are truncated with explicit truncation marker.
3. Thinking blocks and tool results are excluded from the summary prompt.
4. When `enabled = true` and API key is available, a 1-3 sentence summary is generated.
5. When `enabled = false`, returns `{ success: true, summary: null }` without calling the API.
6. Empty sessions return `"Empty session."` without calling the API.
7. API errors return `{ success: false }` with descriptive error — never throw.
8. Rate limit (429) includes `retryAfterSeconds` from response.
9. Timeout is 30 seconds.
10. `extractInitialPrompt` returns the first user message text (first 1000 chars, truncated).
