> **Archived**: 2026-06-11 00:57
> **Related Plan**: plans/archive/plan-20260610-2053-sprint-program-layer-slice2.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260611-0057

# Implementation Notes: sprint-program-layer-slice2

> **Status**: Active
> **Plan**: plans/plan-20260610-2053-sprint-program-layer-slice2.md
> **Contract**: tasks/contracts/20260610-2053-sprint-program-layer-slice2.contract.md
> **Review**: tasks/reviews/20260610-2053-sprint-program-layer-slice2.review.md
> **Last Updated**: 2026-06-11 00:41
> **Lifecycle**: notes

## Design Decisions

- `start-task` captures plans as `--status Approved` directly: the sprint approval (Approved status + per-row acceptance, gated by check-task-workflow) is the approval; no second human gate per task. Inline-mode rows set `REPO_HARNESS_DISABLE_CONTRACT_WORKTREE=1` so they execute in the primary tree.
- The plan->task linkage is `> **Source Ref**: sprint:<file>#<task>`; finish back-fill parses it from the archived plan and calls `complete-task --sprint <file>` because the runtime marker (`.ai/harness/sprint/`, gitignored) does not exist inside contract worktrees.
- Back-fill runs after archive and before the finish commit so the backlog row flip merges atomically with the slice; every failure path is warn-only (`|| true` at the call site plus internal guards).
- Mutation lock is mkdir-based (portable; macOS has no flock) with a 1-minute stale-reclaim and 10s timeout; lock scope covers resolve+rewrite in both start-task and complete-task.
- Fallback helper list in `pi_install_helpers` was realigned with the contract list (it had drifted: new-spec/new-sprint/verify-sprint/maintenance-triage/switch-plan missing) while adding sprint-backlog.sh.
- `pi_install_templates` copies sprint.template.md only when present (no PI_TEMPLATE_SPRINT heredoc): sprint-backlog.sh already self-heals with an inline template, so a second fallback copy would just drift.
- In-flight markers live under gitignored `.ai/harness/sprint/in-flight/`: named duplicate `start-task` calls fail, auto-selection skips active rows, and `--force` is the explicit restart path. This keeps contract-mode primary-tree files merge-pure while still preventing accidental duplicate plan capture.

## Deviations From Plan Or Spec

- Plan named a `PI_TEMPLATE_SPRINT` fallback heredoc; dropped in favor of copy-when-present + the helper's existing inline fallback (one fallback source instead of two).
- External acceptance added the in-flight marker guard after the first review pass identified duplicate `start-task` as a remaining edge. The marker is runtime state only, not a tracked backlog mutation.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Back-fill in target worktree after merge | Back-fill in slice worktree before commit | Row flip merges atomically; no uncommitted residue on main |
| flock for serialization | mkdir lock | flock is not available on stock macOS bash environments |
| Second template fallback heredoc in init-lib | Copy-when-present only | Helper already self-heals; two fallbacks drift |

## Open Questions

- Whether `start-task` should refuse auto-selecting a row whose Plan cell is already set (in-flight task) without explicit `--task`; revisit when goal mode (Slice 3) automates the loop.

## Review-Driven Fixes (post-implementation)

- /check specialist (e2e-verified findings): D1 HIGH — contract-mode start-task wrote the Plan cell into the primary tree after the worktree branched, guaranteeing a dirty-target or non-ff merge failure at finish; fixed by skipping the primary-tree cell write for contract rows (finish back-fill writes status+plan atomically with the merge; inline rows still fill immediately). B1 MEDIUM — non-empty stale lock hot-looped past the timeout; reclaim now only short-circuits when rmdir succeeds. B2 MEDIUM — the lock was held across capture-plan --execute (can exceed the 1-minute stale threshold); the lock now covers row resolution and the cell write separately. C1 — Source Ref now splits on the first '#' (sprint paths are slug-generated; task names are free text). C2 — archive -vN renames resolved by stem glob, with a warning instead of silent skip. A4 — both row-rewrite awks exit non-zero when no row was rewritten (malformed cells fail loudly instead of reporting success). Lock trap extended to INT/TERM. Facade Boundaries now states the one-task-at-a-time queue rule.
- Codex acceptance rerun: added runtime-only in-flight markers for duplicate `start-task` protection and hardened `--sprint` containment against symlink escapes under `tasks/sprints/`; both are covered by `tests/sprint-backlog.test.ts`.
- Specialist clean areas (verified): heredoc variable expansion is single-pass (no command-substitution injection from cell text), parity copies and both workflow-contract JSONs byte-identical, helpers/contract/init-lib set-diff empty, no interactive-hang path in start-task.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
