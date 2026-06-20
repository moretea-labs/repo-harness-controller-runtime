# Plan: Sprint program layer Slice 2: wiring and command facade

> **Status**: Archived
> **Created**: 20260610-2053
> **Slug**: sprint-program-layer-slice2
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260610-2053-sprint-program-layer-slice2.contract.md`
> **Sprint Review**: `tasks/reviews/20260610-2053-sprint-program-layer-slice2.review.md`
> **Implementation Notes**: `tasks/notes/20260610-2053-sprint-program-layer-slice2.notes.md`

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

- Active plan: `plans/plan-20260610-2053-sprint-program-layer-slice2.md`
- Sprint contract: `tasks/contracts/20260610-2053-sprint-program-layer-slice2.contract.md`
- Sprint review: `tasks/reviews/20260610-2053-sprint-program-layer-slice2.review.md`
- Implementation notes: `tasks/notes/20260610-2053-sprint-program-layer-slice2.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260610-2053-sprint-program-layer-slice2.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260610-2053-sprint-program-layer-slice2.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260610-2053-sprint-program-layer-slice2.md`.

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
- Contract file: `tasks/contracts/20260610-2053-sprint-program-layer-slice2.contract.md`
- Review file: `tasks/reviews/20260610-2053-sprint-program-layer-slice2.review.md`
- Implementation notes file: `tasks/notes/20260610-2053-sprint-program-layer-slice2.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260610-2053-sprint-program-layer-slice2.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260610-2053-sprint-program-layer-slice2.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260610-2053-sprint-program-layer-slice2.contract.md`, `tasks/reviews/20260610-2053-sprint-program-layer-slice2.review.md`, and `tasks/notes/20260610-2053-sprint-program-layer-slice2.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260610-2053-sprint-program-layer-slice2.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260610-2053-sprint-program-layer-slice2.md`; after execution revert branch `codex/sprint-program-layer-slice2` or the generated task artifacts

## Captured Planning Output

# Sprint Program Layer — Slice 2: wiring + command facade

## Context

Slice 1 (merged: e1f6997) landed the additive schema: `tasks/sprints/` + `sprint-backlog.sh` (init/status/next/complete-task) + strict validation + projections. Central hook runtime (7035e90) landed separately, so hook logic now resolves central-first; no per-repo hook refresh concerns for this slice. This slice wires the sprint layer into plan capture, finish, the public command surface, and downstream distribution. Goal mode stays Slice 3.

## Scope

1. `scripts/sprint-backlog.sh`:
   - New `start-task [--task <ref>] [--execute] [--sprint <file>]`: resolves the next pending (or named) backlog row, generates a minimal decision-complete plan body from the sprint row (task, mode, acceptance -> Evidence Contract verification), calls `capture-plan.sh --slug <task> --source repo-harness-sprint --source-ref "sprint:<file>#<task>" --status Approved [--execute]`, and fills the row's Plan cell (status stays `[ ]`).
   - `complete-task` gains `--sprint <file>` override (containment-checked) so finish back-fill works in worktrees where the runtime marker is absent.
   - Portable mkdir-based lock around start-task/complete-task mutations (codex P2: concurrent completions lose updates); stale lock reclaim with warning.
2. `scripts/contract-worktree.sh` finish: warn-only back-fill — after archive, before commit: parse the plan's `> **Source Ref**: sprint:<path>#<task>`; if present, run `sprint-backlog.sh complete-task --sprint <path> --task <task> --plan <archived-plan-path>`; any failure prints a warning and never blocks finish.
3. Plan-capture registration: self-host `.ai/harness/policy.json` `plan_capture.sources` += `repo-harness-sprint`; same in the downstream policy heredoc in `scripts/lib/project-init-lib.sh`; capture-plan usage text mentions the source.
4. Command facade `assets/skill-commands/repo-harness-sprint/SKILL.md`: routes `plan` (PM + architect discussion -> `sprint-backlog.sh init` -> fill PRD/Architecture Notes/Backlog with concrete acceptance per row -> user approval flips Status to Approved), `run` (incremental only: `next` -> `start-task --execute` -> existing plan->contract->worktree flow; finish back-fills), `status`. Static gates: frontmatter name/description/when_to_use, `## Protocol`, `## Failure Modes`, `## Boundaries`, CHECKPOINT wording per action-command tests.
5. Registrations: `assets/skill-commands/manifest.json` entry; `tests/action-command-skills.test.ts` COMMANDS; root `SKILL.md` CLI Command Facade Surface; `README.md` command list; `docs/reference-configs/agentic-development-flow.md` command surface; `evals/evals.json` routing eval + `tests/evals-contract.test.ts` list.
6. Downstream distribution wiring:
   - `assets/workflow-contract.v1.json` + `.ai/harness/workflow-contract.json` (byte-equal): `helpers.scripts` += `sprint-backlog.sh`; `runtimeFiles` += `.ai/harness/sprint/`.
   - `scripts/lib/project-init-lib.sh`: helpers fallback list + chmod list += sprint-backlog.sh (and align the known fallback drift: new-spec.sh, new-sprint.sh, verify-sprint.sh, maintenance-triage.sh, switch-plan.sh); `pi_install_templates` sprint branch + `PI_TEMPLATE_SPRINT` fallback heredoc; `PI_DEFAULT_RUNTIME_ENTRIES` += `.ai/harness/sprint/`; downstream initial `tasks/current.md` heredoc "Derived From" += active-sprint; policy heredoc gains the `sprints` node (defaults identical to self-host).
   - `scripts/create-project-dirs.sh` consumes contract helpers list (verify it picks up the new helper; add explicit entry if it has its own list).
7. Terminology leftovers (cheap ones only): root `CLAUDE.md`/`AGENTS.md` Canonical Workflow Files line for `tasks/sprints/` + `scripts/sprint-backlog.sh`; `assets/partials-agents/02-operating-mode.partial.md` "Sprint done contract" -> task-contract wording. Contract-template wording stays (scaffold-parity snapshot churn not worth cosmetics; keep glossary as the disambiguation source).
8. Tests: extend `tests/sprint-backlog.test.ts` (start-task plan generation + Plan-cell fill, `--sprint` override, lock contention smoke, finish back-fill fixture via contract-worktree finish --no-merge path or direct complete-task --sprint); update inventory/snapshot tests (scaffold-parity, create-project-dirs.runtime, bootstrap-files, workflow-contract, action-command-skills, evals-contract) for the new files/entries.

## Out of scope

Goal mode / Stop hook (Slice 3); facade `run --goal`; renaming `verify-sprint.sh`/`new-sprint.sh`; downstream un-vendoring of `.ai/hooks` (separate ledger row); multi-sprint queueing.

## Evidence Contract

- **State/progress path**: this plan's Task Breakdown plus the generated contract/review/notes trio
- **Verification evidence**: `bun test`, `bash scripts/check-task-workflow.sh --strict`, `bash scripts/check-task-sync.sh`, `bash scripts/check-deploy-sql-order.sh`, `bun scripts/inspect-project-state.ts --repo . --format text`, `bash scripts/migrate-project-template.sh --repo . --dry-run`, recorded in `.ai/harness/checks/latest.json` and `.ai/harness/runs/`
- **Evaluator rubric**: review file records a passing /check recommendation plus Codex external acceptance
- **Stop condition**: Task Breakdown complete, all listed commands green, review recommends pass, external acceptance pass
- **Rollback surface**: revert branch `codex/sprint-program-layer-slice2`; facade/manifest/test registrations and helper additions revert with the commit

## Task Breakdown

- [x] Add `start-task` + `--sprint` override + mkdir lock to `scripts/sprint-backlog.sh`; mirror to `assets/templates/helpers/`
- [x] Add warn-only sprint back-fill to `scripts/contract-worktree.sh` finish; mirror helper copy
- [x] Register `repo-harness-sprint` as a plan-capture source (self-host policy.json + init-lib policy heredoc + capture-plan usage)
- [x] Create `assets/skill-commands/repo-harness-sprint/SKILL.md` (plan/run/status, incremental run only)
- [x] Register the command: manifest.json, action-command-skills COMMANDS, root SKILL.md, README.md, agentic-development-flow.md, evals.json + evals-contract list
- [x] Wire downstream distribution: workflow-contract v1 + installed copy (helpers.scripts, runtimeFiles), init-lib helpers fallback/chmod (+ drift alignment), template install branch + fallback heredoc, PI_DEFAULT_RUNTIME_ENTRIES, downstream current.md heredoc
- [x] Terminology: root CLAUDE.md/AGENTS.md canonical-files lines; 02-operating-mode task-contract wording
- [x] Extend sprint-backlog tests (start-task, --sprint override, lock, back-fill) and update inventory/snapshot tests; full required checks green
- [x] Sync tasks/ (ledger row, notes, current.md)

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Add `start-task` + `--sprint` override + mkdir lock to `scripts/sprint-backlog.sh`; mirror to `assets/templates/helpers/`
- [x] Add warn-only sprint back-fill to `scripts/contract-worktree.sh` finish; mirror helper copy
- [x] Register `repo-harness-sprint` as a plan-capture source (self-host policy.json + init-lib policy heredoc + capture-plan usage)
- [x] Create `assets/skill-commands/repo-harness-sprint/SKILL.md` (plan/run/status, incremental run only)
- [x] Register the command: manifest.json, action-command-skills COMMANDS, root SKILL.md, README.md, agentic-development-flow.md, evals.json + evals-contract list
- [x] Wire downstream distribution: workflow-contract v1 + installed copy (helpers.scripts, runtimeFiles), init-lib helpers fallback/chmod (+ drift alignment), template install branch + fallback heredoc, PI_DEFAULT_RUNTIME_ENTRIES, downstream current.md heredoc
- [x] Terminology: root CLAUDE.md/AGENTS.md canonical-files lines; 02-operating-mode task-contract wording
- [x] Extend sprint-backlog tests (start-task, --sprint override, lock, back-fill) and update inventory/snapshot tests; full required checks green
- [x] Sync tasks/ (ledger row, notes, current.md)
