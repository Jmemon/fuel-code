/**
 * Unit tests for the 8 design system primitives.
 *
 * Uses ink-testing-library's render() + lastFrame() to capture component
 * output and assert on text content. Components that depend on useStdout()
 * (Panel, Divider) receive explicit width/columns props to avoid relying
 * on a real terminal in the test environment.
 *
 * 35 tests across: theme, Panel, Badge, Divider, KeyHint, Sparkline,
 * BarChart, ScrollIndicator.
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { theme } from "../theme.js";
import { Panel } from "../Panel.js";
import { Badge } from "../Badge.js";
import { Divider } from "../Divider.js";
import { KeyHint } from "../KeyHint.js";
import { Sparkline } from "../Sparkline.js";
import { BarChart } from "../BarChart.js";
import { ScrollIndicator } from "../ScrollIndicator.js";
import { Text } from "ink";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes for content assertions */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ---------------------------------------------------------------------------
// Theme tests
// ---------------------------------------------------------------------------

describe("theme", () => {
  test("1. has all 7 expected color keys", () => {
    const expectedKeys = ["accent", "success", "warning", "error", "info", "muted", "live"];
    for (const key of expectedKeys) {
      expect(theme).toHaveProperty(key);
    }
    expect(Object.keys(theme)).toHaveLength(7);
  });

  test("2. all theme values are valid Ink color strings", () => {
    // Ink supports named colors (like chalk), hex, rgb, etc.
    // Our theme uses named color strings; verify they are non-empty strings.
    const validInkColors = new Set([
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "gray", "grey", "redBright", "greenBright", "yellowBright", "blueBright",
      "magentaBright", "cyanBright", "whiteBright",
    ]);

    for (const [key, value] of Object.entries(theme)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      expect(validInkColors.has(value)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Panel tests
// ---------------------------------------------------------------------------

describe("Panel", () => {
  test("3. renders rounded corners with no title", () => {
    const { lastFrame } = render(
      <Panel columns={40}><Text>content</Text></Panel>,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("╭");
    expect(output).toContain("╮");
    expect(output).toContain("╰");
    expect(output).toContain("╯");
  });

  test("4. includes title in top border", () => {
    const { lastFrame } = render(
      <Panel title="TEST" columns={40}><Text>body</Text></Panel>,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("TEST");
    // Title should be on the top border line alongside ╭
    const lines = output.split("\n");
    const topLine = lines[0];
    expect(topLine).toContain("╭");
    expect(topLine).toContain("TEST");
    expect(topLine).toContain("╮");
  });

  test("5. focused={true} renders without error", () => {
    const { lastFrame } = render(
      <Panel focused={true} columns={30}><Text>focused</Text></Panel>,
    );
    expect(lastFrame()).toBeTruthy();
  });

  test("6. focused={false} renders without error", () => {
    const { lastFrame } = render(
      <Panel focused={false} columns={30}><Text>not focused</Text></Panel>,
    );
    expect(lastFrame()).toBeTruthy();
  });

  test("7. renders children text between side borders", () => {
    const { lastFrame } = render(
      <Panel columns={40}><Text>Hello World</Text></Panel>,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("Hello World");
    // Children should appear on a line with vertical border chars
    const lines = output.split("\n");
    const contentLine = lines.find((l) => l.includes("Hello World"));
    expect(contentLine).toBeTruthy();
    expect(contentLine).toContain("│");
  });

  test("8. very long title truncates without crash", () => {
    const longTitle = "A".repeat(200);
    const { lastFrame } = render(
      <Panel title={longTitle} columns={30}><Text>body</Text></Panel>,
    );
    const output = stripAnsi(lastFrame()!);
    // Should contain truncation ellipsis and still render valid borders
    expect(output).toContain("╭");
    expect(output).toContain("╮");
    expect(output).toContain("…");
  });

  test("9. empty children renders valid border box", () => {
    const { lastFrame } = render(
      <Panel columns={30}><Text>{""}</Text></Panel>,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("╭");
    expect(output).toContain("╯");
  });
});

// ---------------------------------------------------------------------------
// Badge tests
// ---------------------------------------------------------------------------

describe("Badge", () => {
  test("10. detected renders ● and LIVE", () => {
    const { lastFrame } = render(<Badge lifecycle="detected" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("●");
    expect(output).toContain("LIVE");
  });

  test("11. capturing renders ● and LIVE", () => {
    const { lastFrame } = render(<Badge lifecycle="capturing" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("●");
    expect(output).toContain("LIVE");
  });

  test("12. summarized renders ✓ and DONE", () => {
    const { lastFrame } = render(<Badge lifecycle="summarized" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("✓");
    expect(output).toContain("DONE");
  });

  test("13. failed renders ✗ and FAIL", () => {
    const { lastFrame } = render(<Badge lifecycle="failed" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("✗");
    expect(output).toContain("FAIL");
  });

  test("14. ended renders ◑ and ENDED", () => {
    const { lastFrame } = render(<Badge lifecycle="ended" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("◑");
    expect(output).toContain("ENDED");
  });

  test("15. archived renders ▪ and ARCH", () => {
    const { lastFrame } = render(<Badge lifecycle="archived" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("▪");
    expect(output).toContain("ARCH");
  });

  test("16. parsed renders ◌ and PARSING", () => {
    const { lastFrame } = render(<Badge lifecycle="parsed" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("◌");
    expect(output).toContain("PARSING");
  });

  test("17. unknown lifecycle renders ? and uppercased lifecycle", () => {
    const { lastFrame } = render(<Badge lifecycle="unknown_value" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("?");
    expect(output).toContain("UNKNOWN_VALUE");
  });

  test("18. compact={true} renders icon only, not label", () => {
    const { lastFrame } = render(<Badge lifecycle="summarized" compact={true} />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("✓");
    expect(output).not.toContain("DONE");
  });
});

// ---------------------------------------------------------------------------
// Divider tests
// ---------------------------------------------------------------------------

describe("Divider", () => {
  test("19. no title renders a line of ─ characters", () => {
    const { lastFrame } = render(<Divider width={20} />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("─");
    // Should be a continuous line of dashes
    const dashCount = (output.match(/─/g) || []).length;
    expect(dashCount).toBe(20);
  });

  test("20. with title renders TOOLS within ─ characters", () => {
    const { lastFrame } = render(<Divider title="TOOLS" width={30} />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("TOOLS");
    expect(output).toContain("─");
    // Dashes should appear on both sides of the title
    const idx = output.indexOf("TOOLS");
    const before = output.slice(0, idx);
    const after = output.slice(idx + "TOOLS".length);
    expect(before).toContain("─");
    expect(after).toContain("─");
  });
});

// ---------------------------------------------------------------------------
// KeyHint tests
// ---------------------------------------------------------------------------

describe("KeyHint", () => {
  test("21. renders all provided key/action pairs", () => {
    const hints = [
      { key: "j/k", action: "navigate" },
      { key: "enter", action: "select" },
      { key: "q", action: "quit" },
    ];
    const { lastFrame } = render(<KeyHint hints={hints} />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("j/k");
    expect(output).toContain("navigate");
    expect(output).toContain("enter");
    expect(output).toContain("select");
    expect(output).toContain("q");
    expect(output).toContain("quit");
  });

  test("22. extra='LIVE' includes LIVE in output", () => {
    const hints = [{ key: "q", action: "quit" }];
    const { lastFrame } = render(<KeyHint hints={hints} extra="LIVE" />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("LIVE");
  });

  test("23. empty hints array renders without crash", () => {
    const { lastFrame } = render(<KeyHint hints={[]} />);
    // Should render something (even if empty) without throwing
    expect(lastFrame()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sparkline tests
// ---------------------------------------------------------------------------

describe("Sparkline", () => {
  test("24. values=[0,4,8,4,0] renders 5 block characters", () => {
    const { lastFrame } = render(<Sparkline values={[0, 4, 8, 4, 0]} />);
    const output = stripAnsi(lastFrame()!);
    // Block chars: ▁▂▃▄▅▆▇█
    const blockPattern = /[▁▂▃▄▅▆▇█]/g;
    const blocks = output.match(blockPattern) || [];
    expect(blocks).toHaveLength(5);
  });

  test("25. empty values renders nothing (no crash)", () => {
    const { lastFrame } = render(<Sparkline values={[]} />);
    // Sparkline returns null for empty input, so lastFrame should be empty
    const output = lastFrame()!;
    expect(output).toBe("");
  });

  test("26. equal values [5,5,5] renders 3 identical middle-height blocks", () => {
    const { lastFrame } = render(<Sparkline values={[5, 5, 5]} />);
    const output = stripAnsi(lastFrame()!);
    // All same value -> middle block ▄ (index 3) repeated 3 times
    expect(output).toContain("▄▄▄");
  });

  test("27. width=3 with 6 values renders exactly 3 characters", () => {
    const { lastFrame } = render(
      <Sparkline values={[1, 2, 3, 4, 5, 6]} width={3} />,
    );
    const output = stripAnsi(lastFrame()!);
    const blockPattern = /[▁▂▃▄▅▆▇█]/g;
    const blocks = output.match(blockPattern) || [];
    expect(blocks).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// BarChart tests
// ---------------------------------------------------------------------------

describe("BarChart", () => {
  test("28. renders both labels with bars", () => {
    const items = [
      { label: "A", value: 10 },
      { label: "B", value: 5 },
    ];
    const { lastFrame } = render(<BarChart items={items} />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("A");
    expect(output).toContain("B");
    // Both should have bar characters (full block █)
    expect(output).toContain("█");
  });

  test("29. highest value item gets the longest bar", () => {
    const items = [
      { label: "A", value: 10 },
      { label: "B", value: 5 },
    ];
    const { lastFrame } = render(<BarChart items={items} />);
    const output = stripAnsi(lastFrame()!);
    const lines = output.split("\n");
    const lineA = lines.find((l) => stripAnsi(l).includes("A"))!;
    const lineB = lines.find((l) => stripAnsi(l).includes("B"))!;
    const countBlocks = (s: string) => (stripAnsi(s).match(/█/g) || []).length;
    expect(countBlocks(lineA)).toBeGreaterThan(countBlocks(lineB));
  });

  test("30. empty items renders nothing", () => {
    const { lastFrame } = render(<BarChart items={[]} />);
    const output = lastFrame()!;
    expect(output).toBe("");
  });

  test("31. maxItems=1 with 3 items only shows the first item", () => {
    const items = [
      { label: "First", value: 10 },
      { label: "Second", value: 5 },
      { label: "Third", value: 3 },
    ];
    const { lastFrame } = render(<BarChart items={items} maxItems={1} />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("First");
    expect(output).not.toContain("Second");
    expect(output).not.toContain("Third");
  });
});

// ---------------------------------------------------------------------------
// ScrollIndicator tests
// ---------------------------------------------------------------------------

describe("ScrollIndicator", () => {
  test("32. scrollOffset=0 renders track with thumb near top", () => {
    const { lastFrame } = render(
      <ScrollIndicator
        totalItems={20}
        visibleItems={5}
        scrollOffset={0}
        height={10}
      />,
    );
    const output = stripAnsi(lastFrame()!);
    // Should contain both thumb (█) and track (│) characters
    expect(output).toContain("█");
    expect(output).toContain("│");
    // Thumb should be at the top -- first line should contain █
    const lines = output.split("\n");
    expect(lines[0]).toContain("█");
  });

  test("33. scrollOffset at max places thumb near bottom", () => {
    const { lastFrame } = render(
      <ScrollIndicator
        totalItems={20}
        visibleItems={5}
        scrollOffset={15}  // max offset = totalItems - visibleItems = 15
        height={10}
      />,
    );
    const output = stripAnsi(lastFrame()!);
    const lines = output.split("\n").filter((l) => l.length > 0);
    // Last line should contain thumb
    expect(lines[lines.length - 1]).toContain("█");
    // First line should be track, not thumb
    expect(lines[0]).toContain("│");
  });

  test("34. totalItems <= visibleItems renders empty (no thumb)", () => {
    const { lastFrame } = render(
      <ScrollIndicator
        totalItems={5}
        visibleItems={10}
        scrollOffset={0}
        height={10}
      />,
    );
    // ScrollIndicator returns null when totalItems <= visibleItems
    const output = lastFrame()!;
    expect(output).toBe("");
  });

  test("35. totalItems=0 renders without crash", () => {
    const { lastFrame } = render(
      <ScrollIndicator
        totalItems={0}
        visibleItems={5}
        scrollOffset={0}
        height={10}
      />,
    );
    // Should return null (empty output) without crashing
    const output = lastFrame()!;
    expect(output).toBe("");
  });
});
