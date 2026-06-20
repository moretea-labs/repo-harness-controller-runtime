# Release Filing: repo-harness 0.3.0

Date: 2026-06-11
Status: Published

## Scope

- Package: `repo-harness@0.3.0`
- GitHub tag: `v0.3.0`
- Base tag: `v0.2.4`
- Target branch: `main`
- Generated workflow compatibility: `5.2.3`

## Release Notes

- Adds the sprint program layer: `repo-harness-sprint`, `tasks/sprints/`,
  sprint templates, active sprint markers, `scripts/sprint-backlog.sh`,
  current-status projection, session-start projection, workflow validation, and
  generated-repo parity copies.
- Moves hook runtime resolution central-first: user-level adapters dispatch into
  `repo-harness-hook`, central packaged hooks are the default runtime, and this
  self-host repo can still pin live hook development to `.ai/hooks`.
- Moves prompt-text intent classification into TypeScript with Unicode-aware
  semantics and a one-line verdict JSON protocol for the shell prompt hook.
- Moves hard plan/spec/contract enforcement for implementation writes to the
  PreToolUse edit layer, where guards can key off path and plan state.
- Merges the always-route PostToolUse observers into `post-tool-observer.sh` to
  reduce hook hot-path dispatches and stdin parsing.
- Retires the duplicated shell fallback decision table, `PROJECT_INITIALIZER_*`
  environment fallbacks, `repo-harness-skill` and `project-initializer`
  compatibility aliases, the hidden `prompt-guard-decision` alias, and the
  orphan version checker.

## Verification

- Focused preflight passed:
  - `bun test tests/bootstrap-files.test.ts tests/readme-dx.test.ts`
- Full release gate passed before npm publish:
  - `bash scripts/check-npm-release.sh`
  - `bun test`: 632 pass, 0 fail
  - `bash scripts/check-deploy-sql-order.sh`: pass
  - `bash scripts/check-task-sync.sh`: pass
  - `bash scripts/check-task-workflow.sh --strict`: pass
  - `bun scripts/inspect-project-state.ts --repo . --format text`: pass
  - `bash scripts/migrate-project-template.sh --repo . --dry-run`: pass
  - `npm pack --dry-run --json`: pass
- `npm publish --registry https://registry.npmjs.org/ --access public` used a
  temporary npmrc verified as `ancienttwo`, a temporary `NPM_CONFIG_CACHE`, reran
  the full `prepublishOnly` gate successfully, and published
  `repo-harness@0.3.0`.
- The publish notice reported `repo-harness-0.3.0.tgz`, 276 files, package size
  1.9 MB, unpacked size 3.5 MB, and shasum
  `b9ff765efa7063652a717a610ccb3afcd0a8811b`.

## Publish Status

- npm: published to the official registry.
- Registry readback:
  - `npm view repo-harness@0.3.0 version --registry https://registry.npmjs.org/`
    returned `0.3.0`.
  - `dist.tarball` is
    `https://registry.npmjs.org/repo-harness/-/repo-harness-0.3.0.tgz`.
  - `dist.shasum` is `b9ff765efa7063652a717a610ccb3afcd0a8811b`.
  - `gitHead` is `13e2ded87d168f53904bbe47ea2ce51b2cb33727`.
  - `latest` is `0.3.0`.
- Clean-room npx smoke passed from an empty temp directory with a temporary npm
  cache:
  - `npx -y --registry https://registry.npmjs.org/ repo-harness@0.3.0 --version`
    returned `0.3.0`.
  - `npx -y --registry https://registry.npmjs.org/ repo-harness@0.3.0 init --help`
    displayed the expected `repo-harness init` command help.
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.3.0
