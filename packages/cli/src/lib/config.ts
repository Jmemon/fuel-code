/**
 * Configuration file management for fuel-code CLI.
 *
 * Manages the ~/.fuel-code/ directory structure and config.yaml file.
 * All config operations are synchronous for simplicity — config is read
 * once at startup and rarely written (only during `init` or `config set`).
 *
 * Directory layout:
 *   ~/.fuel-code/
 *     config.yaml       — device identity, backend URL, pipeline settings
 *     queue/            — pending events (JSON files) waiting to be drained
 *     dead-letter/      — events that failed delivery after retries
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Path constants — all fuel-code CLI state lives under ~/.fuel-code/
// ---------------------------------------------------------------------------

/** Root config directory under the user's home */
export const CONFIG_DIR = path.join(os.homedir(), ".fuel-code");

/** Path to the main YAML config file */
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml");

/** Directory for pending event queue files (JSON) */
export const QUEUE_DIR = path.join(CONFIG_DIR, "queue");

/** Directory for events that failed delivery after retries */
export const DEAD_LETTER_DIR = path.join(CONFIG_DIR, "dead-letter");

// ---------------------------------------------------------------------------
// Zod schema for config validation
// ---------------------------------------------------------------------------

/** Zod schema that validates the full config structure */
const FuelCodeConfigSchema = z.object({
  backend: z.object({
    /** URL of the fuel-code backend (e.g., https://api.fuel-code.dev) */
    url: z.string().min(1),
    /** Single API key for authentication */
    api_key: z.string().min(1),
  }),
  device: z.object({
    /** ULID identifying this device */
    id: z.string().min(1),
    /** Human-readable device name (typically hostname) */
    name: z.string().min(1).max(64),
    /** Whether this is a local machine or remote dev env */
    type: z.enum(["local", "remote"]),
  }),
  pipeline: z.object({
    /** Filesystem path where queued events are stored */
    queue_path: z.string().min(1),
    /** How often (seconds) the queue drainer runs */
    drain_interval_seconds: z.number().int().positive(),
    /** Max events per drain batch */
    batch_size: z.number().int().positive(),
    /** HTTP timeout (ms) for POST to backend */
    post_timeout_ms: z.number().int().positive(),
  }),
});

// ---------------------------------------------------------------------------
// TypeScript type derived from the schema
// ---------------------------------------------------------------------------

/**
 * Strongly-typed config structure. Matches the YAML layout 1:1.
 * Validated at load time via the Zod schema above.
 */
export type FuelCodeConfig = z.infer<typeof FuelCodeConfigSchema>;

// ---------------------------------------------------------------------------
// Internal helpers for testability — path overrides
// ---------------------------------------------------------------------------

/**
 * Mutable path overrides used by tests to redirect file operations
 * to a temp directory instead of the real ~/.fuel-code/.
 *
 * In production these are undefined and the module-level constants are used.
 */
let _configDirOverride: string | undefined;
let _configPathOverride: string | undefined;
let _queueDirOverride: string | undefined;
let _deadLetterDirOverride: string | undefined;

/** Get the active config directory (respects test overrides) */
export function getConfigDir(): string {
  return _configDirOverride ?? CONFIG_DIR;
}

/** Get the active config file path (respects test overrides) */
export function getConfigPath(): string {
  return _configPathOverride ?? CONFIG_PATH;
}

/** Get the active queue directory (respects test overrides) */
export function getQueueDir(): string {
  return _queueDirOverride ?? QUEUE_DIR;
}

/** Get the active dead-letter directory (respects test overrides) */
export function getDeadLetterDir(): string {
  return _deadLetterDirOverride ?? DEAD_LETTER_DIR;
}

/**
 * Override all config paths — for tests only.
 * Pass `undefined` to reset back to real paths.
 */
export function overrideConfigPaths(baseDir: string | undefined): void {
  if (baseDir) {
    _configDirOverride = baseDir;
    _configPathOverride = path.join(baseDir, "config.yaml");
    _queueDirOverride = path.join(baseDir, "queue");
    _deadLetterDirOverride = path.join(baseDir, "dead-letter");
  } else {
    _configDirOverride = undefined;
    _configPathOverride = undefined;
    _queueDirOverride = undefined;
    _deadLetterDirOverride = undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the config file exists on disk.
 * Does not validate the contents — just checks for file presence.
 */
export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}

/**
 * Load and validate the config file.
 *
 * @throws ConfigError CONFIG_NOT_FOUND — file does not exist
 * @throws ConfigError CONFIG_CORRUPTED — file exists but is not valid YAML
 * @throws ConfigError CONFIG_INVALID — YAML parses but fails schema validation
 */
export function loadConfig(): FuelCodeConfig {
  const configPath = getConfigPath();

  // Check file existence
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      `Config file not found at ${configPath}. Run 'fuel-code init' first.`,
      "CONFIG_NOT_FOUND",
      { path: configPath },
    );
  }

  // Read and parse YAML
  const raw = fs.readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(
      `Config file at ${configPath} is not valid YAML.`,
      "CONFIG_CORRUPTED",
      { path: configPath, parseError: String(err) },
    );
  }

  // Validate against Zod schema
  const result = FuelCodeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config file at ${configPath} has invalid structure: ${result.error.message}`,
      "CONFIG_INVALID",
      { path: configPath, zodErrors: result.error.issues },
    );
  }

  return result.data;
}

/**
 * Persist config to disk with an atomic write (tmp file + rename).
 *
 * - Creates parent directories if they don't exist
 * - Writes to a temporary file first, then renames (atomic on most filesystems)
 * - Sets file permissions to 0o600 (owner read/write only) since config contains API key
 */
export function saveConfig(config: FuelCodeConfig): void {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // Ensure the config directory exists
  fs.mkdirSync(configDir, { recursive: true });

  // Serialize to YAML with a descriptive header comment
  const yamlContent =
    "# fuel-code CLI configuration\n" +
    "# Generated by 'fuel-code init'. Edit with care.\n\n" +
    stringifyYaml(config, { lineWidth: 120 });

  // Atomic write: write to a temp file in the same directory, then rename.
  // Using the same directory ensures rename is atomic (same filesystem).
  const tmpPath = path.join(
    configDir,
    `.config.yaml.tmp.${crypto.randomBytes(4).toString("hex")}`,
  );

  try {
    fs.writeFileSync(tmpPath, yamlContent, { mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Ensure all required directories exist.
 * Called during `fuel-code init` to set up the directory structure.
 */
export function ensureDirectories(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.mkdirSync(getQueueDir(), { recursive: true });
  fs.mkdirSync(getDeadLetterDir(), { recursive: true });
}
