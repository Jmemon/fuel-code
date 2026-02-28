/**
 * Transcript type definitions for the fuel-code system.
 *
 * Defines the raw JSONL line structure that the parser reads from Claude Code
 * transcripts, the parsed output that maps to Postgres rows (transcript_messages
 * and content_blocks), and aggregate statistics computed during parsing.
 *
 * Three layers:
 *   1. Raw — direct representation of JSONL lines from CC transcripts
 *   2. Parsed — normalized rows ready for Postgres insertion
 *   3. Stats — aggregate numbers derived from parsed data
 */

// ---------------------------------------------------------------------------
// Raw JSONL structures (what the parser reads)
// ---------------------------------------------------------------------------

/** Types of JSONL lines found in a CC transcript (observed from real transcripts) */
export type TranscriptLineType =
  | "user"
  | "assistant"
  | "system"
  | "summary"
  | "progress"
  | "file-history-snapshot"
  | "queue-operation";

/** Content block types inside messages */
export type ContentBlockType = "text" | "thinking" | "tool_use" | "tool_result";

/** Raw JSONL line from a Claude Code transcript */
export interface RawTranscriptLine {
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
    id?: string;
    content?: string | RawContentBlock[];
    usage?: TokenUsage;
    stop_reason?: string | null;
  };
  snapshot?: { timestamp?: string };
  data?: unknown;
}

/** Token usage from an assistant message */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Raw content block within a message */
export interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Parsed output (Postgres rows)
// ---------------------------------------------------------------------------

/** A parsed transcript message (one row in transcript_messages) */
export interface TranscriptMessage {
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

/** A parsed content block (one row in content_blocks) */
export interface ParsedContentBlock {
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

// ---------------------------------------------------------------------------
// Parsed relationship types (extracted from transcript content blocks)
// ---------------------------------------------------------------------------

/** A subagent spawned during the session, extracted from tool_use blocks */
export interface ParsedSubagent {
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  team_name?: string;
  isolation?: string;
  run_in_background: boolean;
  spawning_tool_use_id: string;
  started_at?: string;
}

/** A team referenced in the transcript (multi-agent coordination) */
export interface ParsedTeam {
  team_name: string;
  description?: string;
  message_count: number;
}

/** A skill invocation detected in the transcript */
export interface ParsedSkill {
  skill_name: string;
  invoked_at: string;
  invoked_by: 'user' | 'claude';
  args?: string;
}

/** A worktree creation detected in the transcript */
export interface ParsedWorktree {
  worktree_name?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Parse result and aggregate statistics
// ---------------------------------------------------------------------------

/** Result of parsing a transcript */
export interface ParseResult {
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

  // -- Phase 4-2: extracted relationships --

  /** Subagents spawned during the session */
  subagents: ParsedSubagent[];
  /** Teams referenced in the session */
  teams: ParsedTeam[];
  /** Skills invoked during the session */
  skills: ParsedSkill[];
  /** Worktrees created during the session */
  worktrees: ParsedWorktree[];
  /** Permission mode the session ran under */
  permission_mode?: string;
  /** Session ID this session was resumed from */
  resumed_from_session_id?: string;
}

/** Aggregate statistics computed from a parsed transcript */
export interface TranscriptStats {
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
