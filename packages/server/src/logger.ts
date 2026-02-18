/**
 * Centralized pino logger for the fuel-code server.
 *
 * Configuration:
 *   - JSON format in production (NODE_ENV=production) for structured log aggregation
 *   - Pretty-printed output in development for human readability
 *   - Log level controlled via LOG_LEVEL env var (default: "info")
 *   - Request/response bodies are NOT logged to avoid leaking sensitive data
 */

import pino from "pino";

/** Whether the server is running in production mode */
const isProduction = process.env.NODE_ENV === "production";

/**
 * Shared pino logger instance used across the server.
 *
 * Import this wherever you need structured logging:
 *   import { logger } from "../logger.js";
 *   logger.info({ port: 3000 }, "Server started");
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",

  // In development, use pino-pretty for human-readable output.
  // In production, emit raw JSON for log aggregation tools.
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }),
});
