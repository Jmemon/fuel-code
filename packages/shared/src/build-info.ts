/**
 * Build metadata — git SHA, build timestamp, branch.
 *
 * In production (after `bun run stamp`), exports values from the generated file.
 * In development (no stamp), exports safe defaults so the app never crashes.
 *
 * Uses top-level await + dynamic import to handle the missing generated file gracefully.
 * The .js extension in the import path is required by moduleResolution: "bundler".
 */

export interface BuildInfo {
  readonly commitSha: string;
  readonly commitShort: string;
  readonly buildDate: string;
  readonly branch: string;
}

const DEV_BUILD_INFO: BuildInfo = {
  commitSha: "development",
  commitShort: "dev",
  buildDate: new Date().toISOString(),
  branch: "unknown",
};

let _resolved: BuildInfo = DEV_BUILD_INFO;
try {
  const mod = await import("./build-info.generated.js");
  _resolved = mod.BUILD_INFO;
} catch {
  // Generated file doesn't exist — running in dev mode, use defaults
}

export const BUILD_INFO: BuildInfo = _resolved;
