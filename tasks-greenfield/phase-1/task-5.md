# Task 5: CLI Config Management and `init` Command

## Parallel Group: C

## Description

Build the CLI entry point using commander, the config file management layer (`~/.fuel-code/`), and the `fuel-code init` command. This is the first thing a user runs. It creates device identity, stores backend connection info, and creates the local queue directory structure.

### Dependencies to install
```bash
cd packages/cli && bun add commander yaml
```

### Files to Create

**`packages/cli/src/index.ts`** (CLI entry point):
```typescript
#!/usr/bin/env bun
```
- Create commander program: `name("fuel-code")`, `description("Developer activity tracking")`, `version("0.1.0")`
- Register subcommands: `init` (this task), `emit` (Task 10), `hooks` (Task 13), `queue` (Task 12)
- Global error handler: catch unhandled rejections, log with pino, exit 1

**`packages/cli/src/lib/config.ts`**:

Constants:
- `CONFIG_DIR = path.join(os.homedir(), ".fuel-code")`
- `CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml")`
- `QUEUE_DIR = path.join(CONFIG_DIR, "queue")`
- `DEAD_LETTER_DIR = path.join(CONFIG_DIR, "dead-letter")`

Types:
```typescript
interface FuelCodeConfig {
  backend: { url: string; api_key: string };
  device: { id: string; name: string; type: "local" | "remote" };
  pipeline: {
    queue_path: string;
    drain_interval_seconds: number;
    batch_size: number;
    post_timeout_ms: number;
  };
}
```

Functions:
- `configExists(): boolean` — checks if CONFIG_PATH exists
- `loadConfig(): FuelCodeConfig`:
  - Read CONFIG_PATH, parse YAML (using `yaml` package).
  - Validate with a Zod schema: `backend.url` must be a valid URL, `backend.api_key` must be non-empty, `device.id` must be 26 chars (ULID), `device.name` must be non-empty.
  - On file not found: throw `ConfigError` code `CONFIG_NOT_FOUND`, message "fuel-code is not initialized. Run `fuel-code init`."
  - On YAML parse failure: throw `ConfigError` code `CONFIG_CORRUPTED`, message "Config file at {path} is corrupted. Run `fuel-code init --force` to regenerate."
  - On validation failure: throw `ConfigError` code `CONFIG_INVALID`, include Zod error details in context.
- `saveConfig(config: FuelCodeConfig): void`:
  - Ensure CONFIG_DIR exists with `mkdirSync({ recursive: true })`.
  - Write to a temp file first, then rename (atomic write to prevent corruption).
  - Set file permissions to `0o600` (contains API key).
- `ensureDirectories(): void` — create CONFIG_DIR, QUEUE_DIR, DEAD_LETTER_DIR with `mkdirSync({ recursive: true })`.

**`packages/cli/src/commands/init.ts`**:

`fuel-code init` command:
- Options:
  - `--name <name>` — device name (default: `os.hostname()`)
  - `--url <url>` — backend URL (default: env `FUEL_CODE_BACKEND_URL` or prompt)
  - `--api-key <key>` — API key (default: env `FUEL_CODE_API_KEY` or prompt)
  - `--force` — overwrite existing config
  - `--non-interactive` — skip interactive prompts, fail if required options missing

Flow:
1. If `configExists()` and not `--force`: print "Already initialized. Device: {name} ({id}). Use --force to reinitialize." Exit 0.
2. Call `ensureDirectories()`.
3. Determine device ID:
   - If `--force` and existing config is valid: preserve the existing device ID (changing device ID breaks event history).
   - If `--force` and existing config is corrupted: generate new ID, warn "Config was corrupted. New device ID generated."
   - If fresh install: generate new ULID via `generateId()`.
4. Determine device name: `--name` > `os.hostname()`. Validate: 1-64 chars, alphanumeric/hyphens/underscores.
5. Determine backend URL: `--url` > env `FUEL_CODE_BACKEND_URL`. If neither and `--non-interactive`: error. If neither and interactive: prompt with readline (default `https://fuel-code.up.railway.app`).
6. Determine API key: `--api-key` > env `FUEL_CODE_API_KEY`. If neither and `--non-interactive`: error. If neither and interactive: prompt (no default, required).
7. Write config via `saveConfig()`:
   ```yaml
   backend:
     url: "https://..."
     api_key: "fc_..."
   device:
     id: "01JMF3..."
     name: "macbook-pro"
     type: "local"
   pipeline:
     queue_path: "~/.fuel-code/queue/"
     drain_interval_seconds: 30
     batch_size: 50
     post_timeout_ms: 2000
   ```
8. Test connectivity: attempt HTTP GET to `{url}/api/health` with 5-second timeout.
   - On success: print "Connected to backend at {url}."
   - On failure: print "Warning: Could not reach backend at {url}. Events will be queued locally."
   - **Do NOT fail init on connectivity failure** — offline setup is valid.
9. Print summary:
   ```
   fuel-code initialized!
     Device: macbook-pro (01JMF3...)
     Backend: https://fuel-code.up.railway.app
     Config: ~/.fuel-code/config.yaml
     Queue: ~/.fuel-code/queue/
   ```

**`packages/cli/src/commands/status.ts`** (simple status command):
- `fuel-code status`:
  - Print device info from config
  - Print queue depth (count .json files in queue dir)
  - Attempt health check to backend, print connectivity status

### Tests

**`packages/cli/src/lib/__tests__/config.test.ts`**:
- `loadConfig` on nonexistent file throws ConfigError with CONFIG_NOT_FOUND
- `saveConfig` + `loadConfig` round-trips correctly
- `saveConfig` creates parent directories
- Corrupted YAML file throws ConfigError with CONFIG_CORRUPTED

## Relevant Files
- `packages/cli/src/index.ts` (create)
- `packages/cli/src/lib/config.ts` (create)
- `packages/cli/src/commands/init.ts` (create)
- `packages/cli/src/commands/status.ts` (create)
- `packages/cli/src/lib/__tests__/config.test.ts` (create)

## Success Criteria
1. `fuel-code init --name test --url http://localhost:3000 --api-key fc_test123` creates `~/.fuel-code/config.yaml` with correct content.
2. Config file has permissions `0o600` (verified with `stat`).
3. `~/.fuel-code/queue/` and `~/.fuel-code/dead-letter/` directories are created.
4. Device ID in config is a valid 26-character ULID.
5. `fuel-code init` again (without --force) prints "Already initialized" and exits 0.
6. `fuel-code init --force` preserves existing device ID if config is valid.
7. `fuel-code init --force` generates new device ID if config is corrupted.
8. `loadConfig()` returns a valid FuelCodeConfig object after init.
9. `loadConfig()` on missing file throws ConfigError with code CONFIG_NOT_FOUND.
10. `loadConfig()` on corrupted YAML throws ConfigError with code CONFIG_CORRUPTED.
11. `fuel-code --help` shows all registered commands.
12. `fuel-code --version` shows "0.1.0".
13. If backend is unreachable during init, init still succeeds with a warning.
14. `fuel-code status` shows device info and queue depth.
