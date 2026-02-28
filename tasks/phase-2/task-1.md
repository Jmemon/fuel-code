# Task 1: Phase 2 Database Migration

## Parallel Group: A

## Description

Create the Phase 2 SQL migration that adds the `transcript_messages` and `content_blocks` tables to the existing database. These tables store parsed JSONL transcript data — one row per conversation message, one row per content block within a message. Also add a recovery index on `sessions` for finding sessions stuck in intermediate pipeline states.

### Files to Create

**`packages/server/src/db/migrations/002_transcript_tables.sql`**:

Create `transcript_messages` table exactly as specified in CORE.md:

```sql
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
```

Create `content_blocks` table exactly as specified in CORE.md:

```sql
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
```

Create all indexes from CORE.md:
```sql
CREATE INDEX IF NOT EXISTS idx_transcript_msg_session ON transcript_messages(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_transcript_msg_compact ON transcript_messages(session_id, compact_sequence);
CREATE INDEX IF NOT EXISTS idx_content_blocks_message ON content_blocks(message_id, block_order);
CREATE INDEX IF NOT EXISTS idx_content_blocks_session ON content_blocks(session_id);
CREATE INDEX IF NOT EXISTS idx_content_blocks_tool ON content_blocks(tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_blocks_text ON content_blocks USING GIN(to_tsvector('english', content_text))
    WHERE content_text IS NOT NULL;
```

Add a recovery index on `sessions` for finding stuck sessions (used by Task 10):
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_needs_recovery
  ON sessions(lifecycle, updated_at)
  WHERE lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing');
```

Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for idempotency.

## Relevant Files
- `packages/server/src/db/migrations/002_transcript_tables.sql` (create)

## Success Criteria
1. Running `runMigrations` on a database with `001_initial.sql` already applied creates both new tables.
2. Running again is a no-op: `002_transcript_tables.sql` is skipped (already applied).
3. `transcript_messages.session_id` has a FK constraint to `sessions(id)` with ON DELETE CASCADE.
4. `content_blocks.message_id` has a FK constraint to `transcript_messages(id)` with ON DELETE CASCADE.
5. `content_blocks.session_id` has a FK constraint to `sessions(id)` with ON DELETE CASCADE.
6. All 7 indexes are created (6 from CORE.md + 1 recovery index).
7. The GIN text search index on `content_blocks.content_text` is functional: `SELECT * FROM content_blocks WHERE to_tsvector('english', content_text) @@ to_tsquery('test')` runs without error.
8. `transcript_messages.compact_sequence` defaults to 0, `is_compacted` defaults to false.
9. `content_blocks.is_error` defaults to false.
10. Deleting a session cascades to delete all its `transcript_messages`, which cascades to delete all their `content_blocks`.
