# Release Filing: repo-harness 0.2.4

Date: 2026-06-07
Status: Published

## Scope

- Package: `repo-harness@0.2.4`
- GitHub tag: `v0.2.4`
- Base tag: `v0.2.3`
- Target branch: `main`
- Generated workflow compatibility: `5.2.3`

## Release Notes

- Prompt hooks now fall back to shell-side decision logic when installed copies
  cannot reach the TypeScript decision engine.
- Workflow checks now detect stale handoff/resume plan references.
- The npm release gate now refreshes the ignored Codex resume packet before
  strict workflow validation, so release tests cannot leave handoff runtime
  state stale before the final workflow check.
- Action-command skills now carry static readiness gates for failure modes,
  boundaries, and high-risk checkpoints.
- Benchmark reports now label skill-eval authority and keep dry-run smoke output
  separate from release-grade effectiveness evidence.
- Self-host CodeGraph tooling is refreshed to `0.9.9`, and gbrain readiness uses
  `doctor --json --fast` before falling back to the full doctor command.
- Plan/workflow consultation prompts stay advisory instead of reaching
  `PlanStatusGuard`, so questions that mention `new plan`, `方案`, hooks, or
  workflow routing do not create plan files or block unless they explicitly
  start execution.
- The self-host-only `autoresearch-advisory.sh` hook is retired from `.ai/hooks`,
  generated hook installers, and user-level adapters. Autoresearch evidence is
  now explicit agent-run work, not a background hook route.

## Verification

- `bash scripts/check-npm-release.sh` passed in this session:
  - npm registry uniqueness check for `repo-harness@0.2.4`
  - `bun install --frozen-lockfile`
  - `bun test`: 581 pass, 6 skip, 0 fail
  - `bash scripts/check-deploy-sql-order.sh`
  - `bash scripts/check-task-sync.sh`
  - `bash scripts/check-task-workflow.sh --strict`
  - `bun scripts/inspect-project-state.ts --repo . --format text`
  - `bash scripts/migrate-project-template.sh --repo . --dry-run`
  - `npm pack --dry-run --json`
- `bun run benchmark:skills -- --agent codex --profile with_skill --eval route-workflow-check --iteration release-0.2.4` passed:
  - `full_test_count = 1`
  - `dry_run_count = 0`
  - `dry_run_ratio = 0.0%`
  - `grader_pass_rate = 100.0% (4/4)`
  - `effectiveness_authority = authoritative`
- `npm publish --registry https://registry.npmjs.org/ --access public` used a
  temporary npmrc verified as `ancienttwo`, reran the full `prepublishOnly`
  gate successfully, and published `repo-harness@0.2.4`.
- The first publish attempt after the passing gate failed before upload because
  the local npm cache hit `EACCES` while creating an entry under
  `~/.npm/_cacache`; the successful publish used a temporary
  `NPM_CONFIG_CACHE` instead of mutating the global cache.
- The publish notice reported `repo-harness-0.2.4.tgz`, 278 files, package size
  1.9 MB, unpacked size 3.4 MB, shasum
  `e55df4758f61a6f272325802379db142243b244e`, and no
  `autoresearch-advisory.sh` file.
- `bash scripts/check-agent-tooling.sh --host both --json` reported CodeGraph
  present via local `0.9.9`, Waza present, gbrain warning, and Codex automation
  profile partial.

## Publish Status

- npm: published to the official registry.
- Registry readback:
  - `npm view repo-harness@0.2.4 version --registry https://registry.npmjs.org/`
    returned `0.2.4`.
  - `dist.tarball` is
    `https://registry.npmjs.org/repo-harness/-/repo-harness-0.2.4.tgz`.
  - `dist.shasum` is `e55df4758f61a6f272325802379db142243b244e`.
  - `gitHead` is `ca54c14d3d74f1cf9ac4b6db6d3da81b37a55340`.
- Clean-room npx smoke passed from an empty temp directory with a temporary npm
  cache:
  - `npx -y --registry https://registry.npmjs.org/ repo-harness@0.2.4 --version`
    returned `0.2.4`.
  - `npx -y --registry https://registry.npmjs.org/ repo-harness@0.2.4 init --help`
    displayed the expected `repo-harness init` command help.
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.2.4
