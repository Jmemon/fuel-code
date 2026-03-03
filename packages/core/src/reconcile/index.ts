/**
 * Reconcile barrel export.
 *
 * Exports the SessionSeed builders, computeGap function, and the main
 * reconcileSession entry point used by the session pipeline reconciler.
 */

export {
  buildSeedFromHook,
  buildSeedFromFilesystem,
  buildSeedFromRecovery,
} from "./session-seed.js";

export { computeGap, type SessionForGap } from "./compute-gap.js";

export {
  reconcileSession,
  type ReconcileDeps,
  type ReconcileResult,
  type ReconcileS3Client,
} from "./reconcile-session.js";

export {
  extractTeamIntervals,
  persistTeams,
  type TeamInterval,
  type PersistedTeam,
} from "./team-detection.js";

// Re-export reconcile types from the types directory for convenience
export type { SessionSeed, SessionGap } from "../types/reconcile.js";
