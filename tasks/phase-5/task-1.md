# Task 1: Blueprint Detector — Auto-Detect Project Environment

## Parallel Group: A

## Dependencies: None

## Description

Implement the blueprint auto-detection engine in `packages/core/src/blueprint-detector.ts`. This module scans a project's files to determine runtime, version, package manager, system dependencies, Docker base image, and setup commands. It receives a structured `ProjectInfo` object (no direct filesystem I/O) and returns a complete `BlueprintConfig`. The CLI layer handles reading files from disk and building the `ProjectInfo`; the detector is a pure function.

### Interface

```typescript
// Input: structured project info (no filesystem I/O in detector)
export interface ProjectInfo {
  // Relative path → file content (only config files: package.json, pyproject.toml, etc.)
  files: Map<string, string>;
  // All file paths in the project (for pattern detection like lockfile presence)
  fileList: string[];
  // Git remote URL (for workspace resolution context)
  gitRemote: string | null;
  // Current git branch
  gitBranch: string | null;
}

// Output: complete blueprint config (matches BlueprintConfig Zod schema in packages/shared)
export function detectBlueprint(project: ProjectInfo): BlueprintConfig;
```

### Detection Strategy

The detector uses a priority-ordered pipeline of scanners. Each scanner checks for specific files and extracts partial configuration. First matching runtime wins; system deps and ports are merged across all scanners.

**Runtime detection (priority order)**:

1. **Node.js**: `package.json` exists.
   - Version: parse `engines.node` from package.json. If absent, default `"22"`.
   - Package manager: check `fileList` for lockfiles — `bun.lockb` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm. Default: npm.
   - Base image: `node:{version}-bookworm`.
   - Setup: `{package_manager} install`.
   - Ports: scan `scripts.start` / `scripts.dev` for `--port <N>` or common patterns (`:3000`, `:8080`).

2. **Python**: `pyproject.toml`, `requirements.txt`, `Pipfile`, or `setup.py` exists.
   - Version: parse `[project].requires-python` from pyproject.toml, or `.python-version` file. Default `"3.12"`.
   - Package manager: `uv.lock` → uv, `poetry.lock` → poetry, `Pipfile.lock` → pipenv. Default: pip.
   - Base image: `python:{version}-bookworm`.
   - Setup: `uv sync` for uv, `poetry install` for poetry, `pip install -r requirements.txt` for pip, `pip install -e .` for setup.py.

3. **Go**: `go.mod` exists.
   - Version: parse `go` directive from go.mod. Default `"1.22"`.
   - Package manager: `go`.
   - Base image: `golang:{version}-bookworm`.
   - Setup: `go mod download`.

4. **Rust**: `Cargo.toml` exists.
   - Version: parse `rust-version` from Cargo.toml. Default `"stable"`. For stable, base image uses `rust:1-bookworm`.
   - Package manager: `cargo`.
   - Base image: `rust:{version}-bookworm`.
   - Setup: `cargo build`.

5. **Ruby**: `Gemfile` exists.
   - Version: parse from `.ruby-version`. Default `"3.3"`.
   - Package manager: `bundler`.
   - Base image: `ruby:{version}-bookworm`.
   - Setup: `bundle install`.

6. **Generic/Fallback**: No recognized project files.
   - Runtime: `generic`.
   - Base image: `ubuntu:24.04`.
   - Setup: empty array.

**System dependency detection** (merged across all strategies):
- `docker-compose.yml` or `compose.yaml` with service name containing `postgres` → add `postgresql-client` to system_deps.
- `docker-compose.yml` with service name containing `redis` → add `redis-tools`.
- `docker-compose.yml` with service name containing `mysql` → add `default-mysql-client`.
- `Makefile` presence in fileList → add `make`.

**Resource defaults**:
- `instance_type`: `t3.xlarge`
- `region`: `us-east-1`
- `disk_gb`: `50`

### Relevant Files

**Create:**
- `packages/core/src/blueprint-detector.ts` (replace placeholder)
- `packages/core/src/__tests__/blueprint-detector.test.ts`

**Modify:**
- `packages/core/src/index.ts` — export `detectBlueprint` and `ProjectInfo`

### Tests

`blueprint-detector.test.ts` (bun:test):

1. Node.js project with `package.json` + `bun.lockb` → runtime=node, pm=bun, base_image=node:22-bookworm, setup=["bun install"].
2. Node.js project with `package.json` + `yarn.lock` → pm=yarn.
3. Node.js with explicit `engines.node: "20"` → version=20, base_image=node:20-bookworm.
4. Node.js with `scripts.start` containing `--port 3000` → ports includes 3000.
5. Python project with `pyproject.toml` + `uv.lock` → runtime=python, pm=uv, setup=["uv sync"].
6. Python project with `requirements.txt` only → pm=pip, setup=["pip install -r requirements.txt"].
7. Go project with `go.mod` containing `go 1.22` → runtime=go, version=1.22.
8. Rust project with `Cargo.toml` → runtime=rust, pm=cargo, setup=["cargo build"].
9. Ruby project with `Gemfile` → runtime=ruby, pm=bundler, setup=["bundle install"].
10. No recognized files → runtime=generic, base_image=ubuntu:24.04, setup=[].
11. Node.js + `docker-compose.yml` with postgres service → system_deps includes `postgresql-client`.
12. Node.js + `docker-compose.yml` with redis service → system_deps includes `redis-tools`.
13. Project with `Makefile` → system_deps includes `make`.
14. Multiple signals merged: Node.js + Makefile + docker-compose with postgres → all merged correctly.
15. Empty project (no files, empty fileList) → falls through to generic.
16. Malformed `package.json` (invalid JSON) → falls through to next runtime, does not throw.
17. Output passes BlueprintConfig Zod schema validation for every test case.

### Success Criteria

1. `detectBlueprint()` correctly identifies Node.js, Python, Go, Rust, Ruby, and generic projects.
2. Package manager detection is accurate for all supported lockfiles (bun, npm, yarn, pnpm, uv, poetry, pipenv, pip, cargo, bundler, go).
3. Version extraction works from package.json `engines.node`, pyproject.toml `requires-python`, go.mod `go` directive, Cargo.toml `rust-version`, `.ruby-version`, `.python-version`, `.node-version`.
4. System dependency detection finds postgres, redis, mysql from docker-compose service names.
5. Resource defaults are sensible (t3.xlarge, us-east-1, 50GB).
6. The function is pure — no filesystem I/O, no network calls, no side effects.
7. Output matches the `BlueprintConfig` Zod schema for every test case.
8. Edge cases (missing fields, malformed files, empty inputs) produce reasonable defaults, not crashes.
