# Task 2: Shared Transcript Types + S3 Key Utilities

## Parallel Group: A

## Description

Add transcript-related types, S3 key construction utilities, and the `session.compact` Zod schema to the `@fuel-code/shared` package. These types define the raw JSONL line structure (what the parser reads), the parsed output (what goes into Postgres), aggregate stats, and S3 key patterns.

### Files to Create/Modify

**`packages/shared/src/types/transcript.ts`**:

Types for the raw JSONL line structure (what the parser reads from Claude Code transcripts):
```typescript
// Types of JSONL lines found in a CC transcript (observed from real transcripts)
type TranscriptLineType = "user" | "assistant" | "system" | "summary" | "progress" | "file-history-snapshot" | "queue-operation";

// Content block types inside messages
type ContentBlockType = "text" | "thinking" | "tool_use" | "tool_result";

// Raw JSONL line from a Claude Code transcript
interface RawTranscriptLine {
  type: TranscriptLineType;
  parentUuid?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  timestamp?: string;
  uuid?: string;
  message?: {
    role?: string;
    model?: string;
    id?: string;        // assistant message API ID (shared across streamed lines)
    content?: string | RawContentBlock[];
    usage?: TokenUsage;
    stop_reason?: string | null;
  };
  snapshot?: { timestamp?: string };
  data?: unknown;
}

// Token usage from an assistant message
interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

// Raw content block within a message
interface RawContentBlock {
  type: string;            // "text" | "thinking" | "tool_use" | "tool_result"
  text?: string;           // for type=text
  thinking?: string;       // for type=thinking
  signature?: string;      // for type=thinking
  id?: string;             // for type=tool_use (tool_use_id)
  name?: string;           // for type=tool_use (tool name)
  input?: unknown;         // for type=tool_use
  tool_use_id?: string;    // for type=tool_result (links to tool_use)
  content?: string | unknown; // for type=tool_result
  is_error?: boolean;      // for type=tool_result
}
```

Types for the parsed output (what goes into Postgres):
```typescript
// A parsed transcript message (one row in transcript_messages)
interface TranscriptMessage {
  id: string;
  session_id: string;
  line_number: number;
  ordinal: number;
  message_type: string;
  role: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost_usd: number | null;
  compact_sequence: number;
  is_compacted: boolean;
  timestamp: string | null;
  raw_message: unknown;
  metadata: Record<string, unknown>;
  has_text: boolean;
  has_thinking: boolean;
  has_tool_use: boolean;
  has_tool_result: boolean;
}

// A parsed content block (one row in content_blocks)
interface ParsedContentBlock {
  id: string;
  message_id: string;
  session_id: string;
  block_order: number;
  block_type: ContentBlockType;
  content_text: string | null;
  thinking_text: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: unknown | null;
  tool_result_id: string | null;
  is_error: boolean;
  result_text: string | null;
  result_s3_key: string | null;
  metadata: Record<string, unknown>;
}

// Result of parsing a transcript
interface ParseResult {
  messages: TranscriptMessage[];
  contentBlocks: ParsedContentBlock[];
  stats: TranscriptStats;
  errors: Array<{ lineNumber: number; error: string }>;
  metadata: {
    sessionId: string | null;
    cwd: string | null;
    version: string | null;
    gitBranch: string | null;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
  };
}

// Aggregate statistics computed from a parsed transcript
interface TranscriptStats {
  total_messages: number;
  user_messages: number;
  assistant_messages: number;
  tool_use_count: number;
  thinking_blocks: number;
  subagent_count: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_estimate_usd: number;
  duration_ms: number;
  initial_prompt: string | null;
}
```

**`packages/shared/src/s3-keys.ts`**:

S3 key construction utilities following the layout from CORE.md:
```typescript
// Build the S3 key for a raw transcript JSONL
// Returns: transcripts/{workspaceCanonicalId}/{sessionId}/raw.jsonl
function buildTranscriptKey(workspaceCanonicalId: string, sessionId: string): string

// Build the S3 key for a parsed transcript backup
// Returns: transcripts/{workspaceCanonicalId}/{sessionId}/parsed.json
function buildParsedBackupKey(workspaceCanonicalId: string, sessionId: string): string

// Build the S3 key for a large tool result artifact
// Returns: artifacts/{sessionId}/{artifactId}.{ext}
function buildArtifactKey(sessionId: string, artifactId: string, ext: string): string
```

**`packages/shared/src/schemas/session-compact.ts`**:

Zod schema for `session.compact` event payload:
```typescript
const sessionCompactPayloadSchema = z.object({
  cc_session_id: z.string().min(1),
  compact_sequence: z.number().int().nonneg(),
  transcript_path: z.string(),
});
```

Register `session.compact` in the payload registry in `packages/shared/src/schemas/payload-registry.ts`.

**Modify barrel re-exports** in `packages/shared/src/types/index.ts` and `packages/shared/src/index.ts`.

### Tests

**`packages/shared/src/__tests__/s3-keys.test.ts`**:
- `buildTranscriptKey("github.com/user/repo", "abc-123")` returns `"transcripts/github.com/user/repo/abc-123/raw.jsonl"`
- `buildParsedBackupKey("github.com/user/repo", "abc-123")` returns `"transcripts/github.com/user/repo/abc-123/parsed.json"`
- `buildArtifactKey("abc-123", "artifact-1", "json")` returns `"artifacts/abc-123/artifact-1.json"`
- Keys with special characters in workspace canonical ID are preserved

**`packages/shared/src/__tests__/session-compact-schema.test.ts`**:
- `sessionCompactPayloadSchema` validates a correct payload
- `sessionCompactPayloadSchema` rejects missing `cc_session_id`
- `validateEventPayload("session.compact", validData)` returns `{ success: true }`

## Relevant Files
- `packages/shared/src/types/transcript.ts` (create)
- `packages/shared/src/s3-keys.ts` (create)
- `packages/shared/src/schemas/session-compact.ts` (create)
- `packages/shared/src/schemas/payload-registry.ts` (modify — add session.compact)
- `packages/shared/src/types/index.ts` (modify — re-export)
- `packages/shared/src/index.ts` (modify — re-export)
- `packages/shared/src/__tests__/s3-keys.test.ts` (create)
- `packages/shared/src/__tests__/session-compact-schema.test.ts` (create)

## Success Criteria
1. `import { TranscriptMessage, ParsedContentBlock, ParseResult, TranscriptStats, RawTranscriptLine } from "@fuel-code/shared"` compiles.
2. `import { buildTranscriptKey, buildParsedBackupKey, buildArtifactKey } from "@fuel-code/shared"` compiles and returns correct paths.
3. `sessionCompactPayloadSchema` is registered in the payload registry for `session.compact`.
4. `validateEventPayload("session.compact", { cc_session_id: "x", compact_sequence: 0, transcript_path: "/tmp/t.jsonl" })` succeeds.
5. All tests pass: `bun test packages/shared`.
