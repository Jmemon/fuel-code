/**
 * Structured error hierarchy for fuel-code.
 *
 * All fuel-code errors extend FuelCodeError, which adds:
 *   - `code`: Machine-readable error code (e.g., "CONFIG_MISSING")
 *   - `context`: Arbitrary metadata for debugging (logged, not shown to user)
 *   - JSON serialization via toJSON()
 *
 * Error categories:
 *   - ConfigError:     Config file issues (missing, corrupted, invalid values)
 *   - NetworkError:    HTTP/WebSocket failures (timeouts, DNS, connection refused)
 *   - ValidationError: Zod schema validation failures
 *   - StorageError:    Database/cache/blob store failures (Postgres, Redis, S3)
 */

/**
 * Base error class for all fuel-code errors.
 * Adds a machine-readable code and structured context for debugging.
 * Serializable to JSON for logging and API error responses.
 */
export class FuelCodeError extends Error {
  /** Machine-readable error code (e.g., "CONFIG_MISSING", "NETWORK_TIMEOUT") */
  readonly code: string;
  /** Structured debugging context — never exposed to end users */
  readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FuelCodeError";
    this.code = code;
    this.context = context;
  }

  /** Serialize to a plain object for JSON logging and API responses */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * Configuration errors — config file missing, corrupted, or invalid.
 * Code prefix: CONFIG_*
 *
 * @example
 *   throw new ConfigError("Config file not found", "CONFIG_MISSING", { path: "~/.fuel-code/config.json" })
 */
export class ConfigError extends FuelCodeError {
  constructor(
    message: string,
    code: string = "CONFIG_ERROR",
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = "ConfigError";
  }
}

/**
 * Network errors — HTTP failures, timeouts, DNS resolution, connection refused.
 * Code prefix: NETWORK_*
 *
 * @example
 *   throw new NetworkError("Request timeout", "NETWORK_TIMEOUT", { url: "https://api.fuel-code.dev/ingest", timeout: 5000 })
 */
export class NetworkError extends FuelCodeError {
  constructor(
    message: string,
    code: string = "NETWORK_ERROR",
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = "NetworkError";
  }
}

/**
 * Validation errors — Zod schema failures, invalid input data.
 * Code prefix: VALIDATION_*
 *
 * @example
 *   throw new ValidationError("Invalid event payload", "VALIDATION_PAYLOAD", { type: "session.start", zodErrors: error.issues })
 */
export class ValidationError extends FuelCodeError {
  constructor(
    message: string,
    code: string = "VALIDATION_ERROR",
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = "ValidationError";
  }
}

/**
 * Storage errors — Postgres, Redis, or S3 operation failures.
 * Code prefix: STORAGE_*
 *
 * @example
 *   throw new StorageError("Failed to insert event", "STORAGE_INSERT", { table: "events", pgCode: "23505" })
 */
export class StorageError extends FuelCodeError {
  constructor(
    message: string,
    code: string = "STORAGE_ERROR",
    context: Record<string, unknown> = {},
  ) {
    super(message, code, context);
    this.name = "StorageError";
  }
}
