/**
 * Thin wrapper around child_process.execSync for testability.
 *
 * cc-hook.ts imports execSync from here instead of directly from
 * node:child_process. This allows tests to mock.module("../lib/exec.js")
 * without poisoning the global node:child_process module cache for
 * other test files running in the same bun process.
 */
export { execSync } from "node:child_process";
