# Task 7: Transcript Parser — Sub-agent + Team Extraction

## Parallel Group: B

## Dependencies: Task 2 (ParsedSubagent, ParsedTeam types, ParseResult extension)

## Description

Add "Pass 4: Relationship extraction" to `packages/core/src/transcript-parser.ts`. This pass iterates the already-built `ParsedContentBlock[]` from Pass 2 and extracts sub-agent spawns and team operations by correlating tool_use blocks with their corresponding tool_result blocks.

This is the most complex parser change because it requires **cross-reference correlation**: a `tool_use` block for the Task tool contains the spawn parameters, while the corresponding `tool_result` block (matched by `tool_use_id`) contains the agent_id from CC's response.

### Implementation

#### Pass 4 Infrastructure

After Pass 3 (stats), add Pass 4:

```typescript
// Pass 4: Relationship extraction
const subagents: ParsedSubagent[] = [];
const teams: ParsedTeam[] = [];

// Build tool_use_id → tool_use block map for correlation
const toolUseMap = new Map<string, ParsedContentBlock>();
const toolResultMap = new Map<string, ParsedContentBlock>();

for (const block of contentBlocks) {
  if (block.block_type === 'tool_use' && block.tool_use_id) {
    toolUseMap.set(block.tool_use_id, block);
  }
  if (block.block_type === 'tool_result' && block.tool_result_id) {
    toolResultMap.set(block.tool_result_id, block);
  }
}
```

#### Sub-agent Extraction

For each content block where `block.tool_name === 'Task'` (or `'Agent'` — CC uses both names):

```typescript
if (block.block_type === 'tool_use' && (block.tool_name === 'Task' || block.tool_name === 'Agent')) {
  const input = block.tool_input as Record<string, unknown>;
  const resultBlock = toolResultMap.get(block.tool_use_id!);

  // Extract from tool_input
  const agentType = (input.subagent_type as string) ?? 'unknown';
  const agentName = input.name as string | undefined;
  const model = input.model as string | undefined;
  const teamName = input.team_name as string | undefined;
  const isolation = input.isolation as string | undefined;
  const runInBackground = (input.run_in_background as boolean) ?? false;

  // Extract agent_id from tool_result
  // The result block's metadata or result_text may contain the agent_id
  // CC returns it in toolUseResult which is stored in the raw message
  let agentId: string | undefined;
  if (resultBlock) {
    // Try parsing result_text as JSON to find agent_id
    try {
      const resultData = JSON.parse(resultBlock.result_text ?? '{}');
      agentId = resultData.agent_id ?? resultData.teammate_id;
    } catch {
      // result_text might not be JSON — check metadata
      agentId = (resultBlock.metadata as any)?.agent_id;
    }
  }

  if (agentId) {
    subagents.push({
      agent_id: agentId,
      agent_type: agentType,
      agent_name: agentName,
      model,
      team_name: teamName,
      isolation,
      run_in_background: runInBackground,
      spawning_tool_use_id: block.tool_use_id!,
      started_at: block.metadata?.timestamp as string | undefined,
    });
  }
}
```

**Important**: The `toolUseResult` metadata from CC may be attached to the raw transcript line, not the parsed content block. Check how the existing parser handles `toolUseResult` on `type: "user"` messages with `content[].type: "tool_result"`. You may need to capture `toolUseResult` during Pass 2 (message building) and attach it to the content block's metadata. If it's not currently captured, add it — store `line.toolUseResult` on the content block metadata when the line has it.

#### Team Extraction

For each content block where `block.tool_name === 'TeamCreate'`:

```typescript
if (block.block_type === 'tool_use' && block.tool_name === 'TeamCreate') {
  const input = block.tool_input as Record<string, unknown>;
  teams.push({
    team_name: input.team_name as string,
    description: input.description as string | undefined,
    message_count: 0, // will be incremented below
  });
}
```

For `SendMessage` tool calls, increment the message count on the matching team:

```typescript
if (block.block_type === 'tool_use' && block.tool_name === 'SendMessage') {
  const input = block.tool_input as Record<string, unknown>;
  // Find matching team and increment
  // Note: team_name might need to be resolved from context
  for (const team of teams) {
    team.message_count++;
    break; // if only one team per session, this is fine
  }
}
```

#### Return Statement Update

Replace the empty arrays added in Task 2 with the actual extracted data:

```typescript
return {
  // ... existing fields ...
  subagents,
  teams,
  skills: [],      // Task 9 fills this
  worktrees: [],   // Task 9 fills this
};
```

### Edge Cases

1. **Task tool call with no result** — sub-agent might have been spawned but transcript was truncated. Skip (no agent_id to record).
2. **Multiple teams in one session** — unlikely but possible. Each TeamCreate produces a separate team entry.
3. **tool_result without matching tool_use** — skip (orphaned result).
4. **Agent tool vs Task tool** — CC may use either name. Check both.
5. **Nested sub-agents** — a sub-agent's transcript may itself contain Task tool calls. This is handled by parsing sub-agent transcripts separately (Task 14). The main session parser only sees the top-level Task calls.

## Relevant Files
- Modify: `packages/core/src/transcript-parser.ts`

## Success Criteria
1. A transcript with 3 Task tool calls produces `ParsedSubagent[]` of length 3 with correct `agent_id`, `agent_type`, `spawning_tool_use_id`.
2. A transcript with TeamCreate + 5 SendMessage calls produces `ParsedTeam[]` of length 1 with `message_count: 5`.
3. A transcript with no Task/TeamCreate/SendMessage calls produces empty arrays.
4. `toolUseResult` metadata is captured on tool_result content blocks (needed for agent_id extraction).
5. Correlation between tool_use and tool_result is correct (matched by `tool_use_id`).
6. All existing parser tests pass unchanged.
7. Parser performance is not significantly degraded (Pass 4 is O(n) over content blocks with O(1) map lookups).
