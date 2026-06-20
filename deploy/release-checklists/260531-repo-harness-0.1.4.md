# Release Filing: repo-harness 0.1.4

Date: 2026-05-31
Filing ID: 260531-repo-harness-0.1.4
Published source commit: 388bf25
Status: Published

## Naming

Release filing documents use a `YYMMDD-<package>-<version>.md` filename. This
file intentionally uses `260531` so the release artifact sorts by filing date
without relying only on GitHub or npm metadata.

## Scope

- Package: `repo-harness@0.1.4`
- Generated workflow compatibility: `5.2.3`
- Public CLI commands: unchanged
- Host adapter contract: unchanged, still `repo-harness-hook <event> --route <route>`
- Main fix: generated plan task artifacts now keep the active plan stem
  (`YYYYMMDD-HHMM-<slug>`) for `tasks/contracts/`, `tasks/reviews/`, and
  `tasks/notes/`.

## Included Changes

- `capture-plan.sh`, `new-plan.sh`, and `plan-to-todo.sh` now project task
  artifacts from the active plan stem instead of the slug alone.
- `workflow-state.sh`, `codex-handoff-resume.sh`, `archive-workflow.sh`, and
  `contract-worktree.sh` prefer plan-stem artifacts while retaining legacy
  slug-only fallback for existing projects.
- Generated templates and reference docs now describe
  `YYYYMMDD-HHMM-<slug>` task artifact names.
- Helper tests cover the new date-prefixed artifact paths and the existing
  contract worktree closeout path.

## Verification

- `bash scripts/check-npm-release.sh` passed from the final release commit.
- `npm publish --access public --registry https://registry.npmjs.org/` completed successfully.
- `npm view repo-harness@0.1.4 version --json --registry https://registry.npmjs.org/` returned `0.1.4`.
- `npm view repo-harness version --json --registry https://registry.npmjs.org/` returned `0.1.4`.

## Published Artifacts

- NPM: https://www.npmjs.com/package/repo-harness/v/0.1.4
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.1.4
