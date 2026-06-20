# Release Filing: repo-harness 0.5.0

Date: 2026-06-14
Status: Published to npm and GitHub; local runtime refreshed

## Scope

- Package target: `repo-harness@0.5.0`
- Base release: `v0.4.3`
- Release branch: `main`
- Registry: `https://registry.npmjs.org/`

## Version Decision

Use `0.5.0` as a minor release because the public command lifecycle boundary
changes: `repo-harness update` is now user-level CLI/runtime refresh only, while
`repo-harness adopt` owns repo-local workflow install, refresh, and migration.
The release also exposes package-dispatched helper execution through
`repo-harness run <helper>` and documents the eight managed hook routes installed
by Claude/Codex adapters.

## Required Alignment

- `package.json`
- `.claude/.skill-version`
- `assets/skill-version.json`
- `src/cli/commands/status.ts`
- README current release/stamp references
- `docs/CHANGELOG.md`
- version expectation tests

## Preflight Evidence

- `npm view repo-harness version versions --json --registry https://registry.npmjs.org/`
  returned current latest `0.4.3`, and the published version list did not
  include `0.5.0`.
- `npm view repo-harness@0.5.0 version --json --registry https://registry.npmjs.org/`
  returned `E404`, proving the target package is unpublished before publish.
- `gh release view v0.4.3 --repo Ancienttwo/repo-harness --json tagName,name,publishedAt,url,targetCommitish,isDraft,isPrerelease,assets`
  returned the public `v0.4.3` release, non-draft, non-prerelease, with no
  assets.

## Verification

- `bun src/cli/index.ts --version` returned `0.5.0`.
- `bun src/cli/index.ts status --json` returned CLI version `0.5.0` and `8`
  managed routes with event breakdown `SessionStart=1`, `PreToolUse=2`,
  `PostToolUse=3`, `UserPromptSubmit=1`, and `Stop=1`.
- Focused affected suite passed:
  - `bun test tests/bootstrap-files.test.ts tests/skill-version.test.ts tests/cli/status.test.ts tests/cli/global-runtime-init.test.ts tests/cli/run.test.ts tests/reclaim-runtime.test.ts`
  - Result: `51 pass`, `0 fail`, `561` expectations.
- First `bash scripts/check-npm-release.sh` run reached full `bun test`
  successfully (`727 pass`, `0 fail`, `7099` expectations across `70` files),
  then stopped at `check-task-sync` because the release prep notes file had not
  been added yet.
- First `npm publish --access public --registry https://registry.npmjs.org/`
  attempt authenticated as `ancienttwo` and reran the full prepublish gate. It
  reached `bun test` successfully (`727 pass`, `0 fail`, `7099` expectations
  across `70` files), then stopped at `check-task-sync` because
  `.claude/.skill-version` was still tracked at `0.4.3` and the gate updated it
  to the `0.5.0` stamp.
- Final `bash scripts/check-npm-release.sh` run passed:
  - npm registry uniqueness for `repo-harness@0.5.0`
  - `bun install --frozen-lockfile`
  - `bun test` (`727 pass`, `0 fail`, `7099` expectations across `70` files)
  - `bash scripts/check-deploy-sql-order.sh`
  - `bash scripts/check-architecture-sync.sh`
  - `bash scripts/check-task-sync.sh`
  - `REPO_HARNESS_SKIP_RESUME_REFRESH=1 bash scripts/prepare-handoff.sh "release gate"`
  - `bash scripts/codex-handoff-resume.sh --cwd . --reason "release gate"`
  - `bash scripts/check-task-workflow.sh --strict`
  - `bun scripts/inspect-project-state.ts --repo . --format text`
  - `bash scripts/migrate-project-template.sh --repo . --dry-run`
  - `npm pack --dry-run --json`
  - Result: `[release] OK: npm package gate passed.`
- A publish-time retry used `BUN_TEST_TIMEOUT_MS=180000` and
  `BUN_TEST_MAX_CONCURRENCY=1` after one earlier publish attempt timed out in
  `Hook runtime behavior > run-hook preserves Codex failure status without
  surfacing telemetry JSON`. The focused test passed four direct reproductions,
  and the final publish gate passed the full suite with `727 pass`, `0 fail`,
  and `7099` expectations.
- Visible `npm pack --dry-run --json` inspection reported
  `repo-harness-0.5.0.tgz`, `276` files, package size `4670437`, unpacked size
  `6469936`, shasum `61f9ca3c64a9fa1ebeaf10e941e087b91df7ba00`, and included
  `README.md`, `docs/images/image.png`, `src/cli/commands/run.ts`,
  `src/cli/runtime/helper-runner.ts`,
  `src/cli/repo-adoption/reclaim-runtime.ts`,
  `assets/hooks/post-tool-observer.sh`,
  `assets/hooks/subagent-return-channel-guard.sh`, and
  `assets/workflow-contract.v1.json`.
- `git diff --check` passed.

## Publish Follow-through

- npm: `npm publish --access public --registry https://registry.npmjs.org/`
  completed and returned `+ repo-harness@0.5.0`.
- Registry readback:
  `npm view repo-harness@0.5.0 version dist-tags dist.tarball gitHead dist.shasum --json --registry https://registry.npmjs.org/`
  returned version `0.5.0`, `latest=0.5.0`, tarball
  `https://registry.npmjs.org/repo-harness/-/repo-harness-0.5.0.tgz`,
  gitHead `79746b3254bc151e66d5154d0579c886f8156f68`, and shasum
  `61f9ca3c64a9fa1ebeaf10e941e087b91df7ba00`.
- Clean-room npm execution:
  `npx --yes --package repo-harness@0.5.0 repo-harness --version` returned
  `0.5.0`.
- Git tag: annotated `v0.5.0` pushed to `origin`; peeled tag target is
  `79746b3254bc151e66d5154d0579c886f8156f68`.
- GitHub release: `repo-harness 0.5.0`, non-draft, non-prerelease, latest:
  `https://github.com/Ancienttwo/repo-harness/releases/tag/v0.5.0`.
- Local runtime refresh:
  - `bun install -g repo-harness@0.5.0 --registry https://registry.npmjs.org/`
    installed `repo-harness` and `repo-harness-hook`.
  - `npm install -g --prefix /Users/ancienttwo/.nvm/versions/node/v22.22.0 repo-harness@0.5.0 --registry https://registry.npmjs.org/`
    refreshed the NVM Node 22 install.
  - `zsh -lic 'repo-harness update --version 0.5.0'` completed through the
    real shell entrypoint.
  - Bun, NVM, npx, and `/opt/homebrew/bin/repo-harness` all returned `0.5.0`.
  - `repo-harness status --json` returned CLI `0.5.0`, Codex and Claude global
    adapters installed, and `8` managed routes.
  - `repo-harness doctor --json` returned summary `ok=11`, `warn=0`,
    `fail=0`, `na=1`.
  - `repo-harness security scan --json` returned status `ok` with no findings.
  - `HOOK_HOST=codex repo-harness-hook state-snapshot --json` and
    `HOOK_HOST=claude repo-harness-hook state-snapshot --json` both returned
    valid state snapshot JSON.

## Hold Reason

- None. The package, registry, Git tag, GitHub release, and local runtime
  refresh are closed for `0.5.0`.
