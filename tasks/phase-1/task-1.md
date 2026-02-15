# Task 1: Monorepo Scaffold

## Parallel Group: A

## Description

Create the bun workspaces monorepo structure from scratch. This is the build foundation that every other task depends on. No code logic — just project configuration, package manifests, and TypeScript setup.

### Files to Create

**`/package.json`** (root):
```json
{
  "name": "fuel-code",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "bun run --filter '*' build",
    "test": "bun test --recursive",
    "clean": "rm -rf packages/*/dist"
  },
  "devDependencies": {
    "typescript": "^5.7",
    "@types/node": "^22"
  }
}
```

**`/bunfig.toml`**:
```toml
[install]
peer = false
```

**`/tsconfig.base.json`**:
- `target`: `"ESNext"`
- `module`: `"ESNext"`
- `moduleResolution`: `"bundler"`
- `strict`: `true`
- `esModuleInterop`: `true`
- `skipLibCheck`: `true`
- `declaration`: `true`
- `declarationMap`: `true`
- `sourceMap`: `true`
- `resolveJsonModule`: `true`
- `isolatedModules`: `true`
- `paths`: map `@fuel-code/shared`, `@fuel-code/core`, `@fuel-code/cli` to their `src/` directories

**`/packages/shared/package.json`**:
- name: `@fuel-code/shared`
- `"type": "module"`
- `"main": "./src/index.ts"` (bun runs TS directly)
- `"types": "./src/index.ts"`
- No dependencies yet (added per-task via `bun add`)

**`/packages/shared/tsconfig.json`**: extends `../../tsconfig.base.json`, `rootDir: "src"`, `outDir: "dist"`

**`/packages/shared/src/index.ts`**: empty barrel export with comment `// Barrel export — populated as types/schemas/utils are added`

**`/packages/core/package.json`**:
- name: `@fuel-code/core`
- `"type": "module"`
- dependencies: `@fuel-code/shared` via `"workspace:*"`

**`/packages/core/tsconfig.json`**: extends base, references shared

**`/packages/core/src/index.ts`**: empty barrel export

**`/packages/server/package.json`**:
- name: `@fuel-code/server`
- `"type": "module"`
- dependencies: `@fuel-code/shared` and `@fuel-code/core` via `"workspace:*"`

**`/packages/server/tsconfig.json`**: extends base, references shared and core

**`/packages/server/src/index.ts`**: placeholder `// Server entry point — built in Task 6`

**`/packages/cli/package.json`**:
- name: `@fuel-code/cli`
- `"type": "module"`
- `"bin": { "fuel-code": "./src/index.ts" }` (bun can run .ts directly as binary)
- dependencies: `@fuel-code/shared` via `"workspace:*"`

**`/packages/cli/tsconfig.json`**: extends base, references shared

**`/packages/cli/src/index.ts`**: placeholder `// CLI entry point — built in Task 5`

**`/packages/hooks/package.json`**:
- name: `@fuel-code/hooks`
- `"type": "module"`
- minimal (shell scripts + TS helpers, no heavy deps)

**`/.gitignore`**:
```
node_modules/
dist/
.env
.env.*
*.log
.DS_Store
```

After creating all files, run `bun install` from root to link workspaces and install TypeScript.

## Relevant Files
- `/package.json` (create)
- `/bunfig.toml` (create)
- `/tsconfig.base.json` (create)
- `/packages/shared/package.json` (create)
- `/packages/shared/tsconfig.json` (create)
- `/packages/shared/src/index.ts` (create)
- `/packages/core/package.json` (create)
- `/packages/core/tsconfig.json` (create)
- `/packages/core/src/index.ts` (create)
- `/packages/server/package.json` (create)
- `/packages/server/tsconfig.json` (create)
- `/packages/server/src/index.ts` (create)
- `/packages/cli/package.json` (create)
- `/packages/cli/tsconfig.json` (create)
- `/packages/cli/src/index.ts` (create)
- `/packages/hooks/package.json` (create)
- `/.gitignore` (create)

## Success Criteria
1. `bun install` from repo root completes with zero errors.
2. All 5 workspace packages are linked (verify with `bun pm ls`).
3. A test import works: create a temporary file in `packages/cli/` that does `import {} from "@fuel-code/shared"` — it compiles without errors.
4. `bun test` from root exits 0 (no tests yet, but runner initializes).
5. Root `package.json` has `"private": true`.
6. All workspace packages have `"type": "module"`.
7. Deleting `node_modules/` and re-running `bun install` is reproducible.
8. TypeScript strict mode is enabled in the base config.
9. `packages/cli/package.json` has a `bin` entry pointing to `./src/index.ts`.
