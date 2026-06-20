# Release Filing: repo-harness 0.1.3

Date: 2026-05-31
Filing ID: 260531-repo-harness-0.1.3
Published source commit: a06331f
Status: Published

## Naming

Release filing documents use a `YYMMDD-<package>-<version>.md` filename. This
file intentionally uses `260531` so the release artifact sorts by filing date
without relying only on GitHub or npm metadata.

## Scope

- Package: `repo-harness@0.1.3`
- Generated workflow compatibility: `5.2.3`
- Public CLI commands: unchanged
- Host adapter contract: unchanged, still `repo-harness-hook <event> --route <route>`
- Prompt guard architecture: host adapter -> CLI route registry -> `.ai/hooks/prompt-guard.sh` -> TypeScript decision table -> shell-rendered host output

## Included Changes

- AI-native scaffold profile overlays.
- Typed prompt-guard decision table for intent plus workflow-state routing.
- Draft plan plus `implement this plan` regression fix.
- No-active-plan and Approved-plan projection routing fixes.
- Passive copied worktree, completion report, and next-slice prompt handling.
- Deploy SQL invariant reference check.
- `tasks/current.md` scratch-file filtering parity for generated helpers.
- CLI version alignment for `repo-harness --version` and `repo-harness status`.
- English and Chinese README architecture clarification.

## Verification

- `bash scripts/check-npm-release.sh` passed before publish.
- `npm publish --access public --registry https://registry.npmjs.org/` completed successfully.
- `npm view repo-harness@0.1.3 version --json --registry https://registry.npmjs.org/` returned `0.1.3`.
- `npm view repo-harness version --json --registry https://registry.npmjs.org/` returned `0.1.3`.

## Published Artifacts

- NPM: https://www.npmjs.com/package/repo-harness/v/0.1.3
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.1.3
