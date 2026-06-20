> **Archived**: 2026-06-10 19:16
> **Related Plan**: plans/archive/plan-20260610-1746-sprint-program-layer-slice1.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260610-1916

# Implementation Notes: sprint-program-layer-slice1

> **Status**: Active
> **Plan**: plans/plan-20260610-1746-sprint-program-layer-slice1.md
> **Contract**: tasks/contracts/20260610-1746-sprint-program-layer-slice1.contract.md
> **Review**: tasks/reviews/20260610-1746-sprint-program-layer-slice1.review.md
> **Last Updated**: 2026-06-10 18:25
> **Lifecycle**: notes

## Design Decisions

- Single-active-sprint invariant: `.ai/harness/sprint/active-sprint` marker mirrors the active-plan marker pattern; `init` refuses a second sprint unless the current one is Done/Archived.
- Backlog schema is a 6-column table (`# | Status | Task | Mode | Acceptance | Plan`) with `[ ]`/`[x]` status cells; `complete-task` rewrites the row via awk (normalizing cell spacing) and appends an Execution Log row.
- `next` uses exit code 3 for "no pending task" so future loop callers can distinguish exhaustion (3) from errors (1) and usage (2).
- Sprint validation only gates Approved/Executing sprints; Draft skeletons and repos without `tasks/sprints/` skip entirely, keeping `check-task-workflow.sh` safe for every existing repo.
- PRD readiness check ignores headings and treats only `...` bullets as placeholders, so the template skeleton fails closed until real PRD content is written.
- Sprint status transitions stay manual in Slice 1 (`complete-task` prints a hint instead of auto-setting Done); auto-transition belongs with the Slice 2 wiring decision.
- Session-start sprint block is inert without the marker file and reads the marker path from policy when jq is available.

## Deviations From Plan Or Spec

- The partials sweep fixed 6 lines, not 8: `04-task-protocol.partial.md:7` (todo as a task *source*) and `:39` (distill-to-lessons rule) already carried correct deferred-ledger semantics, so only line 31 was drift. The plan's count came from the raw grep hit list.
- `05-workflow.partial.md` renamed the PLAN_LOOP key `PRIMARY_FILE` to `DEFERRED_LEDGER` instead of keeping a misleading key name; no test asserted the old key.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Promote backlog-parsing awk into `.ai/hooks/lib/workflow-state.sh` | Deferred; duplicated in sprint-backlog.sh / refresh-current-status.sh / session-start-context.sh | Lib has dual copies + heavy hook tests; promotion only after the parsing proves stable across Slice 2 (promotion rule) |
| Register `tasks/sprints/` in workflow-contract requiredDirectories | Not registered | Sprint dir is on-demand (`init` creates it); requiredDirectories would fail every existing repo |
| Auto-set sprint Status to Done when backlog empties | Hint only | Done should follow review, mirroring the contract completion gate |

## Open Questions

- Hook distribution (user directive 2026-06-10): hook bodies should resolve user-level from the installed package, repo-local `.ai/hooks/` as shim/override only. Recorded in `tasks/todo.md`; ordering question is whether it lands before Sprint Slice 3 (goal Stop-hook). Note `scripts/*.sh` helpers source `.ai/hooks/lib/workflow-state.sh`, so lib resolution needs its own design.

## Review-Driven Fixes (post-implementation)

- /check specialists: C1 sed-metachar title injection -> awk index/substr render via ENVIRON + temp-file write; C2 awk -v escape corruption -> ENVIRON for plan cell; H1 `| xargs` quote-crash of the whole required gate -> sed trim in extract_status (also hardens plan-status parsing); M1 marker containment gate (helper + checker); M2 render-to-temp prevents 0-byte sprint poison; L1 first-match rewrite guard.
- Codex external acceptance: placeholder-acceptance rejection + duplicate index/task rejection in the validator; ambiguous `--task` refs exit 1; rewrite matches index AND task. Deferred (recorded): no file lock on complete-task (Slice 2, with finish back-fill serialization); downstream install wiring (Slice 2 ledger entry).
- Remaining `| xargs` trims on marker/plan paths elsewhere in check-task-workflow.sh predate this slice and are guarded by `|| true` at call sites; promote the sed-trim pattern when those files are next touched.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
