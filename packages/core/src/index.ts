/**
 * @fuel-code/core — domain logic barrel export.
 *
 * Core resolvers ensure workspaces, devices, and their junction records
 * exist in Postgres before events reference them. All functions accept
 * an injected postgres.js `sql` client — no direct DB connection ownership.
 *
 * The event processor resolves entities, persists event rows, and dispatches
 * to type-specific handlers via an extensible registry.
 */

// Workspace resolution: canonical ID -> ULID, upsert on first sight
export {
  resolveOrCreateWorkspace,
  getWorkspaceByCanonicalId,
  getWorkspaceById,
} from "./workspace-resolver.js";

// Device resolution: client device ID -> DB record, upsert on first sight
export {
  resolveOrCreateDevice,
  updateDeviceLastSeen,
} from "./device-resolver.js";

// Workspace-Device junction: link a workspace to a device with local path
export { ensureWorkspaceDeviceLink } from "./workspace-device-link.js";

// Event processor: resolve entities, insert event, dispatch to handlers
export {
  processEvent,
  EventHandlerRegistry,
  type EventHandlerContext,
  type EventHandler,
  type ProcessResult,
} from "./event-processor.js";

// Handler registry factory and individual handlers
export { createHandlerRegistry } from "./handlers/index.js";
export { handleSessionStart } from "./handlers/session-start.js";
export { handleSessionEnd } from "./handlers/session-end.js";

// Session lifecycle state machine: transitions, guards, recovery
export {
  TRANSITIONS,
  isValidTransition,
  transitionSession,
  failSession,
  resetSessionForReparse,
  getSessionState,
  findStuckSessions,
  type SessionLifecycle,
  type TransitionResult,
} from "./session-lifecycle.js";

// Transcript parser: JSONL → structured messages + content blocks
export { parseTranscript, type ParseOptions } from "./transcript-parser.js";

// Summary generator: LLM-powered session summaries
export {
  generateSummary,
  renderTranscriptForSummary,
  extractInitialPrompt,
  type SummaryConfig,
  type SummaryResult,
} from "./summary-generator.js";

// Summary config loader
export { loadSummaryConfig } from "./summary-config.js";

// Session pipeline orchestrator: post-processing after session ends
export {
  runSessionPipeline,
  createPipelineQueue,
  type PipelineDeps,
  type PipelineResult,
  type S3Client,
} from "./session-pipeline.js";

// Stuck session recovery: find and re-trigger stuck pipeline sessions
export { recoverStuckSessions, type RecoveryResult } from "./session-recovery.js";
