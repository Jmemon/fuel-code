# Task 19: E2E Integration Tests + Backward Compatibility Verification

## Parallel Group: G

## Dependencies: All previous tasks (1–18)

## Description

Comprehensive integration tests covering the full data flow for all Phase 4-2 features, plus backward compatibility verification for existing sessions.

### Test Categories

#### 1. Hook → Handler → DB Flow Tests

Test each hook type end-to-end:

**Sub-agent lifecycle**:
- Emit `subagent.start` event → handler creates subagent row with status='running'
- Emit `subagent.stop` event → handler updates to status='completed', sets ended_at
- Verify session.subagent_count is updated
- Verify duplicate events (same session_id + agent_id) produce exactly one row

**Team lifecycle**:
- Emit `team.create` event → handler creates teams row, updates session.team_name/team_role
- Emit `team.message` events → handler increments metadata.message_count
- Verify team.create for an existing team_name upserts (doesn't duplicate)

**Skill invocation**:
- Emit `skill.invoke` event → handler creates session_skills row
- Verify multiple skills in one session create separate rows

**Worktree lifecycle**:
- Emit `worktree.create` event → handler creates session_worktrees row
- Emit `worktree.remove` event → handler updates removed_at, had_changes
- Verify worktree.remove without prior create creates complete row

#### 2. Hook → Parser → Pipeline Convergence Tests

The most critical tests — verify that hooks and parser produce consistent state:

- Create subagent row via hook (status='running'), then run pipeline (parser extracts same agent) → exactly one row, status='completed', all fields merged
- Run pipeline with no prior hook data → complete row created from parser alone
- Run pipeline twice (reparse) → same final state (idempotent)

#### 3. Transcript Parser Tests

Using realistic JSONL fixtures:

- **Sub-agent extraction**: Transcript with 3 Task tool calls → 3 ParsedSubagent with correct agent_ids
- **Team extraction**: Transcript with TeamCreate + SendMessage calls → 1 ParsedTeam with correct message_count
- **Skill extraction**: Transcript with user-invoked `/commit` + auto-invoked brainstorming → 2 ParsedSkill with correct invoked_by
- **Worktree extraction**: Transcript with EnterWorktree → 1 ParsedWorktree
- **Empty transcript**: No relationship data → empty arrays
- **Backward compatibility**: Old transcript format (no Task/TeamCreate/Skill calls) → empty arrays, no errors

#### 4. API Tests

- `GET /api/sessions/:id` includes inline subagents, skills, worktrees, team, resumed_from
- `GET /api/sessions/:id/subagents` returns correct list
- `GET /api/sessions/:id/skills` returns correct list
- `GET /api/sessions/:id/worktrees` returns correct list
- `GET /api/teams` returns teams with lead session info
- `GET /api/teams/:name` returns detail with members
- `GET /api/sessions?has_subagents=true` filters correctly
- `GET /api/sessions?team=phase-2-impl` filters correctly
- `GET /api/sessions/:id/transcript?subagent_id=all` returns main + sub-agent messages
- All 404 cases handled correctly

#### 5. Hook Installer Tests

- `fuel-code hooks install` registers all 10 hook entries
- PostToolUse has 4 entries with correct matchers
- Install is idempotent (run twice → same result)
- Uninstall removes all fuel-code hooks, preserves others
- Status reports all hooks accurately

#### 6. Git Hook Worktree Tests

- Commit in worktree → event has `is_worktree: true`, correct `worktree_name`
- Commit in main tree → event has `is_worktree: false`
- git_activity row has correct worktree columns

#### 7. Backward Compatibility Verification

The most important test category:

- **Old sessions**: Sessions created before Phase 4-2 (no subagents/teams/skills/worktrees) display correctly in API and TUI
- **Migration on existing data**: 005 migration runs cleanly on database with existing sessions, events, transcript_messages, content_blocks
- **Parser backward compat**: Running enhanced parser on old transcripts produces empty relationship arrays, no errors
- **API backward compat**: Session detail response for old sessions has `subagents: [], skills: [], worktrees: [], team: null, resumed_from: null`
- **TUI backward compat**: Old sessions render identically to pre-Phase-4-2 (no panels/badges shown)

#### 8. Backfill Tests

- Backfill scanner discovers sub-agent transcripts in subagents/ directories
- Active sub-agents are skipped
- Parent sessions without subagents/ work as before
- Scan stats include sub-agent counts

### Test Fixture Strategy

Create realistic test fixtures:
- `packages/core/src/__tests__/fixtures/transcript-with-subagents.jsonl` — transcript containing 2 Task tool calls with results
- `packages/core/src/__tests__/fixtures/transcript-with-team.jsonl` — transcript with TeamCreate + SendMessage
- `packages/core/src/__tests__/fixtures/transcript-with-skills.jsonl` — transcript with user and auto skill invocations
- `packages/core/src/__tests__/fixtures/transcript-plain.jsonl` — old-style transcript without any new features

These can be excerpted from real transcripts on this machine (in `~/.claude/projects/`).

## Relevant Files
- Create: `packages/core/src/__tests__/transcript-parser-relationships.test.ts`
- Create: `packages/core/src/__tests__/pipeline-relationships.test.ts`
- Create: `packages/server/src/__tests__/sessions-relationships.test.ts`
- Create: `packages/server/src/__tests__/teams.test.ts`
- Create: `packages/cli/src/__tests__/hooks-install.test.ts`
- Create: Test fixtures in `packages/core/src/__tests__/fixtures/`
- Potentially modify existing test files to verify backward compat

## Success Criteria
1. All hook → handler → DB flows produce correct data.
2. Hook + parser convergence produces exactly one row per entity (no duplicates).
3. Reparse is idempotent (running pipeline twice = same state).
4. All API endpoints return correct data for sessions with and without new features.
5. Transcript parser correctly extracts all relationship types from fixtures.
6. Backward compatibility: old sessions work perfectly across API, parser, and TUI.
7. Migration runs cleanly on existing database.
8. Hook installer registers/unregisters correctly.
9. Git hook worktree detection works in both contexts.
10. Backfill scanner handles sub-agent transcripts correctly.
11. Zero test regressions in existing test suite.
12. All new tests pass.
