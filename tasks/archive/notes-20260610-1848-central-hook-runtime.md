> **Archived**: 2026-06-10 18:48
> **Related Plan**: plans/archive/plan-20260610-1822-central-hook-runtime.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260610-1848

# Implementation Notes: central-hook-runtime

> **Status**: Active
> **Plan**: plans/plan-20260610-1822-central-hook-runtime.md
> **Contract**: tasks/contracts/20260610-1822-central-hook-runtime.contract.md
> **Review**: tasks/reviews/20260610-1822-central-hook-runtime.review.md
> **Last Updated**: 2026-06-10 19:05
> **Lifecycle**: notes

## Design Decisions

- Flip runtime resolution to central-first instead of removing vendoring: vendored `.ai/hooks` stays as product scaffold, pinned-mode runtime, and pre-bundle fallback; runtime default moves to `~/.repo-harness/hooks` (bash chain) / packaged `assets/hooks` (CLI chain).
- Pin key is flat top-level `"hook_source": "repo"` in `.ai/harness/policy.json` so the bash shim can detect it with a plain grep (no jq dependency at hook-fire time); nested keys would collide with other `"source"`-shaped fields.
- Central `run-hook.sh` resolves hooks relative to its own directory and refuses to guess the repo root (HOOK_REPO_ROOT → git rev-parse → vendored-layout identity check → hard error), so a central copy can never fall back to `$HOME` as repo root.

## Deviations From Plan Or Spec

- None functional. Two pre-existing strict-check failures on HEAD (brain mirror drift for harness-overview/external-tooling, stale handoff resume packet) were repaired via `sync-brain-docs.sh --all` + `prepare-handoff.sh` — runtime state refresh only, no repo diff.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Central-first with repo pin | Use | One install updates the whole fleet; pin keeps self-host hook development on live code |
| Repo-local wins when present | Reject | Stale vendored copies would keep shadowing fixes — exactly the incident this task fixes |
| Stop vendoring `.ai/hooks` entirely | Defer | Bigger product/scaffold change; central-first already makes vendored copies inert |

## Open Questions

- When to stop vendoring `.ai/hooks` in `init`/`migrate` for downstream repos (deferred to `tasks/todo.md`); would also retire the hooks half of `repo-harness update --repo` hints in `managed-entries.ts`.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Test semantics: `tests/cli/hook.test.ts` temp repos and doctor drift cases now pin `hook_source: repo` because missing-script contracts only exist in repo-source mode; packaged mode covered by new resolution cases and `tests/hook-shim-resolution.test.ts`.
- Rollout caveat: the previously installed shim (Jun 4) predates the trust gate; the first reinstall activates trust enforcement, so the fleet must be trusted in the same rollout or every repo silently skips hooks.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
