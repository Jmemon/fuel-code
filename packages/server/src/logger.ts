/**
 * Centralized pino logger factory for the fuel-code server.
 *
 * Provides multi-transport logging: pretty-printed to stdout (dev) + JSON to
 * log files (always). Each server component gets its own log file for easy
 * inspection by Claude Code or other tools.
 *
 * Log files are written to {project_root}/logs/:
 *   - server.log    — Express server, routes, middleware, startup/shutdown
 *   - consumer.log  — Redis stream consumer, event processing, retries
 *
 * Configuration:
 *   - LOG_LEVEL env var controls the log level (default: "info")
 *   - NODE_ENV=production disables pretty printing (JSON only)
 *   - LOG_DIR env var overrides the default log directory
 */

import pino from "pino";
import { resolve, join } from "node:path";

/** Whether the server is running in production mode */
const isProduction = process.env.NODE_ENV === "production";

/** Default log level, controllable via LOG_LEVEL env var */
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

/**
 * Log directory — defaults to {project_root}/logs/.
 * Computed from import.meta.dir (packages/server/src/) going 3 levels up.
 * Override with LOG_DIR env var if needed.
 */
const PROJECT_ROOT = resolve(import.meta.dir, "..", "..", "..");
const LOG_DIR = process.env.LOG_DIR || join(PROJECT_ROOT, "logs");

/**
 * Create a pino logger that writes to both stdout (pretty) and a log file (JSON).
 *
 * In production: JSON to stdout + JSON to file.
 * In development: pretty-printed to stdout + JSON to file.
 *
 * The file transport uses pino/file with mkdir:true, so the logs/ directory
 * is created automatically on first write.
 *
 * @param name     - Logger name (appears in log entries)
 * @param filename - Log filename (e.g. "server.log") — written to LOG_DIR
 * @returns A configured pino logger instance
 */
export function createLogger(name: string, filename: string): pino.Logger {
  const filePath = join(LOG_DIR, filename);

  return pino({
    name,
    level: LOG_LEVEL,
    transport: {
      targets: [
        // Pretty-printed output to stdout (dev only)
        ...(isProduction
          ? [
              {
                target: "pino/file",
                options: { destination: 1 },
                level: LOG_LEVEL,
              },
            ]
          : [
              {
                target: "pino-pretty",
                options: {
                  colorize: true,
                  translateTime: "HH:MM:ss",
                  ignore: "pid,hostname",
                },
                level: LOG_LEVEL,
              },
            ]),
        // JSON to log file (always — enables Claude Code log inspection)
        {
          target: "pino/file",
          options: { destination: filePath, mkdir: true },
          level: LOG_LEVEL,
        },
      ],
    },
  });
}

/**
 * Default server logger — used by routes, middleware, and general server code.
 * Writes to logs/server.log.
 */
export const logger = createLogger("server", "server.log");

/** Expose the computed log directory for use by other modules */
export const LOG_DIR_PATH = LOG_DIR;
