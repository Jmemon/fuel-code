/**
 * Lightweight Docker HEALTHCHECK script.
 *
 * Hits /api/health and exits 0 (healthy) or 1 (unhealthy).
 * Used by the Dockerfile's HEALTHCHECK directive — must be fast and dependency-free.
 * fetch() is built into Bun — no imports needed.
 */
export {};

const port = process.env.PORT || "3020";
try {
  const res = await fetch(`http://localhost:${port}/api/health`);
  process.exit(res.ok ? 0 : 1);
} catch {
  // Server not ready yet (connection refused) or network error
  process.exit(1);
}
