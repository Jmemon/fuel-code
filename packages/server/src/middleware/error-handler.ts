/**
 * Global Express error handler for fuel-code.
 *
 * Catches all errors thrown or passed via next(err) in the middleware chain
 * and maps them to appropriate HTTP responses:
 *
 *   - ZodError            → 400 with validation details
 *   - FuelCodeError       → HTTP status based on error code prefix
 *   - Everything else     → 500 Internal Server Error
 *
 * Full error details (including stack traces) are always logged at error level.
 * Stack traces are NEVER sent to clients in production to avoid information leakage.
 */

import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { FuelCodeError } from "@fuel-code/shared";
import { logger } from "../logger.js";

/** Whether the server is running in production mode */
const isProduction = process.env.NODE_ENV === "production";

/**
 * Map a FuelCodeError code prefix to an HTTP status code.
 *
 * @param code - The machine-readable error code (e.g., "VALIDATION_PAYLOAD")
 * @returns HTTP status code appropriate for the error category
 */
function mapFuelCodeErrorToStatus(code: string): number {
  if (code.startsWith("VALIDATION_")) return 400;
  if (code.startsWith("CONFIG_")) return 500;
  if (code.startsWith("NETWORK_")) return 502;
  if (code.startsWith("STORAGE_")) return 503;
  // Unknown prefix — treat as internal server error
  return 500;
}

/**
 * Express error-handling middleware (must have 4 parameters for Express to recognize it).
 *
 * Logs the full error with stack trace, then sends a sanitized response to the client.
 * In development, includes the stack trace in the response for easier debugging.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Always log the full error including stack trace for debugging
  logger.error(
    { err, code: (err as FuelCodeError).code },
    `Request error: ${err.message}`,
  );

  // --- Zod validation errors → 400 with structured details ---
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues,
    });
    return;
  }

  // --- FuelCodeError → HTTP status based on code prefix ---
  if (err instanceof FuelCodeError) {
    const status = mapFuelCodeErrorToStatus(err.code);
    res.status(status).json({
      error: err.message,
      code: err.code,
      // Include stack trace only in development for debugging
      ...(isProduction ? {} : { stack: err.stack }),
    });
    return;
  }

  // --- Unknown/unexpected errors → 500 ---
  res.status(500).json({
    error: "Internal server error",
    // Include stack trace only in development for debugging
    ...(isProduction ? {} : { stack: err.stack }),
  });
}
