/**
 * Thin re-export of workspace utilities for testability.
 *
 * cc-hook.ts imports from here instead of directly from @fuel-code/shared.
 * This allows tests to mock this module without poisoning the global
 * @fuel-code/shared module cache for other test files.
 */
export { deriveWorkspaceCanonicalId } from "@fuel-code/shared";
