# Plan: Sprint program layer Slice 1: semantic layering and sprints schema

> **Status**: Archived
> **Created**: 20260610-1746
> **Slug**: sprint-program-layer-slice1
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260610-1746-sprint-program-layer-slice1.contract.md`
> **Sprint Review**: `tasks/reviews/20260610-1746-sprint-program-layer-slice1.review.md`
> **Implementation Notes**: `tasks/notes/20260610-1746-sprint-program-layer-slice1.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260610-1746-sprint-program-layer-slice1.md`
- Sprint contract: `tasks/contracts/20260610-1746-sprint-program-layer-slice1.contract.md`
- Sprint review: `tasks/reviews/20260610-1746-sprint-program-layer-slice1.review.md`
- Implementation notes: `tasks/notes/20260610-1746-sprint-program-layer-slice1.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260610-1746-sprint-program-layer-slice1.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260610-1746-sprint-program-layer-slice1.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260610-1746-sprint-program-layer-slice1.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260610-1746-sprint-program-layer-slice1.contract.md`
- Review file: `tasks/reviews/20260610-1746-sprint-program-layer-slice1.review.md`
- Implementation notes file: `tasks/notes/20260610-1746-sprint-program-layer-slice1.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260610-1746-sprint-program-layer-slice1.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260610-1746-sprint-program-layer-slice1.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260610-1746-sprint-program-layer-slice1.contract.md`, `tasks/reviews/20260610-1746-sprint-program-layer-slice1.review.md`, and `tasks/notes/20260610-1746-sprint-program-layer-slice1.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260610-1746-sprint-program-layer-slice1.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260610-1746-sprint-program-layer-slice1.md`; after execution revert branch `codex/sprint-program-layer-slice1` or the generated task artifacts

## Captured Planning Output

# Sprint Program Layer — approved design (v2, cross-model reviewed)

## Problem & Requirements

1. Add an explicit PM+architect-level planning surface: a `repo-harness-sprint` command facade that discusses a PRD with the user and decomposes it into an ordered sprint backlog.
2. The backlog must be a repo file that later agent sessions can track and execute task-by-task (incremental mode).
3. Support "goal" runs: one invocation drives the whole backlog to completion (Claude and Codex hosts).
4. Refactor loop responsibilities so each component has exactly one owner.

## Decisions (user-approved 2026-06-10)

- Carrier: new `tasks/sprints/` module. `tasks/todo.md` stays a deferred-goal ledger (semantics enforced by ~30+ files). Task contracts do NOT carry PRDs.
- Goal mechanism: explicit continuous protocol (autoplan-style CHECKPOINT rules) is the primary mechanism; the Claude-side Stop-hook continuation (`stop-orchestrator.sh`) is a safety net only; Codex side is protocol-only.
- Global `~/.claude` loop shells (loop-start/loop-status/loop-operator + 5 empty skill dirs) are deleted as an ops step outside repo acceptance; ralph-loop plugin stays and is not a dependency.
- Terminology: two layers only — "Sprint" (program level, `tasks/sprints/`) and "Task Contract" (execution slice). `verify-sprint.sh` filename kept for downstream compatibility and documented as a legacy filename. No third term.
- Cross-model review (Codex) incorporated: Slice 1 is purely additive (no wiring into capture-plan/finish), the template drift sweep is in scope, finish integration stays warn-only fail-safe.

## Architecture map (P1)

- Existing layers: `docs/spec.md` (product truth) → `plans/plan-*.md` (single slice with Evidence Contract + Task Breakdown) → `tasks/contracts|reviews|notes` trio → worktree finish gates (external acceptance → `verify-sprint.sh` → merge back).
- Missing layer: PRD→N-task ordering between spec and plans. `tasks/sprints/` fills it.
- Stop hook mount point exists: `src/cli/hook/route-registry.ts` Stop.default → `stop-orchestrator.sh` (Slice 3 only).
- Distribution: every helper script needs `scripts/` + `assets/templates/helpers/` parity; command facades register in `assets/skill-commands/manifest.json` + tests + 3 docs + evals (Slice 2).

## Target end-to-end trace (P2)

sprint plan → `tasks/sprints/<stamp>-<slug>.sprint.md` (PRD + Architecture Notes + ordered Backlog + Execution Log)
→ sprint run → next backlog task → `capture-plan.sh --source repo-harness-sprint` → `plan-to-todo.sh` → contract worktree → implement → `/check` + external acceptance → finish (`verify-sprint.sh` → merge) → `sprint-backlog.sh complete-task` back-fills the sprint doc.
Goal mode adds continuation only (Stop hook reads goal state and re-prompts the next task; it never executes tasks, finish, or merge itself).

## Slices

- Slice 1 (THIS PLAN): semantic layering + sprints schema, purely additive. Scope below.
- Slice 2 (deferred): wiring + facade — `sprint-backlog.sh start-task` (capture-plan `--source repo-harness-sprint` registration incl. `scripts/lib/project-init-lib.sh` policy template), warn-only finish back-fill in `contract-worktree.sh`, `assets/skill-commands/repo-harness-sprint/SKILL.md` (plan/run/status; run incremental only), manifest/README/root-SKILL/flow-docs/evals/tests registration.
- Slice 3 (deferred): goal continuation — `run --goal` protocol (CHECKPOINT rules), `stop-orchestrator.sh` goal-state branch (max-iterations default 25, explicit cancel, corrupt-state self-clear), hook-runtime tests. Falsifier: if Stop injection proves unreliable, goal mode stays protocol-only.
- Ops (outside repo acceptance): back up then delete `~/.claude/commands/loop-start.md`, `loop-status.md`, `~/.claude/agents/loop-operator.md`, and empty skill dirs autonomous-loops/autonomous-agent-harness/verification-loop/eval-harness/gan-style-harness.

## Slice 1 scope (execute ONLY this)

1. Sprint schema `tasks/sprints/<stamp>-<slug>.sprint.md`: header quote block (Status: Draft|Approved|Executing|Done|Archived, Updated, Source Spec, Goal Mode), sections `## PRD`, `## Architecture Notes`, `## Backlog` (ordered table `| # | Status | Task | Mode | Acceptance | Plan |`), `## Execution Log`. Template at `.claude/templates/sprint.template.md`; helper script carries an inline fallback (same pattern as `plan-to-todo.sh`).
2. `scripts/sprint-backlog.sh` subcommands: `init --slug <slug> [--title <title>]`, `status`, `next` (machine-readable next pending row), `complete-task --task <n|slug> [--plan <file>]` (mark done + back-fill Plan link + Execution Log row). Active sprint marker: `.ai/harness/sprint/active-sprint`. No `start-task`, no goal state in this slice.
3. Parity copy `assets/templates/helpers/sprint-backlog.sh`.
4. `.ai/harness/policy.json`: add `sprints` node (dir, marker file, template path, statuses). Downstream policy template registration deferred to Slice 2; scripts read policy via `policy_get` with safe defaults so absent nodes degrade cleanly.
5. `scripts/check-task-workflow.sh` (+ helpers copy): validate `tasks/sprints/*.sprint.md` with Status Approved|Executing — non-empty `## PRD`, `## Backlog` table with required header, every row non-empty Acceptance, Mode in {contract, inline}; Draft sprints exempt; repos without `tasks/sprints/` skip entirely. Marker file, when present, must point at an existing sprint file.
6. Projection: `scripts/refresh-current-status.sh` adds an Active Sprint section (sprint file, status, done/total, next task) to `tasks/current.md`; `.ai/hooks/session-start-context.sh` (+ `assets/hooks/` copy) appends a one-line active sprint + next task when the marker is present, inert otherwise.
7. Terminology: `docs/reference-configs/sprint-contracts.md` (+ `assets/reference-configs/` copy) gets a two-layer glossary (Sprint = program level; Task Contract = execution slice; "Sprint Contract"/"Sprint Review" and `verify-sprint.sh` marked as legacy naming).
8. Drift sweep — rewrite stale execution-checklist semantics to deferred-ledger semantics in: `assets/partials/07-footer.partial.md:8`, `assets/partials/05-workflow.partial.md:18`, `assets/partials-agents/02-operating-mode.partial.md:13`, `assets/partials-agents/04-task-protocol.partial.md:7,31,39`, `assets/partials-agents/08-deep-docs.partial.md:5`, `assets/partials-agents/03-orchestration.partial.md:16`.
9. Tests: fixture tests for the `sprint-backlog.sh` lifecycle (init→status→next→complete-task; error paths: no active sprint, bad task ref, malformed table) and check-task-workflow sprint validation (Approved sprint with missing acceptance fails `--strict`; Draft exempt); adjust template/bootstrap assertions affected by the partials sweep deliberately, not by weakening.
10. Task sync: record Slice 2/3 as deferred goals in `tasks/todo.md` ledger; fill notes/review per workflow.

## Risks

- Partials sweep may break template assembly tests → run `bun test` early; update assertions to the new ledger wording.
- `check-task-workflow.sh` is a required gate; sprint validation must skip cleanly when `tasks/sprints/` is absent or empty.
- Dual-copy parity (scripts vs `assets/templates/helpers/`, `.ai/hooks/` vs `assets/hooks/`, docs vs `assets/reference-configs/`) — verify with migrate `--dry-run` + parity tests.
- `session-start-context.sh` is a shared high-severity surface — keep the sprint block guarded and inert without the marker.

## Evidence Contract

- **State/progress path**: this plan's Task Breakdown plus the generated contract/review/notes trio
- **Verification evidence**: `bun test`, `bash scripts/check-task-workflow.sh --strict`, `bash scripts/check-task-sync.sh`, `bun scripts/inspect-project-state.ts --repo . --format text`, `bash scripts/migrate-project-template.sh --repo . --dry-run`, recorded in `.ai/harness/checks/latest.json` and `.ai/harness/runs/`
- **Evaluator rubric**: review file records a passing /check-style recommendation plus external acceptance evidence
- **Stop condition**: Slice 1 checklist complete, all listed commands green, review recommends pass
- **Rollback surface**: revert branch `codex/sprint-program-layer-slice1`; purely additive surfaces (sprints schema, helper, policy node) can be deleted without touching execution-layer behavior

## Task Breakdown

- [x] Add sprint schema template `.claude/templates/sprint.template.md` (header + PRD/Architecture Notes/Backlog/Execution Log)
- [x] Implement `scripts/sprint-backlog.sh` (init/status/next/complete-task, policy-driven paths, inline template fallback, active-sprint marker)
- [x] Mirror helper to `assets/templates/helpers/sprint-backlog.sh`
- [x] Register sprints node in `.ai/harness/policy.json`
- [x] Extend `scripts/check-task-workflow.sh` + helpers copy with sprint validation (skip when no sprints)
- [x] Project active sprint into `tasks/current.md` via `scripts/refresh-current-status.sh` and session-start context hook (`.ai/hooks/` + `assets/hooks/`)
- [x] Add two-layer glossary + legacy-term markers to sprint-contracts.md (docs + assets copies)
- [x] Sweep 8 stale todo.md checklist references in `assets/partials*/` to deferred-ledger semantics
- [x] Add fixture tests for sprint-backlog.sh and sprint validation; keep full required checks green
- [x] Sync tasks/ (todo ledger rows for Slice 2/3, current.md, notes)

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add sprint schema template `.claude/templates/sprint.template.md` (header + PRD/Architecture Notes/Backlog/Execution Log)
- [x] Implement `scripts/sprint-backlog.sh` (init/status/next/complete-task, policy-driven paths, inline template fallback, active-sprint marker)
- [x] Mirror helper to `assets/templates/helpers/sprint-backlog.sh`
- [x] Register sprints node in `.ai/harness/policy.json`
- [x] Extend `scripts/check-task-workflow.sh` + helpers copy with sprint validation (skip when no sprints)
- [x] Project active sprint into `tasks/current.md` via `scripts/refresh-current-status.sh` and session-start context hook (`.ai/hooks/` + `assets/hooks/`)
- [x] Add two-layer glossary + legacy-term markers to sprint-contracts.md (docs + assets copies)
- [x] Sweep 8 stale todo.md checklist references in `assets/partials*/` to deferred-ledger semantics
- [x] Add fixture tests for sprint-backlog.sh and sprint validation; keep full required checks green
- [x] Sync tasks/ (todo ledger rows for Slice 2/3, current.md, notes)
