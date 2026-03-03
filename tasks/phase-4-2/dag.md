# Phase 4-2: Claude Code Full Capability Support — Task DAG

## Overview

19 tasks across 7 parallel groups (A–G). Adds support for sub-agents, agent teams, worktrees, skills, and session chains to fuel-code's capture, storage, query, and display layers.

**What this phase delivers**:
- Sub-agent relationship tracking (parent→child tree, nested spawns)
- Agent team modeling (creation, membership, messaging, task coordination)
- Session chains (resume/fork/continue linking)
- Skill invocation tracking (user-invoked and auto-invoked)
- Worktree lifecycle tracking (creation, removal, git correlation)
- Real-time capture via 8 new CC hook entries + retroactive extraction via enhanced transcript parser
- API endpoints to query all new data
- TUI views to display it
- Backfill support for historical sessions

## Task Summary

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Database Migration 005 | A | — |
| 2 | Shared Types + ParseResult Extension | A | — |
| 3 | New Event Types (7) | A | — |
| 4 | Core Event Handlers (7 handlers) | B | 1, 3 |
| 5 | Git Hook Worktree Detection | B | 1 |
| 6 | CC Hook CLI Handlers (5 subcommands) | B | 3 |
| 7 | Transcript Parser — Sub-agent + Team Extraction | B | 2 |
| 8 | Hook Installer — Register New Hooks | C | 6 |
| 9 | Transcript Parser — Skill + Worktree + Chain Extraction | C | 7 |
| 10 | API — Teams Routes | C | 1, 4 |
| 11 | WebSocket Broadcast Extensions | C | 4 |
| 12 | Session Pipeline — Persist Relationships | D | 1, 4, 7, 9 |
| 13 | TUI — Teams Views | D | 10 |
| 14 | Session Pipeline — Sub-agent Transcript Upload + Parse | E | 12 |
| 15 | API — Session Sub-endpoints + Enhanced Detail | E | 1, 4, 12 |
| 16 | Backfill Scanner — Sub-agent Directories | F | 14 |
| 17 | API — Transcript Sub-agent Filtering | F | 14 |
| 18 | TUI — Session Enhancements (detail + list badges) | F | 15 |
| 19 | E2E Integration Tests + Backward Compatibility | G | all |

## Dependency Graph

```
Group A ─── T1: DB Migration    T2: Shared Types    T3: Event Types
               │                     │                    │
        ┌──────┤                     │              ┌─────┴──────┐
        │      │                     │              │            │
        ▼      ▼                     ▼              ▼            ▼
Group B ─── T4: Event         T5: Git Hook      T6: CC Hook   T7: Parser
            Handlers (7)      Worktree Det.     CLI (5 cmds)  Sub-agent+Team
               │                                    │            │
        ┌──────┼──────────┐                         │            │
        │      │          │                         ▼            ▼
        │      │          │                   T8: Hook       T9: Parser
        │      │          │                   Installer      Skill+Worktree
        │      │          │                                      │
        ▼      ▼          ▼                                      │
Group C ─── T10: Teams   T11: WS                                │
            API          Broadcasts                              │
               │                                                 │
               │         ┌───────────────────────────────────────┘
               │         │
               ▼         ▼
Group D ─── T13: TUI   T12: Pipeline
            Teams       Persist Relationships
                           │
                    ┌──────┼──────────┐
                    │      │          │
                    ▼      ▼          ▼
Group E ─── T14: Sub-agent   T15: Session API
            Transcript        Sub-endpoints
            Upload+Parse      + Enhanced Detail
               │                    │
        ┌──────┼──────┐             │
        ▼      ▼      ▼             ▼
Group F ─── T16:    T17:         T18: TUI
            Backfill Transcript   Session
            Scanner  Filtering    Enhancements
               │         │            │
               └─────────┼────────────┘
                         ▼
Group G ─── T19: E2E Integration Tests
```

## Parallel Groups

- **A**: Tasks 1, 2, 3 (fully independent foundation — DB, types, events)
- **B**: Tasks 4, 5, 6, 7 (handlers, git hooks, CLI hooks, parser pt1 — all need only A)
- **C**: Tasks 8, 9, 10, 11 (installer, parser pt2, teams API, WS — need B items)
- **D**: Tasks 12, 13 (pipeline persist, teams TUI — need C items)
- **E**: Tasks 14, 15 (sub-agent transcripts, session API — need D)
- **F**: Tasks 16, 17, 18 (backfill, transcript filtering, TUI enhancements — need E)
- **G**: Task 19 (E2E tests — needs everything)

## Critical Path

```
T1 → T4 → T12 → T14 → T16 → T19
```
(through the pipeline/backfill chain)

Parallel critical paths:
- `T2 → T7 → T9 → T12` (types → parser → pipeline)
- `T3 → T4 → T10 → T13` (events → handlers → teams API → teams TUI)
- `T1 → T4 → T12 → T15 → T18 → T19` (through session API → TUI)

## Dependency Edges (precise)

- T1 → T4, T5, T10, T12, T15 (tables needed)
- T2 → T7 (parser needs ParsedSubagent/ParsedTeam types)
- T3 → T4, T6 (event types needed for handlers and CLI emit)
- T4 → T10, T11, T12, T15 (handlers create data and provide broadcast calls)
- T5 → none downstream (git hooks are a leaf)
- T6 → T8 (CLI subcommands must exist before installer registers them)
- T7 → T9, T12 (parser pt2 builds on pt1; pipeline needs parser output)
- T8 → T19 (installer tested in E2E)
- T9 → T12 (pipeline needs full parser output)
- T10 → T13 (teams TUI needs teams API)
- T11 → T19 (WS tested in E2E)
- T12 → T14, T15 (pipeline persist must exist before sub-agent transcripts and API detail)
- T13 → T19 (teams TUI tested in E2E)
- T14 → T16, T17 (backfill and filtering need sub-agent messages stored)
- T15 → T18 (session TUI needs session API)
- T16, T17, T18 → T19 (all tested in E2E)

## Key Design Decisions

1. **Upsert convergence pattern**: Hooks create rows in real-time (via handlers). Parser creates rows retroactively (via pipeline persist). Both use `ON CONFLICT (session_id, agent_id) DO UPDATE` on subagents table. The UNIQUE index on `subagents(session_id, agent_id)` enables this.

2. **Non-fatal relationship persistence**: The `persistRelationships()` pipeline step logs warnings but does not block lifecycle transition to 'parsed'. A failure here should not prevent the session from being queryable.

3. **Session resolve helper**: All 7 new handlers need to look up fuel-code's session row from CC's session_id. A shared `resolveSessionByCC(sql, ccSessionId)` function avoids duplication.

4. **Defensive hook handlers**: CC hook input schemas are documented but may have edge cases. All hook CLI handlers must: read stdin, try JSON.parse, gracefully handle missing/unknown fields, never write to stdout, always exit 0.

5. **Parser split**: The transcript parser change is the most complex single modification. Split into two tasks: (a) sub-agent + team extraction (complex tool_use↔tool_result correlation) and (b) skill + worktree + session chain (simpler extraction). This reduces risk and allows partial progress.

6. **Sub-agent transcript upload**: Done in session-end hook with `isSessionActive()` check per sub-agent. Still-running sub-agents are skipped (caught by later session-end or backfill). Non-fatal — failure logged but parent session processing continues.

7. **Batch insert column updates**: Adding `subagent_id` to `transcript_messages` and `content_blocks` means the batch insert SQL in session-pipeline.ts must include the new column (NULL for main session messages, set for sub-agent messages). The column count changes from 21→22 for messages and 14→15 for blocks.
