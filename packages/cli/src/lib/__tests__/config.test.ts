/**
 * Tests for the config management module.
 *
 * All tests use a temporary directory (cleaned up via afterEach) to avoid
 * touching the real ~/.fuel-code/ directory. The `overrideConfigPaths()`
 * function redirects all path lookups to the temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ConfigError } from "@fuel-code/shared";
import {
  configExists,
  loadConfig,
  saveConfig,
  ensureDirectories,
  overrideConfigPaths,
  getConfigPath,
  getConfigDir,
  getQueueDir,
  getDeadLetterDir,
  type FuelCodeConfig,
} from "../config.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A valid config object for testing round-trip serialization */
function makeValidConfig(): FuelCodeConfig {
  return {
    backend: {
      url: "http://localhost:3000",
      api_key: "test-api-key-12345",
    },
    device: {
      id: "01HZTEST00000000000000TEST",
      name: "test-device",
      type: "local",
    },
    pipeline: {
      queue_path: "/tmp/fuel-code-test/queue",
      drain_interval_seconds: 10,
      batch_size: 50,
      post_timeout_ms: 5000,
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup/teardown — temp directory per test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  // Create a unique temp directory for each test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-test-"));
  overrideConfigPaths(tmpDir);
});

afterEach(() => {
  // Reset path overrides back to real paths
  overrideConfigPaths(undefined);
  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("configExists", () => {
  it("returns false when config file does not exist", () => {
    expect(configExists()).toBe(false);
  });

  it("returns true when config file exists", () => {
    const config = makeValidConfig();
    ensureDirectories();
    saveConfig(config);
    expect(configExists()).toBe(true);
  });
});

describe("loadConfig", () => {
  it("throws ConfigError with CONFIG_NOT_FOUND when file does not exist", () => {
    try {
      loadConfig();
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_NOT_FOUND");
    }
  });

  it("throws ConfigError with CONFIG_CORRUPTED for invalid YAML", () => {
    // Write something that isn't valid YAML (unbalanced quotes, tab-indented
    // mapping key in a flow context — causes a YAML parse error)
    ensureDirectories();
    fs.writeFileSync(getConfigPath(), "{{{{not yaml at all: [\x00\x01", "utf-8");

    try {
      loadConfig();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_CORRUPTED");
    }
  });

  it("throws ConfigError with CONFIG_INVALID for YAML that fails schema validation", () => {
    // Valid YAML but missing required fields
    ensureDirectories();
    fs.writeFileSync(
      getConfigPath(),
      "backend:\n  url: http://localhost\n",
      "utf-8",
    );

    try {
      loadConfig();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_INVALID");
    }
  });
});

describe("saveConfig + loadConfig round-trip", () => {
  it("writes and reads back the same config values", () => {
    const config = makeValidConfig();
    ensureDirectories();
    saveConfig(config);
    const loaded = loadConfig();

    expect(loaded.backend.url).toBe(config.backend.url);
    expect(loaded.backend.api_key).toBe(config.backend.api_key);
    expect(loaded.device.id).toBe(config.device.id);
    expect(loaded.device.name).toBe(config.device.name);
    expect(loaded.device.type).toBe(config.device.type);
    expect(loaded.pipeline.queue_path).toBe(config.pipeline.queue_path);
    expect(loaded.pipeline.drain_interval_seconds).toBe(
      config.pipeline.drain_interval_seconds,
    );
    expect(loaded.pipeline.batch_size).toBe(config.pipeline.batch_size);
    expect(loaded.pipeline.post_timeout_ms).toBe(config.pipeline.post_timeout_ms);
  });

  it("preserves device type 'remote'", () => {
    const config = makeValidConfig();
    config.device.type = "remote";
    ensureDirectories();
    saveConfig(config);
    const loaded = loadConfig();
    expect(loaded.device.type).toBe("remote");
  });
});

describe("saveConfig", () => {
  it("creates parent directories if they do not exist", () => {
    // overrideConfigPaths already points to tmpDir, but saveConfig should
    // create the dir if it doesn't exist (the override dir exists from mkdtemp,
    // so let's point to a nested path to truly test mkdir)
    const nestedDir = path.join(tmpDir, "nested", "deep");
    overrideConfigPaths(nestedDir);

    const config = makeValidConfig();
    saveConfig(config);

    // Verify the config file was created inside the nested directory
    expect(fs.existsSync(path.join(nestedDir, "config.yaml"))).toBe(true);

    // Verify round-trip
    const loaded = loadConfig();
    expect(loaded.device.id).toBe(config.device.id);
  });

  it("sets restrictive file permissions (0o600)", () => {
    const config = makeValidConfig();
    ensureDirectories();
    saveConfig(config);

    const stat = fs.statSync(getConfigPath());
    // Check owner-only read+write (0o600). The mode includes the file type bits,
    // so mask with 0o777 to get just the permission bits.
    const permissions = stat.mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it("overwrites existing config atomically", () => {
    ensureDirectories();

    // Write initial config
    const config1 = makeValidConfig();
    config1.device.name = "first-device";
    saveConfig(config1);

    // Overwrite with different config
    const config2 = makeValidConfig();
    config2.device.name = "second-device";
    saveConfig(config2);

    // Verify the second config is what we read back
    const loaded = loadConfig();
    expect(loaded.device.name).toBe("second-device");
  });
});

describe("ensureDirectories", () => {
  it("creates all required directories", () => {
    ensureDirectories();

    expect(fs.existsSync(getConfigDir())).toBe(true);
    expect(fs.existsSync(getQueueDir())).toBe(true);
    expect(fs.existsSync(getDeadLetterDir())).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    ensureDirectories();
    ensureDirectories(); // Should not throw
    expect(fs.existsSync(getConfigDir())).toBe(true);
  });
});
