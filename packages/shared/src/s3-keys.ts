/**
 * S3 key construction utilities for the fuel-code system.
 *
 * Centralizes all S3 key patterns so that producers (CLI uploading transcripts)
 * and consumers (backend fetching/parsing) agree on the exact object paths.
 *
 * Key patterns:
 *   - transcripts/{workspaceCanonicalId}/{sessionId}/raw.jsonl   — raw CC transcript
 *   - transcripts/{workspaceCanonicalId}/{sessionId}/parsed.json — parsed backup
 *   - artifacts/{sessionId}/{artifactId}.{ext}                   — large tool result blobs
 */

/**
 * Build the S3 key for a raw transcript JSONL file.
 * @returns `transcripts/{workspaceCanonicalId}/{sessionId}/raw.jsonl`
 */
export function buildTranscriptKey(
  workspaceCanonicalId: string,
  sessionId: string,
): string {
  return `transcripts/${workspaceCanonicalId}/${sessionId}/raw.jsonl`;
}

/**
 * Build the S3 key for a parsed transcript backup.
 * @returns `transcripts/{workspaceCanonicalId}/{sessionId}/parsed.json`
 */
export function buildParsedBackupKey(
  workspaceCanonicalId: string,
  sessionId: string,
): string {
  return `transcripts/${workspaceCanonicalId}/${sessionId}/parsed.json`;
}

/**
 * Build the S3 key for a large tool result artifact.
 * @returns `artifacts/{sessionId}/{artifactId}.{ext}`
 */
export function buildArtifactKey(
  sessionId: string,
  artifactId: string,
  ext: string,
): string {
  return `artifacts/${sessionId}/${artifactId}.${ext}`;
}
