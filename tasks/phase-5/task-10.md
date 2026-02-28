# Task 10: Blueprint CLI Commands (detect, show, validate)

## Parallel Group: D

## Dependencies: Tasks 1, 2

## Description

Implement the three blueprint CLI commands using Commander. These commands handle filesystem I/O that the detector engine (Task 1) and I/O layer (Task 2) provide. The commands scan the current directory, read/write `.fuel-code/env.yaml`, and display validation results.

### Command: `fuel-code blueprint detect`

1. Determine workspace directory: CWD or `--repo <path>`.
2. Check if `.fuel-code/env.yaml` already exists. If so, show a diff and prompt "Overwrite? [y/N]" (auto-no for safety). Skip prompt with `--force`.
3. Read relevant project files from the directory (package.json, pyproject.toml, Cargo.toml, go.mod, docker-compose.yml, Makefile, .nvmrc, .python-version, .ruby-version, etc.).
4. Build a `ProjectInfo` object: files map (path → content for config files), fileList (all file paths), gitRemote, gitBranch.
5. Call `detectBlueprint(projectInfo)` from Task 1.
6. Display the detected config in YAML format with annotations:
   ```
   Detected environment for fuel-code:

     runtime: node
     version: "22"
     package_manager: bun
     system_deps:
       - postgresql-client
     docker:
       base_image: "node:22-bookworm"
     resources:
       instance_type: t3.xlarge
       region: us-east-1
       disk_gb: 50
     ports:
       - 3000
     setup:
       - bun install

   Written to .fuel-code/env.yaml
   Review and edit as needed, then run `fuel-code remote up`.
   ```
7. Call `writeBlueprint(dir, config)` from Task 2 to write the file.
8. `--dry-run` flag: show what would be detected without writing.
9. `--json` flag: output detected config as JSON without prompts.

### Command: `fuel-code blueprint show`

1. Read `.fuel-code/env.yaml` via `readBlueprint(dir)` from Task 2.
2. If missing: print "No blueprint found. Run `fuel-code blueprint detect` to generate one." and exit 1.
3. Display formatted YAML with picocolors syntax highlighting (dim keys, bright values).
4. `--json` flag: output as JSON.

### Command: `fuel-code blueprint validate`

1. Read `.fuel-code/env.yaml` via `readBlueprint(dir)` from Task 2.
2. If missing: print error and exit 1.
3. Call `validateBlueprint(config)` from Task 2.
4. Display results:
   - Valid: green checkmark + "Blueprint is valid."
   - Invalid: red X + each error with field path and message:
     ```
     Blueprint validation errors:

       resources.instance_type: Invalid instance type "t3.nano"
       docker.base_image: Required field missing
       resources.disk_gb: Must be between 20 and 1000

     Fix errors in .fuel-code/env.yaml and re-run validate.
     ```
5. Exit 0 if valid, exit 1 if invalid.

### Command Registration

Register as a `blueprint` subcommand group in Commander:

```typescript
// packages/cli/src/commands/blueprint.ts
export function registerBlueprintCommands(program: Command): void {
  const blueprint = program.command('blueprint').description('Manage environment blueprints');

  blueprint
    .command('detect')
    .description('Auto-detect project environment and generate .fuel-code/env.yaml')
    .option('--repo <path>', 'Path to repository (default: current directory)')
    .option('--force', 'Overwrite existing env.yaml without prompting')
    .option('--dry-run', 'Show detected config without writing')
    .option('--json', 'Output as JSON')
    .action(detectAction);

  blueprint
    .command('show')
    .description('Display current .fuel-code/env.yaml')
    .option('--json', 'Output as JSON')
    .action(showAction);

  blueprint
    .command('validate')
    .description('Validate .fuel-code/env.yaml against schema')
    .option('--json', 'Output validation result as JSON')
    .action(validateAction);
}
```

### Relevant Files

**Create:**
- `packages/cli/src/commands/blueprint.ts`
- `packages/cli/src/commands/__tests__/blueprint.test.ts`

**Modify:**
- `packages/cli/src/index.ts` — import and call `registerBlueprintCommands(program)`

### Tests

`blueprint.test.ts` (bun:test, using temp directories):

1. `detect` in a Node.js project (package.json + bun.lockb) → generates correct env.yaml.
2. `detect` with existing env.yaml → prompts for overwrite. Test "n" (no overwrite).
3. `detect --force` with existing env.yaml → overwrites without prompt.
4. `detect --dry-run` → shows config but does NOT write file.
5. `detect --json` → outputs JSON, no interactive prompts.
6. `detect` in empty directory → generates generic blueprint.
7. `detect` creates `.fuel-code/` directory if it doesn't exist.
8. `show` with existing env.yaml → prints formatted YAML.
9. `show` with no env.yaml → prints helpful message, exit 1.
10. `show --json` → outputs JSON.
11. `validate` with valid env.yaml → prints "Blueprint is valid.", exit 0.
12. `validate` with invalid env.yaml (bad instance type) → prints errors, exit 1.
13. `validate` with missing env.yaml → prints error, exit 1.
14. `validate --json` → outputs structured validation result.
15. All three commands are registered under `blueprint` subcommand group.
16. `fuel-code blueprint --help` lists all three subcommands.

### Success Criteria

1. `fuel-code blueprint detect` auto-detects and writes env.yaml for the current directory.
2. Overwrite prompt prevents accidental loss of manually-edited blueprints.
3. `--force`, `--dry-run`, `--json` flags work correctly on `detect`.
4. `fuel-code blueprint show` displays current env.yaml or helpful error message.
5. `fuel-code blueprint validate` shows pass/fail with field-specific error messages.
6. Exit codes: 0 for success, 1 for errors/invalid.
7. Commands registered in Commander and appear in `fuel-code --help` and `fuel-code blueprint --help`.
8. `.fuel-code/` directory created if needed.
9. `--json` flag works on all three subcommands.
