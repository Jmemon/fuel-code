/**
 * @fuel-code/shared — the contract layer for the fuel-code monorepo.
 *
 * Every other package imports from here. Contains:
 *   - TypeScript types for all 5 abstractions (Event, Workspace, Device, Session, Blueprint)
 *   - Zod validation schemas for event payloads
 *   - ULID generation and validation utilities
 *   - Git remote URL normalization and workspace ID derivation
 *   - Structured error hierarchy
 */

// Type definitions for all domain entities
export * from "./types/index.js";

// Zod schemas for event validation
export * from "./schemas/index.js";

// ULID generation, validation, and timestamp extraction
export * from "./ulid.js";

// Git remote normalization and workspace canonical ID derivation
export * from "./canonical.js";

// S3 key construction utilities
export * from "./s3-keys.js";

// Structured error classes
export * from "./errors.js";

// Build metadata (git SHA, build date, branch)
export * from "./build-info.js";
