# Release Filing: repo-harness 0.1.5

Date: 2026-06-01
Filing ID: 260601-repo-harness-0.1.5
Status: Published

## Naming

Release filing documents use a `YYMMDD-<package>-<version>.md` filename. This
file intentionally uses `260601` so the release artifact sorts by filing date
without relying only on GitHub or npm metadata.

## Scope

- Package: `repo-harness@0.1.5`
- Generated workflow compatibility: `5.2.3`
- Public CLI commands: unchanged
- Host adapter contract: unchanged, still `repo-harness-hook <event> --route <route>`
- Main change: runtime-facing generated markers and environment variable aliases
  now prefer `repo-harness` naming while preserving legacy compatibility.
- Closeout safety: merged linked worktrees with dirty deltas now fail cleanup
  unless useful changes are committed/picked/applied or the operator explicitly
  discards generated scaffold-only files.

## Included Changes

- Added `REPO_HARNESS_*` aliases for scaffold, migration, context-block
  selection, external-tooling checks, and contract-worktree controls.
- Kept `PROJECT_INITIALIZER_*` as legacy fallbacks.
- Switched new runtime `.gitignore` and Codex resume generated markers to
  `repo-harness` naming.
- Preserved dual-read compatibility for existing `project-initializer` markers.
- Added `ship-worktrees.sh --cleanup-merged` dirty worktree classification with
  path reporting, pick/apply/commit guidance, and `--discard-scaffold-only`.
- Kept `contract-worktree.sh cleanup` conservative while pointing generated
  scaffold discard back to the ship closeout path.
- Switched the Codex global handoff writer to prefer Node and keep Python as
  fallback for environments where `python3 -` is unavailable or killed.

## Verification

- `repo-harness --version` returned `0.1.5` from the local linked CLI.
- `bun src/cli/index.ts --version` returned `0.1.5`.
- `bun test tests/bootstrap-files.test.ts tests/cli/status.test.ts tests/cli/doctor.test.ts tests/skill-version.test.ts` passed.
- `bash scripts/check-npm-release.sh` passed before publish: 538 pass, 6 skip, 0 fail.
- Dirty merged WT sprint verification passed in
  `.ai/harness/runs/run-20260601T030846-77621-20260601-0139-tgz-pick-wt.json`.
- Full local suite after dirty WT guard passed: 544 pass, 6 skip, 0 fail.
- `bash scripts/ensure-codegraph.sh --check --json` reported the project index up-to-date.
- `bun src/cli/index.ts doctor --json` reported `9 ok / 0 warn / 0 fail`.
- `npm view repo-harness@0.1.5 version --registry https://registry.npmjs.org/` returned `0.1.5` after publish.

## Published Artifacts

- npm: https://www.npmjs.com/package/repo-harness/v/0.1.5
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.1.5
