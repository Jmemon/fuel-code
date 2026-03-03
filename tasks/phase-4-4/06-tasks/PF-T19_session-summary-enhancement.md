# Task 19: Session Summary Enhancement for Team Sessions

## Phase: F — Summaries
## Dependencies: T17, T18
## Parallelizable With: T20

---

## Description

Enhance `generateSummary` to include team context for sessions that have teammates. The session summary should mention the team structure and each teammate's work.

## Files

- **Modify**: `packages/core/src/summary-generator.ts` — update `renderTranscriptForSummary` to include teammate context; update system prompt for team sessions

## Key Changes

For team sessions (those with rows in `teammates` table):
1. Query `teammates` for the session
2. If teammates exist, append teammate context to the rendered transcript:
   ```
   ## Teammate work
   - alice: [teammate summary or "No summary yet"]
   - bob: [teammate summary or "No summary yet"]
   ```
3. Update system prompt to mention multi-agent coordination

For non-team sessions: no change to current behavior.

Note: teammate summaries are generated in Task 20 (parallel). The session summary runs first (Step 10), so teammate summaries won't be available yet. The session summary will show "No summary yet" for teammates on first pass. This is acceptable — the session summary focuses on the lead's orchestration.

## How to Test

```bash
cd packages/core && bun test summary 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Non-team session summaries unchanged
2. Team session summaries mention teammate names
3. System prompt updated for team context
4. Handles edge case: team with 0 teammates (TeamCreate but no Agent spawns)
