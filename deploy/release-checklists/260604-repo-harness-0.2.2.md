# Release Filing: repo-harness 0.2.2

Date: 2026-06-04
Filing ID: 260604-repo-harness-0.2.2
Status: Published

## Naming

Release filing documents use a `YYMMDD-<package>-<version>.md` filename. This
file uses `260604` so the release artifact sorts by filing date without relying
only on GitHub or npm metadata.

## Scope

- Package: `repo-harness@0.2.2`
- Generated workflow compatibility: `5.2.3` (unchanged)
- Public CLI commands: `repo-harness init` remains the first-run global runtime
  bootstrap; `repo-harness update` owns existing repo-local harness refresh.
- Main change: a safety patch release that makes first-run global init visible
  while removing the Superpowers Claude marketplace plugin from default setup.

## Included Changes

- Updated `src/cli/index.ts` so `repo-harness init` streams
  `scripts/setup-plugins.sh` output directly to the terminal.
- Updated `src/cli/commands/global-runtime.ts` to support inherited stdio for
  user-facing init while keeping captured stdio available for tests.
- Updated `scripts/setup-plugins.sh` so the Superpowers marketplace plugin is
  installed only with explicit `--with-superpowers`.
- Added `repo-harness init --with-superpowers` CLI plumbing and regression
  coverage.
- Updated README and changelog release metadata for the `0.2.2` npm line.

## Verification

- `bun src/cli/index.ts --version` returned `0.2.2`.
- `bun src/cli/index.ts status` reported `repo-harness 0.2.2`.
- Focused regression coverage passed:
  `bun test tests/cli/global-runtime-init.test.ts
  tests/setup-plugins-structure.test.ts tests/bootstrap-files.test.ts`, and
  the hook-runtime slow-regression subset for copied worktree status and terse
  approval capture.
- `bash scripts/check-npm-release.sh` passed before publish: 565 pass, 6 skip,
  0 fail; it also ran `bun install --frozen-lockfile`, `bun test`,
  `bash scripts/check-deploy-sql-order.sh`, `bash scripts/check-task-sync.sh`,
  `bash scripts/check-task-workflow.sh --strict`,
  `bun scripts/inspect-project-state.ts --repo . --format text`,
  `bash scripts/migrate-project-template.sh --repo . --dry-run`, and
  `npm pack --dry-run --json`.
- `npm publish --registry https://registry.npmjs.org/ --access public` used a
  temporary npmrc backed by the local `_ops/env/npm.md` token, verified the
  publish identity as `ancienttwo`, reran the full `prepublishOnly` gate
  successfully, and published `repo-harness@0.2.2`.
- `npm view repo-harness@0.2.2 version dist.tarball gitHead dist.shasum
  dist.integrity --registry https://registry.npmjs.org/` returned:
  - `version = '0.2.2'`
  - `dist.tarball = 'https://registry.npmjs.org/repo-harness/-/repo-harness-0.2.2.tgz'`
  - `gitHead = 'aa9d5a327715ba38d452d185ff437563ac3d6cf2'`
  - `dist.shasum = 'c1e39feedb0478ed767ffaaaa51cbb2b8dae7bef'`
  - `dist.integrity = 'sha512-5C6t2nptCQZ4qo/k2Yl4SmrwpkyGBnxlENLoOrkYD55lXw1FPa20z8LE/acU+cUIAHCTU8/j62WMGSb1KL9cfA=='`
- `npm view repo-harness dist-tags --registry https://registry.npmjs.org/`
  reported `latest = '0.2.2'`.
- Clean-temp npm CLI smoke passed:
  `npx -y --registry https://registry.npmjs.org/ repo-harness@0.2.2 --version`
  printed `0.2.2`; `repo-harness@0.2.2 init --help` exposed
  `--with-superpowers`; and clean-temp `repo-harness@0.2.2 init` exited 0 with
  no Superpowers output or Superpowers files under the temporary Claude home.

## Published Artifacts

- npm: https://www.npmjs.com/package/repo-harness/v/0.2.2
- npm tarball: https://registry.npmjs.org/repo-harness/-/repo-harness-0.2.2.tgz
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.2.2
