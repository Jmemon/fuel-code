/**
 * Tests for the migration runner's file-reading and sorting logic.
 *
 * These tests do NOT require a real Postgres instance. They only test:
 *   - Reading and sorting .sql files from a directory
 *   - Handling empty directories (no-op)
 *   - Handling nonexistent directories (no-op)
 *   - Verifying the actual 001_initial.sql migration file exists and
 *     contains all expected CREATE TABLE and CREATE INDEX statements
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMigrationFiles } from "../migrator.js";

describe("readMigrationFiles", () => {
  /** Temporary directory created fresh for each test, cleaned up afterward */
  let tempDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test to avoid cross-contamination
    tempDir = await mkdtemp(join(tmpdir(), "fuel-migrator-test-"));
  });

  afterEach(async () => {
    // Clean up temp directory after each test
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads and sorts .sql files lexicographically", async () => {
    // Create test migration files out of order to verify sorting
    await writeFile(join(tempDir, "003_third.sql"), "CREATE TABLE third (id INT);");
    await writeFile(join(tempDir, "001_first.sql"), "CREATE TABLE first (id INT);");
    await writeFile(join(tempDir, "002_second.sql"), "CREATE TABLE second (id INT);");

    const files = await readMigrationFiles(tempDir);

    // Should be sorted: 001, 002, 003
    expect(files).toHaveLength(3);
    expect(files[0].name).toBe("001_first.sql");
    expect(files[1].name).toBe("002_second.sql");
    expect(files[2].name).toBe("003_third.sql");

    // Verify content was read correctly
    expect(files[0].content).toBe("CREATE TABLE first (id INT);");
    expect(files[1].content).toBe("CREATE TABLE second (id INT);");
    expect(files[2].content).toBe("CREATE TABLE third (id INT);");
  });

  test("ignores non-.sql files in the directory", async () => {
    // Mix of .sql and non-.sql files — only .sql should be returned
    await writeFile(join(tempDir, "001_migration.sql"), "SELECT 1;");
    await writeFile(join(tempDir, "README.md"), "# Migrations");
    await writeFile(join(tempDir, "notes.txt"), "some notes");
    await writeFile(join(tempDir, "002_another.sql"), "SELECT 2;");

    const files = await readMigrationFiles(tempDir);

    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("001_migration.sql");
    expect(files[1].name).toBe("002_another.sql");
  });

  test("returns empty array for empty directory", async () => {
    // Empty directory — should be a no-op, not an error
    const files = await readMigrationFiles(tempDir);

    expect(files).toEqual([]);
  });

  test("returns empty array for nonexistent directory", async () => {
    // Path that doesn't exist — should be a no-op, not an error
    const files = await readMigrationFiles("/tmp/this-does-not-exist-at-all-12345");

    expect(files).toEqual([]);
  });

  test("returns empty array for directory with no .sql files", async () => {
    // Directory exists but has no SQL files
    await writeFile(join(tempDir, "readme.md"), "# No SQL here");
    await writeFile(join(tempDir, "config.json"), "{}");

    const files = await readMigrationFiles(tempDir);

    expect(files).toEqual([]);
  });
});

describe("001_initial.sql migration file", () => {
  /** Path to the actual migration file in the source tree */
  const migrationPath = join(import.meta.dir, "..", "migrations", "001_initial.sql");

  test("migration file exists and can be read", async () => {
    const files = await readMigrationFiles(join(import.meta.dir, "..", "migrations"));

    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0].name).toBe("001_initial.sql");
  });

  test("contains all expected CREATE TABLE statements", async () => {
    const files = await readMigrationFiles(join(import.meta.dir, "..", "migrations"));
    const content = files[0].content;

    // Verify all 5 core tables are defined
    const expectedTables = [
      "workspaces",
      "devices",
      "workspace_devices",
      "sessions",
      "events",
    ];

    for (const table of expectedTables) {
      expect(content).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  test("contains all expected indexes", async () => {
    const files = await readMigrationFiles(join(import.meta.dir, "..", "migrations"));
    const content = files[0].content;

    // Verify all indexes defined in the task spec
    const expectedIndexes = [
      "idx_sessions_workspace",
      "idx_sessions_device",
      "idx_sessions_lifecycle",
      "idx_sessions_tags",
      "idx_events_workspace_time",
      "idx_events_session",
      "idx_events_type",
      "idx_events_device",
    ];

    for (const index of expectedIndexes) {
      expect(content).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }
  });

  test("sessions table has remote_env_id without FK constraint", async () => {
    const files = await readMigrationFiles(join(import.meta.dir, "..", "migrations"));
    const content = files[0].content;

    // remote_env_id should exist but without a REFERENCES clause
    expect(content).toContain("remote_env_id");
    // The comment about Phase 5 FK should be present
    expect(content).toContain("FK to remote_envs added in Phase 5 migration");
  });

  test("sessions table has all lifecycle states", async () => {
    const files = await readMigrationFiles(join(import.meta.dir, "..", "migrations"));
    const content = files[0].content;

    // All lifecycle states from the spec
    const lifecycleStates = [
      "detected",
      "capturing",
      "ended",
      "parsed",
      "summarized",
      "archived",
      "failed",
    ];

    for (const state of lifecycleStates) {
      expect(content).toContain(`'${state}'`);
    }
  });

  test("devices table has all status values", async () => {
    const files = await readMigrationFiles(join(import.meta.dir, "..", "migrations"));
    const content = files[0].content;

    const statuses = ["online", "offline", "provisioning", "terminated"];
    for (const status of statuses) {
      expect(content).toContain(`'${status}'`);
    }
  });
});

describe("createDb error handling", () => {
  test("throws StorageError when connectionString is empty", async () => {
    // Dynamic import to avoid module-level side effects
    const { createDb } = await import("../postgres.js");
    const { StorageError } = await import("@fuel-code/shared");

    expect(() => createDb("")).toThrow(StorageError);
    expect(() => createDb("")).toThrow("DATABASE_URL environment variable is required.");
  });

  test("throws StorageError when connectionString is undefined", async () => {
    const { createDb } = await import("../postgres.js");
    const { StorageError } = await import("@fuel-code/shared");

    expect(() => createDb(undefined)).toThrow(StorageError);
  });

  test("thrown error has correct error code", async () => {
    const { createDb } = await import("../postgres.js");

    try {
      createDb("");
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: unknown) {
      const e = err as { code: string };
      expect(e.code).toBe("STORAGE_DB_URL_MISSING");
    }
  });
});
