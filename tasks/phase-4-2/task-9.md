# Task 9: Transcript Parser — Skill + Worktree + Chain Extraction

## Parallel Group: C

## Dependencies: Task 7 (builds on Pass 4 infrastructure)

## Description

Extend the parser's Pass 4 (added in Task 7) with skill extraction, worktree extraction, and session metadata extraction (permission_mode, resume detection).

### Skill Extraction

For each content block where `block.tool_name === 'Skill'`:

```typescript
if (block.block_type === 'tool_use' && block.tool_name === 'Skill') {
  const input = block.tool_input as Record<string, unknown>;
  const resultBlock = toolResultMap.get(block.tool_use_id!);

  const skillName = input.skill as string;
  const args = input.args as string | undefined;

  // Determine if user-invoked or claude-invoked
  // User-invoked: the preceding user message contains /<skill_name>
  let invokedBy: 'user' | 'claude' = 'claude';
  // Find the message that contains this tool call
  const containingMessage = messages.find(m =>
    m.message_type === 'assistant' &&
    contentBlocks.some(b =>
      b.message_id === m.id && b.tool_use_id === block.tool_use_id
    )
  );
  if (containingMessage) {
    // Look at the preceding user message
    const msgIndex = messages.indexOf(containingMessage);
    for (let i = msgIndex - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const userText = contentBlocks
          .filter(b => b.message_id === messages[i].id && b.block_type === 'text')
          .map(b => b.content_text)
          .join('');
        if (userText.includes(`/${skillName}`)) {
          invokedBy = 'user';
        }
        break;
      }
    }
  }

  skills.push({
    skill_name: skillName,
    invoked_at: block.metadata?.timestamp as string ?? '',
    invoked_by: invokedBy,
    args,
  });
}
```

### Worktree Extraction

For each content block where `block.tool_name === 'EnterWorktree'`:

```typescript
if (block.block_type === 'tool_use' && block.tool_name === 'EnterWorktree') {
  const input = block.tool_input as Record<string, unknown>;
  worktrees.push({
    worktree_name: input.name as string | undefined,
    created_at: block.metadata?.timestamp as string ?? '',
  });
}
```

### Session Metadata Extraction

Extract from the first transcript line(s):

```typescript
// Permission mode: from the first line's permissionMode field
let permissionMode: string | undefined;
let resumedFromSessionId: string | undefined;

// The first raw line should have session-level metadata
if (rawLines.length > 0) {
  const firstLine = rawLines[0];
  permissionMode = firstLine.permissionMode;

  // Resume detection: check the source field from session.start event data
  // The source is typically on the session row, not in the transcript.
  // But if the transcript has a "source" field, capture it.
  // Alternatively, check if a /continue or /resume command appears in early messages
}
```

**Note on resume detection**: Precise session chain linking requires matching by workspace + time proximity + the `source` field from the `session.start` event. The parser can extract the `source` field from transcript metadata (if present) or from the session.start event data. The pipeline persist step (Task 12) handles the actual DB linking.

### Return Statement Update

Replace the empty arrays from Task 2:

```typescript
return {
  // ... existing fields ...
  subagents,    // from Task 7
  teams,        // from Task 7
  skills,       // from this task
  worktrees,    // from this task
  permission_mode: permissionMode,
  resumed_from_session_id: resumedFromSessionId,
};
```

### Edge Cases

1. **Skill tool call without result** — skill might have failed. Still record the invocation.
2. **Skill auto-invoked before any user message** — `invoked_by` defaults to `'claude'` (correct behavior).
3. **Multiple EnterWorktree calls** — unlikely but possible. Record all.
4. **Permission mode not in transcript** — field is undefined. Pipeline handles gracefully.
5. **No preceding user message with slash command** — `invoked_by` = `'claude'` (correct default).

## Relevant Files
- Modify: `packages/core/src/transcript-parser.ts`

## Success Criteria
1. A transcript with 2 Skill tool calls (one user-invoked via `/commit`, one auto-invoked) produces `ParsedSkill[]` of length 2 with correct `invoked_by` values.
2. A transcript with EnterWorktree produces `ParsedWorktree[]` with correct `worktree_name`.
3. `permission_mode` is extracted when present in transcript metadata.
4. Empty transcripts or transcripts without these tools produce empty arrays.
5. All existing parser tests pass unchanged.
6. Task 7's sub-agent + team extraction continues to work correctly.
