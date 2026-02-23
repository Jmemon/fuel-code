/**
 * Tests for the `fuel-code hooks` command group.
 *
 * Uses temp directories to mock ~/.claude/settings.json — never writes to the
 * real ~/.claude/ directory. Tests verify:
 *   - `hooks install` creates/updates settings.json with correct structure
 *   - Running install twice is idempotent (no duplicate hook entries)
 *   - Existing non-fuel-code hooks are preserved during install
 *   - `hooks status` correctly reports installed/not-installed state
 *   - Missing ~/.claude/ directory is created by install
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { overrideSettingsPath, overrideCliCommand, runInstall, runStatus } from "../hooks.js";

// ---------------------------------------------------------------------------
// Test setup/teardown — each test gets a fresh temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let settingsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-hooks-test-"));
  // Put the fake settings.json inside a .claude subdirectory (mimics real layout)
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  settingsPath = path.join(claudeDir, "settings.json");
  overrideSettingsPath(settingsPath);
  // Use a stable CLI command so tests don't depend on PATH or process.argv
  overrideCliCommand("fuel-code");
});

afterEach(() => {
  overrideSettingsPath(undefined);
  overrideCliCommand(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: read settings.json back from disk
// ---------------------------------------------------------------------------

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
}

// ---------------------------------------------------------------------------
// Helper: capture console.log output
// ---------------------------------------------------------------------------

function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return fn().then(() => {
    console.log = origLog;
    return lines;
  }).catch((err) => {
    console.log = origLog;
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Tests: hooks install
// ---------------------------------------------------------------------------

describe("hooks install", () => {
  it("creates settings.json when it does not exist", async () => {
    // Remove the file so install has to create it
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }

    await runInstall();

    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = readSettings();
    expect(settings.hooks).toBeDefined();
  });

  it("creates settings.json with SessionStart and SessionEnd hooks", async () => {
    await runInstall();

    const settings = readSettings() as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
    };

    // SessionStart should exist with cc-hook inline command
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].matcher).toBe("");
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].type).toBe("command");
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      "cc-hook session-start",
    );

    // SessionEnd should exist with cc-hook inline command
    expect(settings.hooks.SessionEnd).toBeDefined();
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toContain(
      "cc-hook session-end",
    );
  });

  it("is idempotent — running twice does not duplicate hooks", async () => {
    await runInstall();
    await runInstall();

    const settings = readSettings() as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
    };

    // Should still be exactly 1 config block with 1 hook for each event
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(1);

    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].hooks).toHaveLength(1);
  });

  it("preserves existing non-fuel-code hooks", async () => {
    // Pre-populate settings.json with another tool's hook
    const existingSettings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "/usr/local/bin/other-tool-hook.sh",
              },
            ],
          },
        ],
      },
      someOtherSetting: true,
    };
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(existingSettings, null, 2),
      "utf-8",
    );

    await runInstall();

    const settings = readSettings() as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
      someOtherSetting: boolean;
    };

    // The other tool's hook should still be there
    const sessionStartHooks = settings.hooks.SessionStart[0].hooks;
    const otherHook = sessionStartHooks.find(
      (h) => h.command === "/usr/local/bin/other-tool-hook.sh",
    );
    expect(otherHook).toBeDefined();

    // And our hook should be added too
    const fuelCodeHook = sessionStartHooks.find((h) =>
      h.command.includes("cc-hook session-start"),
    );
    expect(fuelCodeHook).toBeDefined();

    // Other settings should be preserved
    expect(settings.someOtherSetting).toBe(true);
  });

  it("creates missing .claude directory", async () => {
    // Point settings to a directory that doesn't exist yet
    const deepPath = path.join(tmpDir, "nonexistent", ".claude", "settings.json");
    overrideSettingsPath(deepPath);

    await runInstall();

    expect(fs.existsSync(deepPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(deepPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
  });

  it("removes stale Stop hook from pre-migration installs", async () => {
    // Pre-populate settings.json with a Stop hook (old format used before SessionEnd)
    const existingSettings = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "fuel-code cc-hook session-end",
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(existingSettings, null, 2),
      "utf-8",
    );

    await runInstall();

    const settings = readSettings() as {
      hooks: Record<string, unknown>;
    };

    // Stop hook should be completely removed
    expect(settings.hooks.Stop).toBeUndefined();

    // SessionStart and SessionEnd should be present instead
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
  });

  it("replaces existing fuel-code hook with updated command", async () => {
    // Pre-populate with an old fuel-code hook (shell script path format)
    const existingSettings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "/old/path/to/fuel-code/hooks/claude/SessionStart.sh",
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(existingSettings, null, 2),
      "utf-8",
    );

    await runInstall();

    const settings = readSettings() as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
    };

    // Should still have exactly 1 hook (replaced, not appended)
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(1);
    // Old shell script path should be gone, replaced with cc-hook command
    expect(settings.hooks.SessionStart[0].hooks[0].command).not.toContain(
      "/old/path/",
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      "cc-hook session-start",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: hooks status
// ---------------------------------------------------------------------------

describe("hooks status", () => {
  it("reports not installed when settings.json does not exist", async () => {
    // Remove settings file
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }

    const lines = await captureConsoleLog(async () => {
      await runStatus();
    });

    const output = lines.join("\n");
    // CC hooks should show "not installed" when settings.json is missing
    expect(output).toContain("not installed");
  });

  it("reports installed after hooks install", async () => {
    await runInstall();

    const lines = await captureConsoleLog(async () => {
      await runStatus();
    });

    const output = lines.join("\n");
    expect(output).toContain("SessionStart:");
    expect(output).toContain("SessionEnd:");
    // The CC hooks section should show "installed" for both CC hooks.
    // Git hooks section may show "not installed" since we only installed CC hooks.
    // Check that SessionStart and SessionEnd lines specifically say "installed" (not "not installed")
    const ccLines = output.split("\n").filter(
      (l) => l.includes("SessionStart:") || l.includes("SessionEnd:"),
    );
    expect(ccLines).toHaveLength(2);
    for (const line of ccLines) {
      expect(line).toContain("installed");
      expect(line).not.toContain("not installed");
    }
  });

  it("reports not installed when settings.json has no hooks", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({}), "utf-8");

    const lines = await captureConsoleLog(async () => {
      await runStatus();
    });

    const output = lines.join("\n");
    expect(output).toContain("not installed");
  });
});
