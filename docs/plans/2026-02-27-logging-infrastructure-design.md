# Logging Infrastructure Design

## Problem

All logging went to stdout/stderr with no persistent files. No way for Claude Code
to inspect logs after the fact. Docker container logs had no rotation config.
Mixed console.log and pino calls across the server codebase.

## Solution: Pino Multi-Transport

Every logger writes to both the terminal (pino-pretty in dev, JSON in prod) and a
dedicated log file (always JSON). This gives developers the readable terminal output
they expect while producing machine-parseable files for Claude Code inspection.

## Log File Locations

| Component | File | Notes |
|-----------|------|-------|
| Server | `./logs/server.log` | Express, routes, middleware, startup/shutdown |
| Consumer | `./logs/consumer.log` | Redis stream consumer, event processing |
| CLI | `~/.fuel-code/logs/cli.log` | CLI runs from any directory, so uses config dir |
| Docker postgres | `./logs/docker/postgres.log` | Captured via `bun run logs:docker` |
| Docker redis | `./logs/docker/redis.log` | Captured via `bun run logs:docker` |
| Docker localstack | `./logs/docker/localstack.log` | Captured via `bun run logs:docker` |

## Key Changes

1. **`packages/server/src/logger.ts`** — `createLogger(name, filename)` factory with
   multi-transport: pino-pretty (stdout) + pino/file (JSON to logs/).
2. **`packages/server/src/index.ts`** — Consumer gets its own logger writing to consumer.log.
3. **Console cleanup** — redis/client.ts, db/postgres.ts, db/migrator.ts migrated from
   console.* to structured pino logging.
4. **CLI** — Added pino/file transport writing to ~/.fuel-code/logs/cli.log.
5. **Docker** — json-file driver with 10MB rotation, 3 file max on all containers.
6. **Scripts** — `bun run logs:docker` captures container logs to files.
   `bun run logs:clear` removes all log files.

## How to Use

```bash
# Inspect server logs
cat logs/server.log | head -20

# Capture docker logs to files (run after containers are up)
bun run logs:docker

# Clear all logs
bun run logs:clear

# Change log level
LOG_LEVEL=debug bun run start
```

## Configuration

- `LOG_LEVEL` env var — controls level (default: "info" server, "warn" CLI)
- `LOG_DIR` env var — overrides default log directory for server
- `NODE_ENV=production` — disables pretty printing, outputs JSON to stdout + file
