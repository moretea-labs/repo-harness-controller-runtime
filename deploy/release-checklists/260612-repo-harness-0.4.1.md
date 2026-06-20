# Release Filing: repo-harness 0.4.1

Date: 2026-06-12
Status: Published; registry, GitHub release, and local runtime refreshed

## Scope

- Package target: `repo-harness@0.4.1`
- Current npm latest: `repo-harness@0.4.1`
- Base npm tag: `v0.4.0`
- Target branch: `main`
- Source commit: `bcd0b1e7a8c0050af3323441ad8ba003f1572ab7`
- Release tag: `v0.4.1`
- Version surfaces bumped before publish:
  - `package.json`
  - `assets/skill-version.json`
  - `src/cli/commands/status.ts`
  - README version/stamp references
  - version expectation tests

## Version Decision

Use `0.4.1`, not another `0.4.0` filing. The npm registry already reports
`repo-harness@0.4.0` as published, and this slice is a compatibility/safety
patch on top of the `0.4.0` loop-engine release line.

This is a patch release because it does not add a new public CLI command. It
fixes hook session-state correctness, prevents stale repo-local hook copies from
competing with user-level adapters, and finishes the active workflow-document
surface migration to `tasks/todos.md` plus `docs/researches/`.

## Release Notes

- CodeGraph route hints are now session-scoped. Hook stdin `session_id` is
  parsed once by `hook-input.sh`, exported as `HOOK_SESSION_ID`, and preferred
  by `session-state.sh` before environment fallbacks or `.claude/.session-id`.
- Non-pinned repos no longer vendor top-level `.ai/hooks/*.sh` runtime scripts
  during init, create, or migration. They retain `.ai/hooks/lib/` helper
  fallbacks plus a README explaining that active hook execution is user-level
  and central-first.
- Repos that explicitly set `"hook_source": "repo"` still receive the full
  vendored hook runtime for self-hosted hook development.
- Stale pinned hook runtimes that are missing `post-tool-observer.sh` now
  soft-skip `PostToolUse.always` and print a `repo-harness update --repo ...`
  hint instead of failing the hook with `script not found`.
- Active workflow docs now use `tasks/todos.md` for deferred goals and
  `docs/researches/*.md` for topic-scoped durable research. Legacy
  `tasks/todo.md` and `tasks/research.md` are migration inputs only.
- The managed runtime ignore block now covers `tasks/.current.md.tmp.*` and
  `.claude/.plan-state/`.
- Plain `bun test` now uses a 60s per-test timeout through `bunfig.toml`, which
  matches the release gate's long-running migration/hook test budget.

## Downstream Smoke

- `repo-harness update --repo /Users/chris/Projects/enterprise-brain` refreshed
  the downstream workflow assets and kept `.ai/hooks` lib-only with a README
  tombstone.
- Cleared stale downstream CodeGraph/session state:
  `.claude/.session-id` and `.claude/.codegraph-state/*.used`.
- Verified downstream session-scoped CodeGraph routing:
  - first prompt for session `codex-smoke-20260612-downstream` emitted
    `[CodegraphRoute]`
  - the second prompt with the same session did not emit `[CodegraphRoute]`
  - a prompt with session `codex-smoke-20260612-downstream-2` emitted
    `[CodegraphRoute]` again

## Verification So Far

- Final release gate after the version bump and `PostToolUse.always` soft-skip
  fix:
  - `bash scripts/check-npm-release.sh`
  - Result: pass
  - Summary: `681 pass, 0 fail, 6541 expectations across 66 files`; deploy SQL,
    architecture sync, task sync, brain sync, strict workflow, inspect,
    migration dry-run, and `npm pack --dry-run --json` all completed.
- `npm publish --access public --registry https://registry.npmjs.org/` completed
  and reran `prepublishOnly` successfully.
- `bun test`: 681 pass, 0 fail, 6541 expectations across 66 files in the final
  release gate.
- Focused affected suites passed:
  - `bun test tests/cli/hook.test.ts`
  - `bun test tests/workflow-contract.test.ts`
  - `bun test tests/create-project-dirs.runtime.test.ts
    tests/init-project.settings.runtime.test.ts`
  - targeted `tests/migration-script.test.ts` gitignore/hook migration cases
  - targeted `tests/hook-runtime.test.ts` CodeGraph session-scope and
    research-gate cases
- Required checks passed after refreshing the ignored resume packet:
  - `bash scripts/check-task-workflow.sh --strict`
  - `bash scripts/check-deploy-sql-order.sh`
  - `bash scripts/check-architecture-sync.sh`
  - `bash scripts/check-task-sync.sh`
  - `bun scripts/inspect-project-state.ts --repo . --format text`
  - `bash scripts/migrate-project-template.sh --repo . --dry-run`
  - `git diff --check`
- Registry preflight:
  - `npm view repo-harness version --registry https://registry.npmjs.org/`
    returned `0.4.0`.
- Registry readback after publish:
  - `npm view repo-harness@0.4.1 version dist-tags dist.tarball gitHead
    dist.shasum --json --registry https://registry.npmjs.org/`
  - Returned `version=0.4.1`, `latest=0.4.1`,
    `gitHead=bcd0b1e7a8c0050af3323441ad8ba003f1572ab7`, and
    `dist.shasum=98dd3352f15b5ede56bfc970bae33037e3db08a9`.
- Clean-room npm smoke:
  - `npx --yes repo-harness@0.4.1 --version` returned `0.4.1`.
  - `npx --yes repo-harness@0.4.1 update --help` printed the expected update
    command surface.

## Local Runtime Refresh

- Refreshed Bun global package:
  - `bun install -g repo-harness@0.4.1`
- Refreshed npm global package under the active npm prefix:
  - `npm install -g --prefix "$(npm prefix -g)" repo-harness@0.4.1 --registry
    https://registry.npmjs.org/`
- Refreshed global Codex and Claude adapters:
  - `repo-harness install --target both --location global`
  - Result: Codex and Claude adapters were already configured and unchanged.
- Verified local runtime:
  - `repo-harness --version` returned `0.4.1`.
  - `repo-harness status --json` reported CLI `0.4.1`, Codex installed with
    `7/7` managed routes, Claude installed with `7/7` managed routes, and this
    repo opted in.
  - `repo-harness doctor --json` reported `ok=11`, `warn=0`, `fail=0`.
  - `repo-harness security scan --json` reported `status=ok` with no findings.
  - Neutral Codex `SessionStart` hook smoke exited `0` and produced output.

## Publish Artifacts

- npm package: `repo-harness@0.4.1`
- npm tarball: `https://registry.npmjs.org/repo-harness/-/repo-harness-0.4.1.tgz`
- npm shasum: `98dd3352f15b5ede56bfc970bae33037e3db08a9`
- Git tag: `v0.4.1`
- GitHub release:
  `https://github.com/Ancienttwo/repo-harness/releases/tag/v0.4.1`

## Publish Status

- npm: published and read back as latest.
- GitHub release: published, non-draft, non-prerelease.
- Hold reason: none.
