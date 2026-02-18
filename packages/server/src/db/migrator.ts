/**
 * Custom SQL migration runner for fuel-code.
 *
 * Reads raw `.sql` files from a directory, tracks applied migrations in a
 * `_migrations` table, and applies unapplied ones in lexicographic order.
 *
 * Key design decisions:
 *   - Uses an advisory lock (pg_advisory_lock) to prevent concurrent migration runs
 *   - Each migration runs in its own transaction — if one fails, subsequent
 *     migrations are still attempted (fail-forward) and errors are collected
 *   - If the migrations directory doesn't exist or is empty, it's a no-op
 *   - Migration names are the filenames (e.g., "001_initial.sql")
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type postgres from "postgres";

/** Advisory lock ID — chosen arbitrarily, must be consistent across instances */
const ADVISORY_LOCK_ID = 48756301;

/** Result of a migration run, reporting what happened for each file */
export interface MigrationResult {
  /** Migrations that were successfully applied in this run */
  applied: string[];
  /** Migrations that were already applied (skipped) */
  skipped: string[];
  /** Migrations that failed, with error messages */
  errors: Array<{ name: string; error: string }>;
}

/**
 * Run all pending SQL migrations from the given directory.
 *
 * Steps:
 *   1. Ensure the `_migrations` tracking table exists
 *   2. Acquire an advisory lock to serialize concurrent migration runs
 *   3. Read and sort all `.sql` files from the migrations directory
 *   4. Compare against already-applied migrations in `_migrations`
 *   5. Apply each unapplied migration inside its own transaction
 *   6. Release the advisory lock
 *   7. Return a summary of what was applied, skipped, or errored
 *
 * @param sql           - A postgres.js client instance
 * @param migrationsDir - Absolute path to the directory containing .sql files
 * @returns Summary of migration results
 */
export async function runMigrations(
  sql: postgres.Sql,
  migrationsDir: string,
): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: [], errors: [] };

  // Step 0: Read migration files from disk. If the directory doesn't exist
  // or is empty, return a no-op result immediately (no DB interaction needed).
  const migrationFiles = await readMigrationFiles(migrationsDir);
  if (migrationFiles.length === 0) {
    return result;
  }

  // Step 1: Create the _migrations tracking table if it doesn't already exist.
  // This table records which migrations have been successfully applied.
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Step 2: Acquire an advisory lock to prevent concurrent migration runs.
  // This is a session-level lock — it's released when we explicitly unlock or disconnect.
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_ID})`;

  try {
    // Step 3: Get the list of already-applied migrations from the database
    const applied = await sql`SELECT name FROM _migrations`;
    const appliedSet = new Set(applied.map((row) => row.name));

    // Step 4: For each migration file, either skip (already applied) or apply
    for (const file of migrationFiles) {
      if (appliedSet.has(file.name)) {
        result.skipped.push(file.name);
        continue;
      }

      // Step 5: Apply unapplied migration inside a transaction.
      // On failure, rollback and record the error, then continue with the next file.
      try {
        await sql.begin(async (tx) => {
          // Execute the raw SQL from the migration file
          await tx.unsafe(file.content);

          // Record that this migration was applied
          await tx`INSERT INTO _migrations (name) VALUES (${file.name})`;
        });

        result.applied.push(file.name);
        console.log(`[migrator] Applied: ${file.name}`);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown migration error";
        result.errors.push({ name: file.name, error: errorMessage });
        console.error(`[migrator] Failed: ${file.name} — ${errorMessage}`);
      }
    }
  } finally {
    // Step 6: Always release the advisory lock, even if something threw
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`;
  }

  // Step 7: Return the summary
  return result;
}

/** Internal representation of a migration file read from disk */
interface MigrationFile {
  /** Filename (e.g., "001_initial.sql") — used as the migration name */
  name: string;
  /** Raw SQL content of the file */
  content: string;
}

/**
 * Read all .sql files from the migrations directory, sorted lexicographically.
 *
 * Returns an empty array if the directory doesn't exist or contains no .sql files.
 * This makes the migrator safe to call even before any migrations are written.
 *
 * @param dir - Absolute path to the migrations directory
 * @returns Sorted array of migration files with their contents
 */
export async function readMigrationFiles(
  dir: string,
): Promise<MigrationFile[]> {
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist — not an error, just nothing to migrate
    return [];
  }

  // Filter to only .sql files and sort lexicographically (001_ before 002_, etc.)
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

  if (sqlFiles.length === 0) {
    return [];
  }

  // Read each file's content
  const files: MigrationFile[] = [];
  for (const name of sqlFiles) {
    const content = await readFile(join(dir, name), "utf-8");
    files.push({ name, content });
  }

  return files;
}
