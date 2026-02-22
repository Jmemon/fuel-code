/**
 * S3 client abstraction for fuel-code blob storage.
 *
 * Wraps AWS SDK v3 S3 operations with:
 *   - Structured error handling using StorageError
 *   - Streaming support for large files (transcripts up to 144MB)
 *   - Presigned URL generation for client-side downloads
 *   - Health checks via HeadBucket
 *   - 3 automatic retries with exponential backoff (via SDK config)
 *
 * Security: Never logs full S3 keys, presigned URLs, or object contents.
 * Only key paths and byte sizes are logged.
 *
 * Usage:
 *   const s3 = createS3Client(loadS3Config(), logger);
 *   await s3.upload("transcripts/ws-1/sess-1/raw.jsonl", jsonlContent, "application/x-ndjson");
 *   const content = await s3.download("transcripts/ws-1/sess-1/raw.jsonl");
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageError } from "@fuel-code/shared";
import type { S3Config } from "./s3-config.js";
import type pino from "pino";

/** Default presigned URL expiration: 1 hour */
const DEFAULT_PRESIGN_EXPIRY_SECONDS = 3600;

/** Maximum number of retry attempts for S3 operations (built into SDK client) */
const MAX_RETRIES = 3;

/** Result of an upload operation — the key and byte size written */
export interface UploadResult {
  key: string;
  size: number;
}

/** Result of a headObject check — whether the object exists and its size */
export interface HeadResult {
  exists: boolean;
  size?: number;
}

/** Result of a health check against the S3 bucket */
export interface HealthCheckResult {
  ok: boolean;
  error?: string;
}

/** Public interface for all S3 operations used by fuel-code */
export interface FuelCodeS3Client {
  /** Upload a Buffer or string body to S3 */
  upload(key: string, body: Buffer | string, contentType?: string): Promise<UploadResult>;
  /** Stream a readable (e.g., HTTP request body) directly to S3 without buffering */
  uploadStream(key: string, stream: import("node:stream").Readable, contentLength: number, contentType?: string): Promise<UploadResult>;
  /** Stream a file from disk to S3 without buffering the entire file in memory */
  uploadFile(key: string, filePath: string, contentType?: string): Promise<UploadResult>;
  /** Download an object and return its contents as a string */
  download(key: string): Promise<string>;
  /** Download an object and return the raw readable stream (for streaming parsers) */
  downloadStream(key: string): Promise<ReadableStream>;
  /** Generate a presigned GET URL for temporary access to an object */
  presignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Check if an object exists and get its size — never throws on 404 */
  headObject(key: string): Promise<HeadResult>;
  /** Delete an object from S3 */
  delete(key: string): Promise<void>;
  /** Check bucket accessibility — returns ok:true if the bucket is reachable */
  healthCheck(): Promise<HealthCheckResult>;
  /** Ensure the configured bucket exists, creating it if necessary (idempotent) */
  ensureBucket(): Promise<void>;
}

/**
 * Create a configured S3 client instance.
 *
 * The underlying AWS SDK client is configured with 3 retries and exponential
 * backoff. All errors are wrapped in StorageError with descriptive codes.
 *
 * @param config - S3 bucket, region, and optional endpoint configuration
 * @param logger - Pino logger for structured operation logging
 * @returns A FuelCodeS3Client with all CRUD and health check operations
 */
export function createS3Client(config: S3Config, logger: pino.Logger): FuelCodeS3Client {
  // Build the AWS SDK S3 client with retry config and optional LocalStack endpoint
  const client = new S3Client({
    region: config.region,
    maxAttempts: MAX_RETRIES,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.forcePathStyle ? { forcePathStyle: config.forcePathStyle } : {}),
  });

  const bucket = config.bucket;

  return {
    /**
     * Upload a Buffer or string to S3.
     * Logs key path and byte size (never the contents).
     */
    async upload(
      key: string,
      body: Buffer | string,
      contentType: string = "application/octet-stream",
    ): Promise<UploadResult> {
      // Calculate byte size — Buffer.byteLength handles both Buffer and string
      const size = Buffer.byteLength(body);

      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: typeof body === "string" ? Buffer.from(body) : body,
            ContentType: contentType,
          }),
        );

        logger.info({ key, size }, `S3 upload: ${key} (${size} bytes)`);
        return { key, size };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ key, error: message }, `S3 upload failed: ${key}`);
        throw new StorageError(
          `S3 upload failed for key "${key}": ${message}`,
          "STORAGE_S3_UPLOAD_FAILED",
          { key, size },
        );
      }
    },

    /**
     * Stream a Readable (e.g., Express req) directly to S3 without buffering.
     * The caller must provide the content length from the Content-Length header.
     * AWS SDK v3 accepts Node Readable streams as Body.
     */
    async uploadStream(
      key: string,
      stream: import("node:stream").Readable,
      contentLength: number,
      contentType: string = "application/octet-stream",
    ): Promise<UploadResult> {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: stream as any,
            ContentType: contentType,
            ContentLength: contentLength,
          }),
        );

        logger.info({ key, size: contentLength }, `S3 stream upload: ${key} (${contentLength} bytes)`);
        return { key, size: contentLength };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ key, error: message }, `S3 stream upload failed: ${key}`);
        throw new StorageError(
          `S3 stream upload failed for key "${key}": ${message}`,
          "STORAGE_S3_UPLOAD_FAILED",
          { key, size: contentLength },
        );
      }
    },

    /**
     * Stream a file from disk to S3.
     * Uses Bun.file().stream() so the file is never fully buffered in memory.
     * Suitable for large transcript files (up to 144MB).
     */
    async uploadFile(
      key: string,
      filePath: string,
      contentType: string = "application/octet-stream",
    ): Promise<UploadResult> {
      try {
        const file = Bun.file(filePath);
        const size = file.size;
        const stream = file.stream();

        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            // AWS SDK v3 accepts a ReadableStream as Body
            Body: stream as any,
            ContentType: contentType,
            ContentLength: size,
          }),
        );

        logger.info({ key, size, filePath }, `S3 file upload: ${key} (${size} bytes)`);
        return { key, size };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ key, filePath, error: message }, `S3 file upload failed: ${key}`);
        throw new StorageError(
          `S3 file upload failed for key "${key}": ${message}`,
          "STORAGE_S3_UPLOAD_FAILED",
          { key, filePath },
        );
      }
    },

    /**
     * Download an object from S3 and return its contents as a UTF-8 string.
     * Throws STORAGE_S3_NOT_FOUND on 404/NoSuchKey, STORAGE_S3_DOWNLOAD_FAILED otherwise.
     */
    async download(key: string): Promise<string> {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        // Transform the response body stream to a string
        const body = await response.Body?.transformToString("utf-8");
        if (body === undefined) {
          throw new Error("Response body was empty");
        }

        logger.info({ key, size: body.length }, `S3 download: ${key} (${body.length} bytes)`);
        return body;
      } catch (err) {
        // Re-throw our own StorageErrors (from the empty body check above)
        if (err instanceof StorageError) throw err;

        const message = err instanceof Error ? err.message : String(err);
        const errorName = (err as any)?.name || "";

        // 404 / NoSuchKey — object does not exist
        if (errorName === "NoSuchKey" || errorName === "NotFound" || (err as any)?.$metadata?.httpStatusCode === 404) {
          logger.warn({ key }, `S3 download: key not found — ${key}`);
          throw new StorageError(
            `S3 object not found: "${key}"`,
            "STORAGE_S3_NOT_FOUND",
            { key },
          );
        }

        // All other download errors
        logger.error({ key, error: message }, `S3 download failed: ${key}`);
        throw new StorageError(
          `S3 download failed for key "${key}": ${message}`,
          "STORAGE_S3_DOWNLOAD_FAILED",
          { key },
        );
      }
    },

    /**
     * Download an object from S3 and return the raw readable stream.
     * Used by the streaming transcript parser to process large files
     * without loading them entirely into memory.
     */
    async downloadStream(key: string): Promise<ReadableStream> {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        // The SDK returns a web ReadableStream (or node Readable, depending on env)
        const stream = response.Body?.transformToWebStream();
        if (!stream) {
          throw new Error("Response body stream was empty");
        }

        logger.info({ key }, `S3 download stream opened: ${key}`);
        return stream;
      } catch (err) {
        if (err instanceof StorageError) throw err;

        const message = err instanceof Error ? err.message : String(err);
        const errorName = (err as any)?.name || "";

        if (errorName === "NoSuchKey" || errorName === "NotFound" || (err as any)?.$metadata?.httpStatusCode === 404) {
          logger.warn({ key }, `S3 download stream: key not found — ${key}`);
          throw new StorageError(
            `S3 object not found: "${key}"`,
            "STORAGE_S3_NOT_FOUND",
            { key },
          );
        }

        logger.error({ key, error: message }, `S3 download stream failed: ${key}`);
        throw new StorageError(
          `S3 download stream failed for key "${key}": ${message}`,
          "STORAGE_S3_DOWNLOAD_FAILED",
          { key },
        );
      }
    },

    /**
     * Generate a presigned GET URL for temporary client-side access.
     * Default expiry is 1 hour (3600 seconds).
     * The presigned URL itself is NOT logged for security.
     */
    async presignedUrl(
      key: string,
      expiresInSeconds: number = DEFAULT_PRESIGN_EXPIRY_SECONDS,
    ): Promise<string> {
      try {
        const command = new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        });

        const url = await getSignedUrl(client, command, {
          expiresIn: expiresInSeconds,
        });

        logger.info({ key, expiresInSeconds }, `S3 presigned URL generated: ${key}`);
        return url;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ key, error: message }, `S3 presigned URL generation failed: ${key}`);
        throw new StorageError(
          `S3 presigned URL generation failed for key "${key}": ${message}`,
          "STORAGE_S3_PRESIGN_FAILED",
          { key },
        );
      }
    },

    /**
     * Check if an object exists in S3 and get its size.
     * Returns { exists: false } on 404 — never throws for missing objects.
     */
    async headObject(key: string): Promise<HeadResult> {
      try {
        const response = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        return {
          exists: true,
          size: response.ContentLength,
        };
      } catch (err) {
        const errorName = (err as any)?.name || "";
        const statusCode = (err as any)?.$metadata?.httpStatusCode;

        // 404 is expected — object doesn't exist, return gracefully
        if (errorName === "NotFound" || statusCode === 404) {
          return { exists: false };
        }

        // Unexpected error — still don't throw, but log it
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ key, error: message }, `S3 headObject failed: ${key}`);
        throw new StorageError(
          `S3 headObject failed for key "${key}": ${message}`,
          "STORAGE_S3_HEAD_FAILED",
          { key },
        );
      }
    },

    /**
     * Delete an object from S3.
     * S3 delete is idempotent — deleting a non-existent key does not throw.
     */
    async delete(key: string): Promise<void> {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );

        logger.info({ key }, `S3 delete: ${key}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ key, error: message }, `S3 delete failed: ${key}`);
        throw new StorageError(
          `S3 delete failed for key "${key}": ${message}`,
          "STORAGE_S3_DELETE_FAILED",
          { key },
        );
      }
    },

    /**
     * Health check — verifies the configured bucket is accessible.
     * Returns { ok: true } on success, { ok: false, error } on failure.
     * Never throws — the result object communicates the status.
     */
    /**
     * Ensure the S3 bucket exists, creating it if it doesn't.
     * Called at server startup so transcript uploads never hit NoSuchBucket.
     */
    async ensureBucket(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        logger.info({ bucket }, `S3 bucket exists: ${bucket}`);
      } catch (err) {
        const statusCode = (err as any)?.$metadata?.httpStatusCode;
        const errorName = (err as any)?.name || "";

        if (statusCode === 404 || errorName === "NotFound" || errorName === "NoSuchBucket") {
          logger.info({ bucket }, `S3 bucket not found, creating: ${bucket}`);
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
          logger.info({ bucket }, `S3 bucket created: ${bucket}`);
        } else {
          throw err;
        }
      }
    },

    async healthCheck(): Promise<HealthCheckResult> {
      try {
        await client.send(
          new HeadBucketCommand({
            Bucket: bucket,
          }),
        );

        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ bucket, error: message }, `S3 health check failed for bucket "${bucket}"`);
        return { ok: false, error: message };
      }
    },
  };
}
