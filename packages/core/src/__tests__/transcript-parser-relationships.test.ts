/**
 * Tests for transcript parser relationship extraction (Phase 4-2).
 *
 * Verifies that the parser correctly extracts sub-agents, teams, skills,
 * and worktrees from JSONL transcripts. Uses both inline JSONL strings
 * for edge cases and fixture files for integration-level coverage.
 *
 * Test categories:
 *   1. Sub-agent extraction — Task/Agent tool calls with agent_id from results
 *   2. Team extraction — TeamCreate + SendMessage tool calls with message counting
 *   3. Skill extraction — Skill tool calls with user vs claude invocation detection
 *   4. Worktree extraction — EnterWorktree tool calls
 *   5. Backward compatibility — old transcripts with no new features
 *   6. Fixture file integration tests
 */

import { describe, expect, test } from "bun:test";
import { parseTranscript } from "../transcript-parser.js";
import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helper: build JSONL from objects
// ---------------------------------------------------------------------------

function jsonl(...lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

// ---------------------------------------------------------------------------
// 1. Sub-agent extraction
// ---------------------------------------------------------------------------

describe("transcript parser: sub-agent extraction", () => {
  test("extracts 3 sub-agents from Task/Agent tool calls with agent_id in results", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-with-subagents.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_sub1", input);

    expect(result.subagents).toHaveLength(3);

    // First subagent: Task tool, code type
    expect(result.subagents[0].agent_id).toBe("agent-aaa111");
    expect(result.subagents[0].agent_type).toBe("code");
    expect(result.subagents[0].agent_name).toBe("auth-worker-1");
    expect(result.subagents[0].model).toBe("claude-sonnet-4-6");
    expect(result.subagents[0].run_in_background).toBe(false);
    expect(result.subagents[0].spawning_tool_use_id).toBe("toolu_task1");

    // Second subagent: Task tool, code type, no model specified
    expect(result.subagents[1].agent_id).toBe("agent-bbb222");
    expect(result.subagents[1].agent_type).toBe("code");
    expect(result.subagents[1].agent_name).toBe("auth-worker-2");
    expect(result.subagents[1].model).toBeUndefined();

    // Third subagent: Agent tool with team/isolation/background metadata
    expect(result.subagents[2].agent_id).toBe("agent-ccc333");
    expect(result.subagents[2].agent_type).toBe("test-runner");
    expect(result.subagents[2].agent_name).toBe("test-agent");
    expect(result.subagents[2].run_in_background).toBe(true);
    expect(result.subagents[2].team_name).toBe("auth-team");
    expect(result.subagents[2].isolation).toBe("worktree");
  });

  test("stats.subagent_count counts only Task tool_use blocks (not Agent)", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-with-subagents.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_sub1", input);

    // Only 2 of 3 spawns use the "Task" tool name; the third uses "Agent"
    // stats.subagent_count only counts "Task" tool calls
    expect(result.stats.subagent_count).toBe(2);
  });

  test("Task tool call without agent_id in result is NOT extracted as subagent", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_no_id",
          content: [
            {
              type: "tool_use",
              id: "toolu_no_result",
              name: "Task",
              input: { prompt: "do something", subagent_type: "code" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "user",
        timestamp: "2025-07-01T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_no_result",
              content: "Error: task failed", // no agent_id in result
            },
          ],
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // No subagent extracted because result doesn't contain agent_id
    expect(result.subagents).toHaveLength(0);
    // But the Task tool_use is still counted in stats
    expect(result.stats.subagent_count).toBe(1);
  });

  test("Task tool call without any tool_result is NOT extracted as subagent", async () => {
    const input = jsonl({
      type: "assistant",
      timestamp: "2025-07-01T10:00:00.000Z",
      message: {
        role: "assistant",
        id: "msg_no_result",
        content: [
          {
            type: "tool_use",
            id: "toolu_orphan",
            name: "Task",
            input: { prompt: "orphaned task", subagent_type: "researcher" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });

    const result = await parseTranscript("sess_1", input);

    // No tool_result to extract agent_id from
    expect(result.subagents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Team extraction
// ---------------------------------------------------------------------------

describe("transcript parser: team extraction", () => {
  test("extracts team from TeamCreate with message count from SendMessage calls", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-with-team.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_team1", input);

    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].team_name).toBe("api-refactor");
    expect(result.teams[0].description).toBe("Team for API layer refactoring");
    // 3 SendMessage calls with team_name="api-refactor"
    expect(result.teams[0].message_count).toBe(3);
  });

  test("TeamCreate without SendMessage produces team with message_count=0", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_tc_only",
          content: [
            {
              type: "tool_use",
              id: "toolu_tc_only",
              name: "TeamCreate",
              input: { team_name: "empty-team" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].team_name).toBe("empty-team");
    expect(result.teams[0].message_count).toBe(0);
  });

  test("SendMessage to team without TeamCreate still records the team", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_sm_no_tc",
          content: [
            {
              type: "tool_use",
              id: "toolu_sm_orphan",
              name: "SendMessage",
              input: { type: "message", recipient: "worker", content: "hello", team_name: "phantom-team" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].team_name).toBe("phantom-team");
    expect(result.teams[0].message_count).toBe(1);
  });

  test("duplicate TeamCreate for same team_name does not create two teams", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_dup1",
          content: [
            {
              type: "tool_use",
              id: "toolu_dup1",
              name: "TeamCreate",
              input: { team_name: "dup-team", description: "first" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:02.000Z",
        message: {
          role: "assistant",
          id: "msg_dup2",
          content: [
            {
              type: "tool_use",
              id: "toolu_dup2",
              name: "TeamCreate",
              input: { team_name: "dup-team", description: "second" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // Only one team, using the first description
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0].team_name).toBe("dup-team");
    expect(result.teams[0].description).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// 3. Skill extraction
// ---------------------------------------------------------------------------

describe("transcript parser: skill extraction from fixtures", () => {
  test("extracts user-invoked and claude-invoked skills from fixture", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-with-skills.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_skill1", input);

    expect(result.skills).toHaveLength(2);

    // First skill: user-invoked (user message contains "/commit")
    expect(result.skills[0].skill_name).toBe("commit");
    expect(result.skills[0].invoked_by).toBe("user");
    expect(result.skills[0].args).toBe("-m 'Add auth module'");

    // Second skill: claude-invoked (no "/review-pr" in preceding user message)
    expect(result.skills[1].skill_name).toBe("review-pr");
    expect(result.skills[1].invoked_by).toBe("claude");
    expect(result.skills[1].args).toBe("42");
  });

  test("multiple skills in one session create separate ParsedSkill entries", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: { role: "user", content: "/commit" },
      },
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_ms1",
          content: [
            { type: "tool_use", id: "toolu_ms1", name: "Skill", input: { skill: "commit" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "user",
        timestamp: "2025-07-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_ms1", content: "ok" }],
        },
      },
      {
        type: "user",
        timestamp: "2025-07-01T10:00:03.000Z",
        message: { role: "user", content: "/review-pr 99" },
      },
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:04.000Z",
        message: {
          role: "assistant",
          id: "msg_ms2",
          content: [
            { type: "tool_use", id: "toolu_ms2", name: "Skill", input: { skill: "review-pr", args: "99" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "user",
        timestamp: "2025-07-01T10:00:05.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_ms2", content: "ok" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:06.000Z",
        message: {
          role: "assistant",
          id: "msg_ms3",
          content: [
            { type: "tool_use", id: "toolu_ms3", name: "Skill", input: { skill: "pdf" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.skills).toHaveLength(3);
    expect(result.skills[0].skill_name).toBe("commit");
    expect(result.skills[0].invoked_by).toBe("user");
    expect(result.skills[1].skill_name).toBe("review-pr");
    expect(result.skills[1].invoked_by).toBe("user");
    expect(result.skills[2].skill_name).toBe("pdf");
    expect(result.skills[2].invoked_by).toBe("claude"); // no /pdf in preceding user message
  });
});

// ---------------------------------------------------------------------------
// 4. Worktree extraction
// ---------------------------------------------------------------------------

describe("transcript parser: worktree extraction", () => {
  test("EnterWorktree tool call produces ParsedWorktree with name", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_wt",
          content: [
            {
              type: "tool_use",
              id: "toolu_wt",
              name: "EnterWorktree",
              input: { name: "feature-branch" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0].worktree_name).toBe("feature-branch");
  });

  test("multiple worktree creations produce separate entries", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_mw1",
          content: [
            { type: "tool_use", id: "toolu_mw1", name: "EnterWorktree", input: { name: "wt-alpha" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:02.000Z",
        message: {
          role: "assistant",
          id: "msg_mw2",
          content: [
            { type: "tool_use", id: "toolu_mw2", name: "EnterWorktree", input: { name: "wt-beta" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees[0].worktree_name).toBe("wt-alpha");
    expect(result.worktrees[1].worktree_name).toBe("wt-beta");
  });
});

// ---------------------------------------------------------------------------
// 5. Backward compatibility — old transcript format
// ---------------------------------------------------------------------------

describe("transcript parser: backward compatibility", () => {
  test("old-style transcript with no new features returns empty relationship arrays", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-plain.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_plain1", input);

    // All relationship arrays should be empty
    expect(result.subagents).toHaveLength(0);
    expect(result.teams).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.worktrees).toHaveLength(0);
    expect(result.permission_mode).toBeUndefined();

    // Basic parsing should still work
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.contentBlocks.length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);

    // Stats should be computed normally
    expect(result.stats.total_messages).toBeGreaterThan(0);
    expect(result.stats.subagent_count).toBe(0);
  });

  test("empty transcript returns empty relationship arrays with no errors", async () => {
    const result = await parseTranscript("sess_empty", "");

    expect(result.subagents).toHaveLength(0);
    expect(result.teams).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.worktrees).toHaveLength(0);
    expect(result.permission_mode).toBeUndefined();
    expect(result.errors).toHaveLength(0);
  });

  test("transcript with only Read/Edit/Bash tools has no relationships", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: { role: "user", content: "Read the file" },
      },
      {
        type: "assistant",
        timestamp: "2025-07-01T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_rw",
          content: [
            { type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "x.ts" } },
            { type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "ls" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.subagents).toHaveLength(0);
    expect(result.teams).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.worktrees).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Fixture integration — combined features
// ---------------------------------------------------------------------------

describe("transcript parser: fixture integration", () => {
  test("subagents fixture: metadata and stats are correct", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-with-subagents.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_sub1", input);

    // Metadata from first line
    expect(result.metadata.sessionId).toBe("sess_sub1");
    expect(result.metadata.cwd).toBe("/home/dev/project");
    expect(result.metadata.gitBranch).toBe("feat/agents");
    expect(result.metadata.version).toBe("1.2.0");

    // Duration: 10:00:00 to 10:00:17 = 17 seconds
    expect(result.stats.duration_ms).toBe(17_000);

    // No errors
    expect(result.errors).toHaveLength(0);
  });

  test("team fixture: no subagents or skills or worktrees", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-with-team.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_team1", input);

    expect(result.subagents).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.worktrees).toHaveLength(0);
    expect(result.teams).toHaveLength(1);
  });

  test("skills fixture: no subagents or teams or worktrees", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-with-skills.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_skill1", input);

    expect(result.subagents).toHaveLength(0);
    expect(result.teams).toHaveLength(0);
    expect(result.worktrees).toHaveLength(0);
    expect(result.skills).toHaveLength(2);
  });

  test("plain fixture: all relationship arrays empty", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "transcript-plain.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");
    const result = await parseTranscript("sess_plain1", input);

    expect(result.subagents).toHaveLength(0);
    expect(result.teams).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
    expect(result.worktrees).toHaveLength(0);

    // But messages and stats are normal
    expect(result.stats.total_messages).toBe(6); // 3 user + 3 assistant
    expect(result.stats.initial_prompt).toBe("Fix the typo in README.md");
  });
});
