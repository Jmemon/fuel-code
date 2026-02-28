# Task 3: S3 Client Abstraction

## Parallel Group: B

## Description

Create the S3 client abstraction layer used by the server to upload transcripts, download them for parsing, and generate presigned URLs for raw transcript access. Real transcripts range from 3KB to 144MB, so the client must support streaming for large files. It wraps AWS SDK v3 with error handling, retry logic, and logging.

### Dependencies to Install
```bash
cd packages/server && bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

### Files to Create

**`packages/server/src/aws/s3.ts`**:

```typescript
interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;       // for local testing with LocalStack
  forcePathStyle?: boolean; // for LocalStack (use path-style URLs)
}

interface FuelCodeS3Client {
  // Upload a buffer or string to S3
  upload(key: string, body: Buffer | string, contentType?: string): Promise<{ key: string; size: number }>;

  // Upload from a local file path using streaming (critical for large transcripts)
  uploadFile(key: string, filePath: string, contentType?: string): Promise<{ key: string; size: number }>;

  // Download an object as a string (for moderate-size transcripts, <50MB)
  download(key: string): Promise<string>;

  // Download as a readable stream (for large transcripts, >50MB)
  downloadStream(key: string): Promise<ReadableStream>;

  // Generate a presigned URL for direct download
  presignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  // Check if an object exists and return its size
  headObject(key: string): Promise<{ exists: boolean; size?: number }>;

  // Delete an object (for tests only — production never deletes transcripts)
  delete(key: string): Promise<void>;

  // Check S3 connectivity (for health endpoint)
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
}
```

- `createS3Client(config: S3Config, logger: pino.Logger): FuelCodeS3Client`

Implementation details:
- `upload`: `PutObjectCommand` with `ContentType` from parameter (default `"application/octet-stream"`). Log at info: `"S3 upload: {key} ({size} bytes)"`. On error, throw `StorageError` with code `STORAGE_S3_UPLOAD_FAILED`.
- `uploadFile`: Read file using `Bun.file(filePath).stream()` — streams the file, does NOT buffer the entire 144MB in memory. Pass the stream to `PutObjectCommand`. For files > 50MB, consider using `@aws-sdk/lib-storage` `Upload` for multipart (implement simple path first).
- `download`: `GetObjectCommand`, transform Body stream to string. On 404/NoSuchKey: throw `StorageError` with code `STORAGE_S3_NOT_FOUND`. On other errors: `STORAGE_S3_DOWNLOAD_FAILED`.
- `downloadStream`: `GetObjectCommand`, return the Body stream directly. Used by the streaming transcript parser for very large transcripts.
- `presignedUrl`: `getSignedUrl` from `@aws-sdk/s3-request-presigner` with `GetObjectCommand`. Default expiry: 3600 seconds (1 hour).
- `headObject`: `HeadObjectCommand`. Return `{ exists: true, size }` on success, `{ exists: false }` on 404. Never throw on 404.
- `healthCheck`: `HeadBucketCommand`. Return `{ ok: true }` on success, `{ ok: false, error }` on failure.
- All operations include 3 retries with exponential backoff (built into the AWS SDK client config).
- Never log full S3 key contents or presigned URLs. Log key path and byte size only.

**`packages/server/src/aws/s3-config.ts`**:
```typescript
// Load S3 configuration from environment variables
function loadS3Config(): S3Config
  // S3_BUCKET (required, default "fuel-code-blobs")
  // S3_REGION (required, default "us-east-1")
  // S3_ENDPOINT (optional, for LocalStack)
  // S3_FORCE_PATH_STYLE (optional, "true" for LocalStack)
```

### Tests

**`packages/server/src/aws/__tests__/s3.test.ts`**:

Tests use LocalStack via `S3_ENDPOINT=http://localhost:4566` or are skipped if no S3 is available (`describe.skipIf(!process.env.S3_TEST_BUCKET)`).

- Upload a string, download it back, verify content matches
- Upload a file from disk (create a temp file), download and verify
- `headObject` returns `{ exists: true, size: N }` for uploaded object
- `headObject` returns `{ exists: false }` for non-existent key (no throw)
- `presignedUrl` returns a URL string (starts with "http")
- Download non-existent key throws `StorageError` with code `STORAGE_S3_NOT_FOUND`
- `healthCheck` returns `{ ok: true }` when bucket is accessible
- Upload with empty string is handled gracefully (empty object in S3)

## Relevant Files
- `packages/server/src/aws/s3.ts` (create)
- `packages/server/src/aws/s3-config.ts` (create)
- `packages/server/src/aws/__tests__/s3.test.ts` (create)

## Success Criteria
1. `createS3Client(config, logger)` returns a working client when credentials are available.
2. `upload` followed by `download` round-trips correctly for a JSONL string.
3. `uploadFile` streams a large file without loading it all into memory (verified by uploading a >10MB test file).
4. `headObject` for a non-existent key returns `{ exists: false }` without throwing.
5. `download` for a non-existent key throws `StorageError` with code `STORAGE_S3_NOT_FOUND`.
6. `presignedUrl` generates a valid URL with configurable expiry.
7. `healthCheck` returns `{ ok: true }` when bucket is accessible.
8. S3 key contents are never logged; only key path and byte size.
9. The client works with LocalStack when `S3_ENDPOINT` is set.
10. Retry logic handles transient failures (AWS SDK built-in retries).
