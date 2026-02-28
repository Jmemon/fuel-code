# Phase 4-3 Task DAG: Self-Hosted Distribution & Update System

## Dependency Graph

```
T1 ──→ T2 ──→ T3
 │      └───→ T4
 └───→ T5
T6 (independent)
```

## Parallel Groups

| Group | Tasks | Runs After |
|-------|-------|------------|
| A     | T1, T6 | — (no dependencies) |
| B     | T2, T5 | All Group A tasks |
| C     | T3, T4 | All Group B tasks |

**T1 and T6** can run in parallel (Group A). Both modify root `package.json` but add different script keys (`stamp` vs `typecheck`) — non-conflicting.

After T1 completes: **T2 and T5** can run in parallel (Group B).

After T2 completes: **T3 and T4** can run in parallel (Group C).

## Task Summary

| Task | Name | Group | Depends On | Blocks |
|------|------|-------|------------|--------|
| T1 | Version Stamping & Build Info | A | — | T2, T5 |
| T2 | Production Dockerfile | B | T1 | T3, T4 |
| T3 | Production Docker Compose | C | T2 | — |
| T4 | Railway Deployment Config | C | T2 | — |
| T5 | Update Notification System | B | T1 | — |
| T6 | CI Pipeline (GitHub Actions) | A | — | — |

## Shared File Modification Map

Files modified by multiple tasks (explicit ordering required):

| File | T1 | T6 | Notes |
|------|----|----|-------|
| `package.json` (root) | Adds `"stamp"` script | Adds `"typecheck"` script | Non-conflicting: different keys in `scripts` object |

All other file modifications are single-task-only — no conflicts.
