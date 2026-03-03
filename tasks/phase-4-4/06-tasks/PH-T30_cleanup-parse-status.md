# Task 30: Cleanup — Remove `parse_status` References Everywhere

## Phase: H — Cleanup + Tests
## Dependencies: All Phase G tasks
## Parallelizable With: T29

---

## Description

Final sweep to remove all `parse_status` references from the codebase.

## Files

- **Modify**: All files with `parse_status` references (grep to find)
- Expected locations: test files, API client types, TUI components that display status

## How to Test

```bash
grep -r "parse_status" packages/ --include="*.ts" | grep -v node_modules
# Should return 0 results

grep -r "parse_error" packages/ --include="*.ts" | grep -v node_modules
# Should return 0 results (replaced by last_error)

bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

## Success Criteria

1. Zero `parse_status` references in production code
2. Zero `parse_error` references in production code
3. `last_error` used consistently as the error field
4. All tests pass
