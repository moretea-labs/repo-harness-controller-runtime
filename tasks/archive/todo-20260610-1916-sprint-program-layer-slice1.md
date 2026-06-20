> **Archived**: 2026-06-10 19:16
> **Related Plan**: plans/archive/plan-20260610-1746-sprint-program-layer-slice1.md
> **Outcome**: Completed
> **Source Plan**: (none)
> **Parent Run ID**: run-20260610-1916

# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-06-10 18:20
> **Scope**: Medium/long-term goals deferred from active plan execution

Current plan tasks live in the active plan's `## Task Breakdown`.
Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Sprint Slice 2: wiring + facade — `sprint-backlog.sh start-task` (capture-plan `--source repo-harness-sprint` + downstream policy template), warn-only finish back-fill in `contract-worktree.sh`, `assets/skill-commands/repo-harness-sprint` SKILL (plan/run/status) + manifest/docs/evals/tests registration | Slice 1 is intentionally additive-only per cross-model review; wiring lands after schema is proven | Sprint backlog cannot drive plan capture until this lands | Slice 1 merged to main |
| Sprint Slice 3: goal continuation — `run --goal` protocol (CHECKPOINT rules) + `stop-orchestrator.sh` goal-state branch (max-iterations 25, cancel, corrupt self-clear) + hook-runtime tests; falsifier: unreliable Stop injection downgrades goal to protocol-only | Stop route touches every session exit path; ships only after Slice 2 wiring exists | One-shot sprint runs stay manual until then | Slice 2 merged; decide ordering vs hook-resolution refactor first |
| Hook resolution user-level-first: `repo-harness-hook` resolves script bodies from the installed package (`assets/hooks`) by default, repo-local `.ai/hooks/` becomes explicit override/shim only; migration stops copying hook bodies per repo | User directive 2026-06-10: hooks are user-level, project-local only shim-links, artifacts stay project-level; no per-repo refresh on upgrades. Needs its own contract: helper scripts source `.ai/hooks/lib/workflow-state.sh`, so lib resolution and custom-hook override paths must be designed | Until then every hook change still needs `repo-harness update --repo <r>` per repo | Before Sprint Slice 3 (goal Stop-hook logic should ship through the user-level path, not per-repo copies) |
