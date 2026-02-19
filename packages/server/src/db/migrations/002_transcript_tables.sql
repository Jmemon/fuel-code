-- Phase 2 Schema: Transcript parsing tables
-- Creates transcript_messages and content_blocks for storing parsed JSONL
-- transcript data. Each session's JSONL transcript is broken into individual
-- messages (one row per conversation turn) and content blocks (one row per
-- text/thinking/tool_use/tool_result block within a message).
-- Also adds a recovery index on sessions for finding sessions stuck in
-- intermediate pipeline states (ended/parsed but still pending/parsing).

-- ============================================================================
-- TRANSCRIPT_MESSAGES
-- One row per line in the session's JSONL transcript file. Represents a single
-- conversation message (user turn, assistant turn, system prompt, or summary).
--
-- ordinal: the conversation-order position (may differ from line_number if
--          the JSONL contains non-message lines or metadata).
-- compact_sequence / is_compacted: tracks Claude Code's context compaction --
--          when the context window fills, CC summarizes and restarts, bumping
--          compact_sequence. is_compacted=true marks messages from before the
--          compaction boundary.
-- has_* flags: denormalized booleans for fast filtering without joining to
--          content_blocks (e.g., "show me all messages with tool use").
-- raw_message: the full JSONB line from the transcript, kept for lossless
--          reconstruction if the schema evolves.
-- ============================================================================
CREATE TABLE IF NOT EXISTS transcript_messages (
    id              TEXT PRIMARY KEY,        -- ULID
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    line_number     INTEGER NOT NULL,        -- position in JSONL file
    ordinal         INTEGER NOT NULL,        -- conversation order
    message_type    TEXT NOT NULL,           -- "user" | "assistant" | "system" | "summary"
    role            TEXT,                    -- "human" | "assistant" | "system"
    model           TEXT,                    -- model that generated this (assistant messages)
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    cache_read      INTEGER,
    cache_write     INTEGER,
    cost_usd        NUMERIC(10, 6),
    compact_sequence INTEGER NOT NULL DEFAULT 0,
    is_compacted    BOOLEAN NOT NULL DEFAULT false,
    timestamp       TIMESTAMPTZ,
    raw_message     JSONB,                   -- full raw JSONB from transcript for lossless reconstruction
    metadata        JSONB NOT NULL DEFAULT '{}',
    has_text        BOOLEAN NOT NULL DEFAULT false,
    has_thinking    BOOLEAN NOT NULL DEFAULT false,
    has_tool_use    BOOLEAN NOT NULL DEFAULT false,
    has_tool_result BOOLEAN NOT NULL DEFAULT false
);

-- ============================================================================
-- CONTENT_BLOCKS
-- One row per content block within a transcript message. A single assistant
-- message can contain multiple blocks: a thinking block, then text, then one
-- or more tool_use blocks. Tool results come as separate messages but are
-- linked back via tool_use_id / tool_result_id.
--
-- content_text / thinking_text: extracted text for search and display.
-- tool_name: the tool invoked (e.g., "Read", "Edit", "Bash").
-- tool_input: the JSONB parameters passed to the tool.
-- tool_use_id / tool_result_id: CC's correlation IDs linking a tool_use
--          block to its corresponding tool_result block.
-- result_s3_key: if the tool result is too large for Postgres, it's stored
--          in S3 and this column holds the key.
-- ============================================================================
CREATE TABLE IF NOT EXISTS content_blocks (
    id              TEXT PRIMARY KEY,        -- ULID
    message_id      TEXT NOT NULL REFERENCES transcript_messages(id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    block_order     INTEGER NOT NULL,        -- position within the message
    block_type      TEXT NOT NULL,           -- "text" | "thinking" | "tool_use" | "tool_result"
    content_text    TEXT,                    -- text content (for search)
    thinking_text   TEXT,                    -- thinking block content
    tool_name       TEXT,                    -- e.g., "Read", "Edit", "Bash"
    tool_use_id     TEXT,                    -- CC's tool_use_id for linking to results
    tool_input      JSONB,                   -- tool input parameters
    tool_result_id  TEXT,                    -- links back to tool_use_id
    is_error        BOOLEAN DEFAULT false,
    result_text     TEXT,                    -- truncated result for display
    result_s3_key   TEXT,                    -- S3 key if result was too large
    metadata        JSONB NOT NULL DEFAULT '{}'
);

-- ============================================================================
-- INDEXES: transcript_messages
-- ============================================================================

-- Primary lookup: list messages for a session in conversation order
CREATE INDEX IF NOT EXISTS idx_transcript_msg_session ON transcript_messages(session_id, ordinal);

-- Compaction queries: find messages within a specific compaction sequence
CREATE INDEX IF NOT EXISTS idx_transcript_msg_compact ON transcript_messages(session_id, compact_sequence);

-- ============================================================================
-- INDEXES: content_blocks
-- ============================================================================

-- Primary lookup: list blocks within a message in order
CREATE INDEX IF NOT EXISTS idx_content_blocks_message ON content_blocks(message_id, block_order);

-- Session-level queries: list all blocks for a session (e.g., "all tool uses in this session")
CREATE INDEX IF NOT EXISTS idx_content_blocks_session ON content_blocks(session_id);

-- Tool filtering: find blocks by tool name (partial index excludes non-tool blocks)
CREATE INDEX IF NOT EXISTS idx_content_blocks_tool ON content_blocks(tool_name) WHERE tool_name IS NOT NULL;

-- Full-text search on content_text using GIN + tsvector (partial index excludes NULLs)
CREATE INDEX IF NOT EXISTS idx_content_blocks_text ON content_blocks USING GIN(to_tsvector('english', content_text))
    WHERE content_text IS NOT NULL;

-- ============================================================================
-- INDEXES: sessions (recovery)
-- ============================================================================

-- Recovery index: find sessions stuck in intermediate pipeline states.
-- Sessions with lifecycle 'ended' or 'parsed' but parse_status still
-- 'pending' or 'parsing' indicate a parser crash or timeout. The background
-- recovery job uses this index to find and retry them.
CREATE INDEX IF NOT EXISTS idx_sessions_needs_recovery
  ON sessions(lifecycle, updated_at)
  WHERE lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing');
