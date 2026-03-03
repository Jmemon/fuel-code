# Backfill Error Enrichment & Retry Guidance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the minimal backfill error block with categorized errors, full transcript paths, and a retry instruction line.

**Architecture:** Three pure helper functions (`categorizeError`, `shortenPath`, `formatErrorBlock`) are added and exported from `backfill.ts`. A `sessionPathMap` is built from `scanResult.discovered` before ingestion starts. The existing error display block is replaced with a single `formatErrorBlock` call. Zero changes to `@fuel-code/core`.

**Tech Stack:** TypeScript, bun test (bun:test), Commander CLI

---

## Output Format Reference

Before writing any code, internalize the target output. This is what the terminal should show when errors exist:

```
Errors (3):
  [network]  ~/.claude/projects/-Users-john-Desktop-myproject/01abc123-def4-5678-ghij-klmnopqrstuv.jsonl
             fetch failed

  [auth]     ~/.claude/projects/-Users-john-Desktop-other/02def456-789a-bcde-fghi-jklmnopqrstuv.jsonl
             401 Unauthorized

  [file]     ~/.claude/projects/-Users-john-Desktop-repo/03ghi789-abcd-ef01-2345-678901234567.jsonl
             ENOENT: no such file or directory

To retry failed sessions: fuel-code backfill
```

Key formatting rules:
- Category label is always **9 chars wide**, padded with trailing spaces (e.g. `[auth]   `)
- Line prefix is `"  "` (2 spaces) + 9-char label + `"  "` (2 spaces) = 13 chars total before the path
- Error message line uses **13 spaces** of indentation to align under the path
- Blank line between consecutive error entries (not before the first, not after the last before overflow)
- Overflow line: `  ... and N more`
- Retry instruction always appears at the very end when there are any errors
- The whole block is returned as a **single string** from `formatErrorBlock` and passed to one `console.log` call

---

## Task 1: Add and test `categorizeError`

**Files:**
- Modify: `packages/cli/src/commands/backfill.ts`
- Test: `packages/cli/src/commands/__tests__/backfill.test.ts`

### Step 1: Add the failing tests

Open `packages/cli/src/commands/__tests__/backfill.test.ts`.

Add a new import at the top alongside the existing `runBackfill` import:

```ts
import { runBackfill, categorizeError } from "../backfill.js";
```

Then add this describe block at the bottom of the file (after the existing `describe("fuel-code backfill", ...)` block):

```ts
describe("categorizeError", () => {
  it("classifies fetch-failed network errors", () => {
    expect(categorizeError("fetch failed")).toBe("[network]");
    expect(categorizeError("ECONNREFUSED localhost:3000")).toBe("[network]");
    expect(categorizeError("socket hang up")).toBe("[network]");
  });

  it("classifies auth errors", () => {
    expect(categorizeError("401 Unauthorized")).toBe("[auth]");
    expect(categorizeError("403 Forbidden")).toBe("[auth]");
    expect(categorizeError("Unauthorized")).toBe("[auth]");
  });

  it("classifies payload-too-large errors", () => {
    expect(categorizeError("413 Payload Too Large")).toBe("[payload]");
    expect(categorizeError("request entity too large")).toBe("[payload]");
  });

  it("classifies server errors", () => {
    expect(categorizeError("500 Internal Server Error")).toBe("[server]");
    expect(categorizeError("502 Bad Gateway")).toBe("[server]");
    expect(categorizeError("503 Service Unavailable")).toBe("[server]");
  });

  it("classifies timeout/abort errors", () => {
    expect(categorizeError("TimeoutError: operation timed out")).toBe("[timeout]");
    expect(categorizeError("AbortError: signal aborted")).toBe("[timeout]");
    expect(categorizeError("request timed out")).toBe("[timeout]");
  });

  it("classifies file system errors", () => {
    expect(categorizeError("ENOENT: no such file or directory")).toBe("[file]");
    expect(categorizeError("EACCES: permission denied")).toBe("[file]");
    expect(categorizeError("EPERM: operation not permitted")).toBe("[file]");
  });

  it("classifies parse errors", () => {
    expect(categorizeError("SyntaxError: Unexpected token")).toBe("[parse]");
    expect(categorizeError("JSON parse error at line 3")).toBe("[parse]");
    expect(categorizeError("invalid JSON")).toBe("[parse]");
  });

  it("falls back to [error] for unrecognized messages", () => {
    expect(categorizeError("something completely unexpected")).toBe("[error]");
    expect(categorizeError("")).toBe("[error]");
  });
});
```

### Step 2: Run to confirm the tests fail

```
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```

Expected: all `categorizeError` tests fail with `categorizeError is not a function` or import error.

### Step 3: Implement `categorizeError` in `backfill.ts`

Add this function near the bottom of `backfill.ts`, just before the closing of the file (after `formatBytes`). Mark it `export` so tests can import it directly:

```ts
/**
 * Classify a raw exception message into a human-readable error category label.
 *
 * Labels are always exactly 9 characters (including brackets) so they can be
 * padded uniformly in the error block display. Patterns are checked in order;
 * the first match wins.
 */
export function categorizeError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("econnrefused") || m.includes("fetch failed") || m.includes("socket") || m.includes("etimedout")) return "[network]";
  if (m.includes("401") || m.includes("unauthorized") || m.includes("403") || m.includes("forbidden")) return "[auth]";
  if (m.includes("413") || m.includes("payload too large") || m.includes("request entity too large")) return "[payload]";
  if (m.includes("500") || m.includes("502") || m.includes("503") || m.includes("504") || m.includes("internal server error")) return "[server]";
  if (m.includes("timeouterror") || m.includes("aborterror") || m.includes("timed out") || m.includes("timeout")) return "[timeout]";
  if (m.includes("enoent") || m.includes("eacces") || m.includes("eperm") || m.includes("no such file")) return "[file]";
  if (m.includes("syntaxerror") || m.includes("json") || m.includes("parse") || m.includes("invalid")) return "[parse]";
  return "[error]";
}
```

### Step 4: Run tests to confirm they pass

```
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```

Expected: all `categorizeError` tests pass.

---

## Task 2: Add and test `shortenPath`

**Files:**
- Modify: `packages/cli/src/commands/backfill.ts`
- Test: `packages/cli/src/commands/__tests__/backfill.test.ts`

### Step 1: Add the failing tests

Add this describe block at the bottom of the test file:

```ts
describe("shortenPath", () => {
  it("replaces the home directory prefix with ~", () => {
    const home = os.homedir();
    expect(shortenPath(`${home}/Desktop/my-project/file.jsonl`))
      .toBe(`~/Desktop/my-project/file.jsonl`);
  });

  it("leaves paths outside home unchanged", () => {
    expect(shortenPath("/tmp/some/path.jsonl")).toBe("/tmp/some/path.jsonl");
  });

  it("handles exact home directory itself", () => {
    const home = os.homedir();
    expect(shortenPath(home)).toBe("~");
  });
});
```

Add `import * as os from "node:os";` to the test file's imports if it isn't already there (check — the existing `backfill.test.ts` doesn't import `os` but the test needs it for `os.homedir()`).

Also update the `runBackfill` import line to include `shortenPath`:

```ts
import { runBackfill, categorizeError, shortenPath } from "../backfill.js";
```

### Step 2: Run to confirm the tests fail

```
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```

Expected: `shortenPath` tests fail with import error.

### Step 3: Implement `shortenPath` in `backfill.ts`

Add this function after `categorizeError`:

```ts
/**
 * Replace the home directory prefix in a path with "~" for compact display.
 * Paths outside the home directory are returned unchanged.
 */
export function shortenPath(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}
```

Note: `os` and `path` are already imported at the top of `backfill.ts`.

### Step 4: Run tests to confirm they pass

```
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```

Expected: all `shortenPath` tests pass alongside the existing tests.

---

## Task 3: Add and test `formatErrorBlock`

This is the core display function. It composes `categorizeError` and `shortenPath` into the final multi-line string.

**Files:**
- Modify: `packages/cli/src/commands/backfill.ts`
- Test: `packages/cli/src/commands/__tests__/backfill.test.ts`

### Step 1: Add the failing tests

Update the import line to include `formatErrorBlock`:

```ts
import { runBackfill, categorizeError, shortenPath, formatErrorBlock } from "../backfill.js";
```

Add this describe block at the bottom of the test file:

```ts
describe("formatErrorBlock", () => {
  const INDENT = " ".repeat(13); // 2 + 9 (padded label) + 2

  it("formats a single network error with path and retry instruction", () => {
    const errors = [
      { sessionId: "aaa-111", error: "fetch failed" },
    ];
    const pathMap = new Map([
      ["aaa-111", "/home/user/.claude/projects/-Users-user-Desktop-proj/aaa-111.jsonl"],
    ]);
    const result = formatErrorBlock(errors, pathMap);

    expect(result).toContain("Errors (1):");
    expect(result).toContain("[network]");
    expect(result).toContain("aaa-111.jsonl");
    expect(result).toContain(`${INDENT}fetch failed`);
    expect(result).toContain("To retry failed sessions: fuel-code backfill");
  });

  it("formats multiple errors with blank lines between entries", () => {
    const errors = [
      { sessionId: "aaa-111", error: "fetch failed" },
      { sessionId: "bbb-222", error: "401 Unauthorized" },
    ];
    const pathMap = new Map([
      ["aaa-111", "/home/user/.claude/projects/proj/aaa-111.jsonl"],
      ["bbb-222", "/home/user/.claude/projects/proj/bbb-222.jsonl"],
    ]);
    const result = formatErrorBlock(errors, pathMap);

    expect(result).toContain("Errors (2):");
    expect(result).toContain("[network]");
    expect(result).toContain("[auth]   "); // padded to 9 chars
    // Blank line between the two entries
    expect(result).toMatch(/aaa-111\.jsonl[\s\S]*\n\n[\s\S]*bbb-222\.jsonl/);
  });

  it("pads all category labels to 9 characters", () => {
    const errors = [
      { sessionId: "aaa", error: "fetch failed" },    // [network] = 9
      { sessionId: "bbb", error: "401 Unauthorized" }, // [auth]    = 6 → needs 3 padding
      { sessionId: "ccc", error: "ENOENT: no such file" }, // [file] = 6 → needs 3 padding
    ];
    const pathMap = new Map([
      ["aaa", "/tmp/aaa.jsonl"],
      ["bbb", "/tmp/bbb.jsonl"],
      ["ccc", "/tmp/ccc.jsonl"],
    ]);
    const result = formatErrorBlock(errors, pathMap);
    expect(result).toContain("[network]  "); // 9 + 2 spaces gap
    expect(result).toContain("[auth]     "); // 6 + 3 pad + 2 spaces gap = 9+2
    expect(result).toContain("[file]     "); // 6 + 3 pad + 2 spaces gap
  });

  it("shows overflow line when errors exceed limit", () => {
    const errors = Array.from({ length: 25 }, (_, i) => ({
      sessionId: `s-${i}`,
      error: "fetch failed",
    }));
    const pathMap = new Map(errors.map(e => [e.sessionId, `/tmp/${e.sessionId}.jsonl`]));

    const result = formatErrorBlock(errors, pathMap, 20);
    expect(result).toContain("Errors (25):");
    expect(result).toContain("... and 5 more");
    expect(result).toContain("To retry failed sessions: fuel-code backfill");
  });

  it("falls back gracefully when sessionId is not in pathMap", () => {
    const errors = [{ sessionId: "unknown-xyz", error: "fetch failed" }];
    const pathMap = new Map<string, string>(); // empty — no path for this session

    const result = formatErrorBlock(errors, pathMap);
    expect(result).toContain("[network]");
    expect(result).toContain("unknown-xyz"); // falls back to showing the session ID
    expect(result).toContain("fetch failed");
  });
});
```

### Step 2: Run to confirm the tests fail

```
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```

Expected: `formatErrorBlock` tests fail with import error.

### Step 3: Implement `formatErrorBlock` in `backfill.ts`

Add this function after `shortenPath`:

```ts
/**
 * Format the full error block displayed at the end of a backfill run.
 *
 * Each error entry spans two lines:
 *   "  [category]  <transcript-path>"
 *   "             <raw error message>"
 *
 * Category labels are padded to 9 characters so path columns align regardless
 * of which category fired. Blank lines separate consecutive entries for
 * scannability. A retry instruction is always appended.
 *
 * @param errors    - Array of {sessionId, error} from BackfillResult
 * @param pathMap   - Map from sessionId → transcript file path (built from ScanResult)
 * @param limit     - Maximum number of errors to display in full (default: 20)
 */
export function formatErrorBlock(
  errors: Array<{ sessionId: string; error: string }>,
  pathMap: Map<string, string>,
  limit = 20,
): string {
  // 2 spaces + 9-char padded label + 2 spaces = 13 chars before the path/error text
  const LABEL_WIDTH = 9;
  const PREFIX = " ".repeat(2);
  const GAP = " ".repeat(2);
  const INDENT = " ".repeat(PREFIX.length + LABEL_WIDTH + GAP.length);

  const lines: string[] = [`Errors (${errors.length}):`];
  const shown = errors.slice(0, limit);

  for (let i = 0; i < shown.length; i++) {
    const err = shown[i];
    // Blank line between entries (not before the first)
    if (i > 0) lines.push("");

    const label = categorizeError(err.error).padEnd(LABEL_WIDTH);
    const rawPath = pathMap.get(err.sessionId);
    const displayPath = rawPath
      ? shortenPath(rawPath)
      : `(session ${err.sessionId})`;

    lines.push(`${PREFIX}${label}${GAP}${displayPath}`);
    lines.push(`${INDENT}${err.error}`);
  }

  if (errors.length > limit) {
    lines.push("");
    lines.push(`  ... and ${errors.length - limit} more`);
  }

  lines.push("");
  lines.push("To retry failed sessions: fuel-code backfill");

  return lines.join("\n");
}
```

### Step 4: Run tests to confirm they pass

```
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)"
```

Expected: all `formatErrorBlock` tests pass.

### Step 5: Commit the three helpers

```
git add packages/cli/src/commands/backfill.ts packages/cli/src/commands/__tests__/backfill.test.ts
git commit -m "feat(backfill): add categorizeError, shortenPath, formatErrorBlock helpers"
```

---

## Task 4: Wire `formatErrorBlock` into `runBackfill`

**Files:**
- Modify: `packages/cli/src/commands/backfill.ts` (the `runBackfill` function only)

### Step 1: Build `sessionPathMap` after the scan phase

In `runBackfill`, locate the line right after `scanForSessions` returns (around line 141 — where the scan result is first used). Add the map construction immediately after the scan result is confirmed non-empty:

The existing code at that point looks like:
```ts
  if (scanResult.discovered.length === 0) {
    process.removeListener("SIGINT", onSigint);
    console.log("No historical sessions found.");
    return;
  }

  // Group sessions by project for summary display
  const byProject = groupByProject(scanResult.discovered);
```

Insert the map build right after the early-exit guard:

```ts
  if (scanResult.discovered.length === 0) {
    process.removeListener("SIGINT", onSigint);
    console.log("No historical sessions found.");
    return;
  }

  // Build a lookup map from sessionId → transcriptPath for error display
  const sessionPathMap = new Map(
    scanResult.discovered.map(s => [s.sessionId, s.transcriptPath])
  );

  // Group sessions by project for summary display
  const byProject = groupByProject(scanResult.discovered);
```

### Step 2: Replace the existing error display block

Locate the existing error block (around lines 310–319):

```ts
    // Show errors at the end with full detail
    if (result.errors.length > 0) {
      console.log("");
      console.log(`Errors (${result.errors.length}):`);
      for (const err of result.errors.slice(0, 20)) {
        console.log(`  ${err.sessionId.slice(0, 8)}  ${err.error}`);
      }
      if (result.errors.length > 20) {
        console.log(`  ... and ${result.errors.length - 20} more`);
      }
    }
```

Replace it entirely with:

```ts
    // Show errors at the end with full detail: category, transcript path, error message, retry hint
    if (result.errors.length > 0) {
      console.log("");
      console.log(formatErrorBlock(result.errors, sessionPathMap));
    }
```

### Step 3: Run the full CLI test suite

```
bun test packages/cli/src/commands/__tests__/backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"
```

Expected: all tests pass. No regressions.

### Step 4: Run the full package test suite to catch any cross-package issues

```
bun test packages/cli 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

Expected: all tests pass.

### Step 5: Commit the wiring

```
git add packages/cli/src/commands/backfill.ts
git commit -m "feat(backfill): show error category, transcript path, and retry instruction"
```

---

## Final verification checklist

Before declaring done:

- [ ] `categorizeError` has a test for each category label and the `[error]` fallback
- [ ] `shortenPath` has tests for home-dir, non-home, and exact-home-dir cases
- [ ] `formatErrorBlock` has tests for: single error, multiple errors (blank line between), label padding, overflow, and missing-path fallback
- [ ] The existing `--status`, `--dry-run`, and concurrent-run-guard tests still pass
- [ ] No changes to any file in `packages/core/` or `packages/server/`
- [ ] Two commits: one for helpers, one for wiring
