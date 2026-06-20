# Release Filing: repo-harness 0.2.3

Date: 2026-06-05
Filing ID: 260605-repo-harness-0.2.3
Status: Published

## Naming

Release filing documents use a `YYMMDD-<package>-<version>.md` filename. This
file uses `260605` so the release artifact sorts by filing date without relying
only on GitHub or npm metadata.

## Scope

- Package: `repo-harness@0.2.3`
- Generated workflow compatibility: `5.2.3` (unchanged)
- Public CLI commands: `repo-harness init` owns first-run global CLI, hook,
  Waza, Mermaid, brain-root, and CodeGraph dependency setup; `repo-harness
  update` owns existing repo-local harness refresh; `repo-harness scaffold` is a
  side command for new project branch scaffolding.
- Main change: retire the legacy Claude plugin/Superpowers bootstrap path and
  replace it with the current CLI plus hooks automation surface.

## Included Changes

- Replaced the old shell-managed `repo-harness init` implementation with typed
  global runtime setup in `src/cli/commands/global-runtime.ts`.
- Removed the active Superpowers Claude marketplace installer path from
  `repo-harness init` and from `scripts/setup-plugins.sh`.
- Converted `scripts/setup-plugins.sh` into a compatibility shim that delegates
  to `repo-harness init`.
- Kept Mermaid in the active tool surface while retiring the old
  `diagram-design` active references.
- Kept Waza `think`/`hunt`/`check`/`health`, brain-root configuration, CodeGraph
  CLI/MCP setup, and user-level hook adapters in the global init contract.
- Moved scaffold wording to the branch-command path instead of presenting it as
  the main existing-repo adoption path.
- Collapsed `references/plugins-core.md` into a retired historical reference so
  stale plugin-bundle instructions are not treated as active installation
  guidance.

## Verification

- `bun test tests/cli/global-runtime-init.test.ts tests/cli/init.test.ts
  tests/setup-plugins-structure.test.ts tests/bootstrap-files.test.ts
  tests/action-command-skills.test.ts tests/check-agent-tooling.test.ts
  tests/workflow-contract.test.ts tests/create-project-dirs.runtime.test.ts
  tests/migration-script.test.ts` passed: 85 pass, 0 fail.
- `bun test` passed: 562 pass, 6 skip, 0 fail.
- `bash scripts/check-deploy-sql-order.sh` passed.
- `bash scripts/check-task-sync.sh` passed.
- `bash scripts/check-task-workflow.sh --strict` passed after
  `bash scripts/sync-brain-docs.sh --all` refreshed the explicit brain manifest
  entries.
- `bun scripts/inspect-project-state.ts --repo . --format text` passed.
- `bash scripts/migrate-project-template.sh --repo . --dry-run` passed.
- `git diff --check` passed.
- `bash -n scripts/setup-plugins.sh` passed.
- `npm run check:release` passed before publish: 562 pass, 6 skip, 0 fail; it
  also ran `bun install --frozen-lockfile`, the release-budgeted full `bun
  test`, `bash scripts/check-deploy-sql-order.sh`, `bash
  scripts/check-task-sync.sh`, `bash scripts/check-task-workflow.sh --strict`,
  `bun scripts/inspect-project-state.ts --repo . --format text`, `bash
  scripts/migrate-project-template.sh --repo . --dry-run`, and `npm pack
  --dry-run --json`.
- `npm publish --registry https://registry.npmjs.org/ --access public` used a
  temporary npmrc backed by the local `_ops/env/npm.md` token, verified the
  publish identity as `ancienttwo`, reran the full `prepublishOnly` gate
  successfully, and published `repo-harness@0.2.3`.
- `npm view repo-harness@0.2.3 version dist.tarball gitHead dist.shasum
  dist.integrity --registry https://registry.npmjs.org/` returned:
  - `version = '0.2.3'`
  - `dist.tarball = 'https://registry.npmjs.org/repo-harness/-/repo-harness-0.2.3.tgz'`
  - `gitHead = '3e87b0295c88464cd9b9d2557e63d101c4bdce59'`
  - `dist.shasum = 'c162d2c8ca5a491034aea6b404f3724dc89b20ba'`
  - `dist.integrity = 'sha512-M/HrJSSIHSV1h7S3sPzOOz3JFmy/fL3Y8iGmAN65Qfy6kJd4M2n4hIAqp53+FOKDJWw8NXdk0Kiyxms3nBiM3g=='`
- `npm view repo-harness dist-tags --registry https://registry.npmjs.org/`
  reported `latest = '0.2.3'`.
- Clean-temp npm CLI smoke passed:
  `npx -y --registry https://registry.npmjs.org/ repo-harness@0.2.3 --version`
  printed `0.2.3`; `repo-harness@0.2.3 init --help` exposed the current CLI,
  hook, Waza, Mermaid, brain-root, and CodeGraph flags with no Superpowers
  option; and a minimal clean-temp `repo-harness@0.2.3 init --target codex
  --no-cli --no-sync-skill --no-hooks --no-external-skills --no-codegraph
  --brain-root <tmp>/brain` exited 0 and wrote only the temporary
  `.repo-harness/config.json`.

## Published Artifacts

- npm: https://www.npmjs.com/package/repo-harness/v/0.2.3
- npm tarball: https://registry.npmjs.org/repo-harness/-/repo-harness-0.2.3.tgz
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.2.3
