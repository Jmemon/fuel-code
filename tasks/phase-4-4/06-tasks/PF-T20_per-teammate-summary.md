# Task 20: Per-Teammate Summary Generation

## Phase: F — Summaries
## Dependencies: T17, T18
## Parallelizable With: T19

---

## Description

After the session reaches PARSED, generate a 1-2 sentence summary for each teammate based on their stitched message feed.

## Files

- **Create**: `packages/core/src/reconcile/teammate-summary.ts` — `generateTeammateSummaries(deps, sessionId)`
- **Modify**: `packages/core/src/summary-generator.ts` — add `generateTeammateSummary(messages, blocks, context)` variant

## Key Implementation

```typescript
async function generateTeammateSummaries(deps: ReconcileDeps, sessionId: string) {
  const teammates = await deps.sql`SELECT * FROM teammates WHERE session_id = ${sessionId}`;

  for (const teammate of teammates) {
    const messages = await deps.sql`
      SELECT * FROM transcript_messages WHERE teammate_id = ${teammate.id} ORDER BY timestamp
    `;
    const blocks = await deps.sql`
      SELECT * FROM content_blocks WHERE teammate_id = ${teammate.id} ORDER BY block_order
    `;

    const rendered = renderTranscriptForSummary(messages, blocks);
    const result = await generateSummary(rendered, {
      systemPrompt: `Summarize this agent teammate's work in 1-2 sentences, past tense.
        This is "${teammate.name}", a member of team "${teamName}".
        Focus on what they accomplished, not how they communicated.`,
      maxTokens: 100,
    });

    if (result.success && result.summary) {
      await deps.sql`UPDATE teammates SET summary = ${result.summary} WHERE id = ${teammate.id}`;
    }
  }
}
```

## How to Test

```bash
cd packages/core && bun test teammate-summary 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Each teammate gets a summary stored in `teammates.summary`
2. Summaries are 1-2 sentences, past tense
3. Failures are non-fatal — missing summaries don't block lifecycle
4. Sessions with no teammates skip this step entirely
5. Empty teammate message feeds produce a sensible summary (e.g., "No recorded activity")
