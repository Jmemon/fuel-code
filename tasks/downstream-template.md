# Downstream Impact Review — Formal Structure Template

## Document Format

```
# Phase X Downstream Impact Review

> **Reviewed by**: <team composition>
> **Scope**: Phase X — <phase name>
> **Codebase state**: Phases 1 through X implemented
> **Review target**: Impact on Phases Y through Z

## Purpose

Determine whether Phase X's implementation (as-built vs as-planned) breaks
assumptions, prerequisites, or implicit contracts in downstream phases.
Each finding compares:
  - The downstream phase's **spec claim** (DAG line, task file quote)
  - Phase X's **actual implementation** (file path + line number)
  - The **delta** between planned and actual that causes the break

---

## Phase Y: <Phase Name>

### Schema & Migration Assumptions
Table of every DB artifact that Phase Y's DAG/tasks expect Phase X to have created:

| ID | Claimed Artifact | Source (DAG/task line) | Phase X Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| Y.S.n | ... | ... | ... | OK / BROKEN / DRIFT / NEEDS REWORK |

#### Findings
##### [X→Y.S.n] <title> — Severity: CRITICAL / HIGH / MEDIUM / LOW / NONE
**Spec claim**: Exact quote from downstream DAG/task with file reference
**Actual state**: File path:line number, or confirmed absence
**Impact**: What breaks, why, and how badly
**Recommended fix**: Concrete action (who does what, in which file)

### Code Artifact Assumptions
Table of every source file, module, function, class, type, or directory that
Phase Y expects Phase X to have created or modified:

| ID | Claimed Artifact | Source | Phase X Actual State | Status |
|----|-----------------|--------|---------------------|--------|

#### Findings
##### [X→Y.C.n] <title> — Severity: ...

### API Contract Assumptions
Table of every endpoint, request/response shape, or protocol that Phase Y
consumes from Phase X's deliverables:

| ID | Claimed Contract | Source | Phase X Actual State | Status |
|----|-----------------|--------|---------------------|--------|

#### Findings
##### [X→Y.A.n] <title> — Severity: ...

### Behavioral / Semantic Assumptions
Table of runtime behaviors (lifecycle states, event processing, correlation
logic, state transitions) that Phase Y assumes Phase X established:

| ID | Claimed Behavior | Source | Phase X Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|

#### Findings
##### [X→Y.B.n] <title> — Severity: ...

---

(Repeat for each downstream phase)

---

## Cross-Phase Concerns

Findings that affect multiple downstream phases simultaneously.

| Finding | Affected Phases | Description | Severity |
|---------|----------------|-------------|----------|

---

## Summary Table

| ID | Downstream Phase | Section | Severity | Title | Requires Fix Before That Phase? |
|----|-----------------|---------|----------|-------|---------------------------------|

## Verdict

**STATUS**: READY / READY WITH FIXES / BLOCKED

### Must Fix Before Downstream Phases Start
(numbered list, grouped by target phase)

### Can Fix During Downstream Phases
(numbered list)

### Informational Only
(numbered list)
```

## Severity Definitions

- **CRITICAL**: Will cause compilation failure, runtime crash, or data corruption in the downstream phase
- **HIGH**: Will require significant rework or spec changes in the downstream phase
- **MEDIUM**: Requires minor adjustments or spec clarification; workaround exists
- **LOW**: Cosmetic, naming, or documentation issue; trivial to fix
- **NONE**: No issue (informational / already resolved)

## Status Column Values

- **OK**: Artifact exists and matches downstream expectation
- **BROKEN**: Artifact missing, wrong, or incompatible with downstream expectation
- **DRIFT**: Artifact exists but differs from spec in ways that may cause issues
- **NEEDS REWORK**: Artifact exists but needs modification to match downstream needs
- **NEEDS PHASE N**: Depends on a phase that hasn't been implemented yet

## Finding ID Convention

`[SourcePhase→TargetPhase.Section.Number]`
- SourcePhase: The phase being reviewed (e.g., 3)
- TargetPhase: The downstream phase affected (e.g., 4)
- Section: S (Schema), C (Code), A (API), B (Behavioral)
- Number: Sequential within section

Example: `[3→4.C.2]` = Phase 3 downstream review, impact on Phase 4, Code section, finding #2
