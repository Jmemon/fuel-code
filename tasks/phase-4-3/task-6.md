# Task 6: CI Pipeline (GitHub Actions)

## parallel-group: A
## depends-on: none
## blocks: none

---

## Description

Create the GitHub Actions CI workflow and the `typecheck` infrastructure it requires. CI runs on PRs (typecheck + test) and on push to main (typecheck + test + Docker build verification). No linting — only `tsc --noEmit` for type checking (per design decision).

This task also sets up the `typecheck` script across all packages and turbo, since it is the only consumer of this infrastructure and must be independent (no dependency on T1).

---

## Relevant Files

### Create

**`.github/workflows/ci.yml`** — GitHub Actions CI workflow.

Neither `.github/` nor `.github/workflows/` directories exist — both must be created.

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.5"
      - run: bun install --frozen-lockfile
      - run: bun run typecheck

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: fuel_code_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd="pg_isready -U test"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd="redis-cli ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
      localstack:
        image: localstack/localstack:latest
        env:
          SERVICES: s3
          DEFAULT_REGION: us-east-1
        ports:
          - 4566:4566
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.5"
      - run: bun install --frozen-lockfile
      - run: bun test
        env:
          DATABASE_URL: postgresql://test:test@localhost:5432/fuel_code_test
          REDIS_URL: redis://localhost:6379
          API_KEY: test-key
          S3_BUCKET: test-bucket
          S3_REGION: us-east-1
          S3_ENDPOINT: http://localhost:4566
          S3_FORCE_PATH_STYLE: "true"
          AWS_ACCESS_KEY_ID: test
          AWS_SECRET_ACCESS_KEY: test

  docker-build:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - run: |
          docker build \
            --build-arg GIT_SHA=${{ github.sha }} \
            --build-arg GIT_SHORT=$(echo ${{ github.sha }} | cut -c1-7) \
            --build-arg GIT_BRANCH=${{ github.ref_name }} \
            --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
            -t fuel-code .
```

Key decisions:

1. **No lint job**: Per design decision — `tsc --noEmit` only. No biome, no eslint, no linter of any kind. If we add a linter later, it's a separate change.

2. **Bun version pinned to `1.3.5`**: Matches `"packageManager": "bun@1.3.5"` in root `package.json`. Prevents CI from using a different bun version than local dev.

3. **LocalStack included**: S3-dependent tests (transcript upload, etc.) need it. The existing `docker-compose.test.yml` uses `localstack/localstack:latest`. Without it, any test touching S3 fails with connection refused.

4. **`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in test env**: The AWS SDK needs credentials even for LocalStack. Set to `test`/`test` (LocalStack accepts anything).

5. **`typecheck` and `test` run in parallel** on PRs. `docker-build` only runs on push to main (reduces PR feedback latency).

6. **Docker build passes git metadata via build args**: Uses `${{ github.sha }}` from GitHub Actions context. This fully exercises the stamp-version pipeline from T1/T2. Note: the Dockerfile must exist (created by T2) for this to work. On the first push to main before T2 is merged, this job will fail — that's expected and acceptable.

7. **Postgres/Redis versions match `docker-compose.test.yml`**: `postgres:16-alpine` and `redis:7-alpine`.

---

### Modify

**`package.json` (root)** — Add typecheck script.

Add to `scripts` object:
```json
"typecheck": "turbo typecheck"
```

Note: T1 also modifies this file (adds `"stamp"` script). Both add different keys to `scripts` — non-conflicting if run in parallel.

---

**`turbo.json`** — Add typecheck task.

Add `typecheck` to the `tasks` object:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

The `dependsOn: ["^build"]` ensures packages are built in dependency order before typechecking (shared → core → server/cli). This is needed because `tsc --noEmit` without `-b` mode doesn't resolve project references — it needs the built `.d.ts` files from dependencies.

Wait — actually, in this monorepo, packages import each other's `.ts` source directly (not compiled output). The `tsconfig.base.json` has path mappings: `"@fuel-code/shared": ["./packages/shared/src"]`. So `tsc --noEmit` should work without pre-building dependencies, as long as the tsconfig resolves paths correctly.

But each package has `composite: true` in its tsconfig, which was designed for project references with `tsc -b`. When running `tsc --noEmit` per package, the compiler processes that package's files and resolves imports through the path mappings. This should work without `^build` dependency.

Safest approach: use `"dependsOn": []` (no dependencies). This allows all packages to typecheck in parallel and avoids needing a build step. If this fails because of cross-package type resolution, fall back to `"dependsOn": ["^build"]`.

Final decision: **use `"dependsOn": []`**. Test locally with `bun run typecheck` to verify.

```json
"typecheck": {}
```

(Turbo uses `{}` for tasks with no configuration, meaning no dependencies and no outputs.)

---

**`packages/shared/package.json`** — Add typecheck script.

Add to `scripts`:
```json
"typecheck": "tsc --noEmit"
```

Note: All 4 TypeScript packages (`shared`, `core`, `server`, `cli`) have `composite: true` in their tsconfigs. In TypeScript 5.7+, `tsc --noEmit` works with `composite: true` (the `--noEmit` flag overrides the composite requirement for declaration emit). If this does NOT work (error: "Option 'noEmit' cannot be specified with option 'composite'"), the fallback is `tsc --noEmit --composite false` which explicitly disables composite on the command line.

---

**`packages/core/package.json`** — Add typecheck script.

Add to `scripts`:
```json
"typecheck": "tsc --noEmit"
```

---

**`packages/server/package.json`** — Add typecheck script.

Add to `scripts`:
```json
"typecheck": "tsc --noEmit"
```

---

**`packages/cli/package.json`** — Add typecheck script.

Add to `scripts`:
```json
"typecheck": "tsc --noEmit"
```

---

**`packages/hooks/package.json`** — No typecheck script needed.

The `hooks` package has no `tsconfig.json` — it's shell scripts and a test file. Turbo automatically skips packages that don't define the requested script. No changes needed.

---

### Read (for context)

- `docker-compose.test.yml` — service versions (postgres:16-alpine, redis:7-alpine, localstack)
- `package.json` (root) — existing scripts, `packageManager` field
- `turbo.json` — existing task definitions
- `packages/*/package.json` — existing scripts (build, test)
- `packages/shared/tsconfig.json` — check `composite: true`
- `tsconfig.base.json` — path mappings

---

## Success Criteria

### Typecheck Infrastructure
- `bun run typecheck` succeeds locally. Turbo runs `tsc --noEmit` in all 4 TypeScript packages (shared, core, server, cli) and skips `hooks`.
- If `tsc --noEmit` fails with a composite conflict error, update to `tsc --noEmit --composite false` in each package.
- Type errors (if any) are reported clearly. Fix them before merging.

### CI Workflow Syntax
- `.github/workflows/ci.yml` is valid YAML.
- GitHub Actions parses it without errors (verify by pushing a branch and checking the Actions tab, or use `act` for local validation if available).

### PR Triggers
- Opening a PR against `main` triggers the `typecheck` and `test` jobs in parallel.
- The `docker-build` job does NOT run on PRs (only on push to main).

### Push to Main
- Pushing to `main` triggers all three jobs: `typecheck`, `test`, `docker-build`.
- The `docker-build` job builds the Dockerfile with version stamping via `--build-arg GIT_SHA=${{ github.sha }}`.

### Test Job
- Tests run against real Postgres, Redis, and LocalStack (not mocks).
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are set in the test env so the AWS SDK can authenticate with LocalStack.
- Service container health checks ensure Postgres and Redis are ready before tests start.

### Docker Build Job
- `docker build` succeeds on current main (once T2's Dockerfile exists).
- Build args are passed correctly — the stamped version in the image matches `${{ github.sha }}`.

### Edge Cases
- If T2's Dockerfile doesn't exist yet (T6 runs before T2 is merged), the `docker-build` job fails. This is expected — the job only runs on push to main, and T2 should be merged first.
- `bun install --frozen-lockfile` fails if `bun.lock` is out of sync — this is intentional CI safety.
- LocalStack may take 10-20s to start. GitHub Actions service containers start before job steps, but LocalStack may not be ready for the first test. If this is an issue, add a `sleep 5` step or a health check wait step before `bun test`.

### Negative Tests
- No `bun run lint` step exists in the workflow — there is no linter.
- No deployment steps, no CD, no publishing.
