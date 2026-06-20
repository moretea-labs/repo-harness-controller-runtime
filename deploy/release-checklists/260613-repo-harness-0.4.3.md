# Release Filing: repo-harness 0.4.3

## Scope

- Package target: `repo-harness@0.4.3`
- Base release: `v0.4.2`
- Release branch: `main`
- Registry: `https://registry.npmjs.org/`

## Version Decision

Use `0.4.3` as the next patch release on top of the published `0.4.2` line.
This slice keeps the unified package/template version model introduced in
`0.4.0` and publishes compatible CLI/runtime improvements: bundled docs lookup,
init-hook bootstrap audit guidance, first-principles edit guard coverage, and
lighter generated reference-doc assets. The release gate also refreshes the
current handoff before writing the Codex resume packet so clean checkouts can
pass strict workflow without pre-existing ignored handoff runtime files.

## Required Alignment

- `package.json`
- `.claude/.skill-version`
- `assets/skill-version.json`
- `src/cli/commands/status.ts`
- README current release/stamp references
- `docs/CHANGELOG.md`
- version expectation tests

## Preflight Evidence

- `npm view repo-harness@0.4.2 version --json --registry https://registry.npmjs.org/`
  returned `0.4.2`, proving the previous package is already published.
- `npm view repo-harness versions --json --registry https://registry.npmjs.org/`
  included `0.4.2` as the latest published package before the bump.
- `npm view repo-harness@0.4.3 version --json --registry https://registry.npmjs.org/`
  returned `E404`, proving `0.4.3` is unpublished before publish.
- `gh release view v0.4.2 --repo Ancienttwo/repo-harness --json tagName,name,publishedAt,url,targetCommitish,isDraft,isPrerelease,assets`
  returned the public `v0.4.2` release with no assets.

## Verification

- `node -e "JSON.parse(require('fs').readFileSync('assets/skill-version.json','utf8')); const p=require('./package.json'); console.log(p.name+'@'+p.version)"`
  returned `repo-harness@0.4.3`.
- `bun src/cli/index.ts --version` returned `0.4.3`.
- `bun src/cli/index.ts status --json` returned CLI version `0.4.3` and `8`
  managed routes.
- `bash scripts/check-npm-release.sh` passed:
  - npm registry uniqueness for `repo-harness@0.4.3`
  - `bun install --frozen-lockfile`
  - `bun test` (`706 pass`, `0 fail`)
  - `bash scripts/check-deploy-sql-order.sh`
  - `bash scripts/check-architecture-sync.sh`
  - `bash scripts/check-task-sync.sh`
  - `REPO_HARNESS_SKIP_RESUME_REFRESH=1 bash scripts/prepare-handoff.sh "release gate"`
  - `bash scripts/codex-handoff-resume.sh --cwd . --reason "release gate"`
  - `bash scripts/check-task-workflow.sh --strict`
  - `bun scripts/inspect-project-state.ts --repo . --format text`
  - `bash scripts/migrate-project-template.sh --repo . --dry-run`
  - `npm pack --dry-run --json`
- Visible package inspection with `npm pack --dry-run --json` reported
  `repo-harness-0.4.3.tgz`, `270` files, and required package entries for
  `src/cli/commands/docs.ts`, `src/cli/commands/init-hook.ts`,
  `assets/hooks/first-principles-guard.sh`,
  `assets/reference-configs/harness-overview.md`, `README.md`, and `SKILL.md`.
  It also confirmed the retired duplicate reference-doc assets
  `docs/reference-configs/AGENTS.md`, `docs/reference-configs/CLAUDE.md`,
  `assets/reference-configs/AGENTS.md`, and `assets/reference-configs/CLAUDE.md`
  are not packaged.
- `bun src/cli/index.ts docs list` printed the bundled docs catalog, including
  `hook-operations`, `harness-overview`, and `release-deploy`.
- `bun src/cli/index.ts init-hook --json` returned parseable JSON with `23`
  checks.
- `git diff --check` passed.
- `bash scripts/check-task-workflow.sh --strict` and
  `bash scripts/check-task-sync.sh` passed after the release gate refreshed the
  Codex resume packet.
- An isolated detached-worktree run initially exposed a clean-checkout blocker:
  `.ai/harness/handoff/current.md` is ignored runtime state, so strict workflow
  failed when the release gate wrote only the resume packet. The release gate now
  runs `prepare-handoff.sh` before `codex-handoff-resume.sh`. A second isolated
  detached-worktree run of `bash scripts/check-npm-release.sh` passed with
  `706 pass`, `0 fail`, and `[release] OK: npm package gate passed`.

## Acceptance Evidence (2026-06-13 /check, v0.4.2..HEAD + release prep)

- External acceptance: Codex (`codex-review`) returned **pass**, 0 P1, 3 P2
  advisories; full block recorded in
  `tasks/reviews/repo-harness-0.4.3-release-acceptance.review.md`.
- Acceptance fixes applied before publish:
  - Synced `assets/reference-configs/handoff-protocol.md` with
    `docs/reference-configs/handoff-protocol.md` (restored the current-input
    priority step that commit `b8657c9` added to `docs/` only). The two copies
    are byte-identical again, so the bundled `repo-harness docs show
    handoff-protocol` output matches repo truth and self-migration apply mode
    cannot regress the docs copy.
  - Guarded the user-level Global Working Rules read in
    `src/cli/commands/init-hook.ts` so an unreadable `~/.codex/AGENTS.md` /
    `~/.claude/CLAUDE.md` reports `needs_agent` with an `unreadable (...)`
    detail instead of crashing the read-only audit; regression test added in
    `tests/cli/init-hook.test.ts` (EISDIR via directory-at-path).
- `bash scripts/check-npm-release.sh` on the final fixed tree passed:
  `707 pass`, `0 fail` across 68 files, gate exit 0,
  `[release] OK: npm package gate passed.`
- `npm pack --dry-run` on the final tree reported `repo-harness-0.4.3.tgz`,
  `270` files, including the updated
  `assets/reference-configs/handoff-protocol.md` and
  `src/cli/commands/init-hook.ts`.
- Open disposition (maintainer call): untracked
  `plans/plan-20260613-0314-think-scan-init-hook.md` is an empty Draft
  skeleton superseded by the committed `0328` plan; archive or delete before
  filing the release commit.
  - Resolved during publish: a concurrent session captured it as a tracked
    Draft plan with notes in `d6ce29c` (`docs(plans): capture init-hook scan
    draft`), keeping it out of the active execution path.

## Publish Follow-through

- Release prep commit: `e79bc7e` (`chore(release): prepare repo-harness
  0.4.3`), pushed as `b878082..e79bc7e` on `main`.
- npm publish (maintainer-approved, token from local `_ops/env/`):
  - `npm publish --access public --registry https://registry.npmjs.org/`
  - Result: published `repo-harness@0.4.3` with the `latest` dist-tag after
    the `prepublishOnly` release gate passed in-publish; `npm notice total
    files: 270`.
- Registry readback after publish:
  - `npm view repo-harness@0.4.3 version dist-tags dist.tarball gitHead
    dist.shasum --json`
  - Returned `version=0.4.3`, `latest=0.4.3`,
    `gitHead=d6ce29c23ea798b540d0eab2643d2946b240b49f`, and
    `dist.shasum=944083df550aa6a0090f8e6cabaa2c331a82bbc3`.
  - gitHead note: concurrent commit `d6ce29c` (plans/tasks docs only) landed
    between the prep commit and the publish snapshot; `git diff
    e79bc7e..d6ce29c --name-only` touches no packaged path, so the published
    tarball content is identical to the verified `e79bc7e` tree. The tag
    targets `d6ce29c` to keep tag, registry `gitHead`, and published tree
    aligned.

## Publish Artifacts

- npm package: `repo-harness@0.4.3`
- npm tarball: `https://registry.npmjs.org/repo-harness/-/repo-harness-0.4.3.tgz`
- npm shasum: `944083df550aa6a0090f8e6cabaa2c331a82bbc3`
- Git tag: `v0.4.3` (annotated, at `d6ce29c`)
- GitHub release:
  `https://github.com/Ancienttwo/repo-harness/releases/tag/v0.4.3`
  (non-draft, non-prerelease, published 2026-06-12T21:32:06Z)

## Publish Status

- npm: published and read back as latest.
- GitHub release: published, non-draft, non-prerelease.
- Hold reason: none.
- Post-release action (security): the npm token used for this publish was
  exposed to the local agent session transcript during release execution;
  revoke/rotate it on npmjs.com and refresh `_ops/env/npm.env`.
