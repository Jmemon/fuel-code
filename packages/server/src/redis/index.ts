/**
 * Redis module — connection management and stream abstractions.
 *
 * Re-exports everything from:
 *   - client.ts: Redis client creation and health checks
 *   - stream.ts: Redis Streams publish/consume/acknowledge operations
 */

export { createRedisClient, checkRedisHealth } from "./client.js";
export type { RedisHealthResult } from "./client.js";

export {
  EVENTS_STREAM,
  CONSUMER_GROUP,
  CONSUMER_NAME,
  ensureConsumerGroup,
  publishToStream,
  publishBatchToStream,
  readFromStream,
  acknowledgeEntry,
  claimPendingEntries,
} from "./stream.js";
export type { StreamEntry, BatchPublishResult } from "./stream.js";
