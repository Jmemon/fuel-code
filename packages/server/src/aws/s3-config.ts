/**
 * S3 configuration loader for fuel-code.
 *
 * Reads S3 connection settings from environment variables with sensible defaults.
 * The optional endpoint and forcePathStyle settings support LocalStack for local
 * development and testing without needing a real AWS account.
 *
 * Environment variables:
 *   - S3_BUCKET          (default: "fuel-code-blobs") — the bucket for all blob storage
 *   - S3_REGION          (default: "us-east-1")       — AWS region
 *   - S3_ENDPOINT        (optional)                   — custom endpoint for LocalStack
 *   - S3_FORCE_PATH_STYLE (optional, "true")          — use path-style URLs for LocalStack
 */

/** S3 connection and bucket configuration */
export interface S3Config {
  /** S3 bucket name for all fuel-code blob storage */
  bucket: string;
  /** AWS region the bucket lives in */
  region: string;
  /** Optional custom endpoint URL (e.g., "http://localhost:4566" for LocalStack) */
  endpoint?: string;
  /** Use path-style addressing instead of virtual-hosted — required for LocalStack */
  forcePathStyle?: boolean;
}

/**
 * Load S3 configuration from environment variables.
 *
 * All values have defaults suitable for production except endpoint/forcePathStyle
 * which are only set when the corresponding env vars are present (local dev).
 *
 * @returns Validated S3Config ready for createS3Client
 */
export function loadS3Config(): S3Config {
  const config: S3Config = {
    bucket: process.env.S3_BUCKET || "fuel-code-blobs",
    region: process.env.S3_REGION || "us-east-1",
  };

  // Only set endpoint if explicitly provided — production uses default AWS endpoints
  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
  }

  // Path-style addressing is needed for LocalStack and some S3-compatible stores
  if (process.env.S3_FORCE_PATH_STYLE === "true") {
    config.forcePathStyle = true;
  }

  return config;
}
