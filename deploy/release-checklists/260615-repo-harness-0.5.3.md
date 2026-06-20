# Release Filing: repo-harness 0.5.3

Date: 2026-06-15
Status: Released to npm and GitHub

## Scope

- Package target: `repo-harness@0.5.3`
- Base release: `v0.5.2`
- Release branch: `main`
- Registry: `https://registry.npmjs.org/`

## Version Decision

Use `0.5.3` as a patch release. The release contains the post-`0.5.2`
CLI parsing fix that lets `repo-harness update --version <version>` install a
specific package version while keeping the top-level `repo-harness --version`
shortcut intact.

## Required Alignment

- `package.json`
- `.claude/.skill-version`
- `assets/skill-version.json`
- README current release/stamp references, including localized READMEs
- `docs/CHANGELOG.md`
- version expectation tests
- `src/cli/index.ts`
- `tests/cli/global-runtime-init.test.ts`

## Preflight Evidence

- `npm view repo-harness version dist-tags --json --registry https://registry.npmjs.org/`
  returned current latest `0.5.2` before the version bump.
- `npm view repo-harness@0.5.3 version --json --registry https://registry.npmjs.org/`
  returned `E404`, proving the target package is unpublished before publish.
- `gh release view v0.5.2 --repo Ancienttwo/repo-harness --json tagName,name,publishedAt,url,targetCommitish,isDraft,isPrerelease,assets`
  returned the public `v0.5.2` release, non-draft, non-prerelease, with no
  assets.
- `repo-harness setup check --target codex --check-updates --json` returned
  `status=ok`, `28 ok`, `0 warn`, `0 fail`, `0 needs_agent`; CLI, Waza, and
  CodeGraph were all current.

## Verification

- `bun src/cli/index.ts --version` returned `0.5.3`.
- `bun scripts/check-skill-version.ts --project .` passed with
  `repo-harness=0.5.3` and `template=0.5.3`.
- `bun test tests/bootstrap-files.test.ts tests/skill-version.test.ts tests/readme-dx.test.ts tests/cli/global-runtime-init.test.ts`
  passed with `43 pass`, `0 fail`.
- `BUN_TEST_TIMEOUT_MS=180000 BUN_TEST_MAX_CONCURRENCY=1 bun run check:release`
  passed with `754 pass`, `0 fail`, then completed workflow checks, repository
  inspection, and `npm pack --dry-run`.

## Publish Evidence

- `npm publish --access public --registry https://registry.npmjs.org/` completed
  after the package prepublish gate passed with `754 pass`, `0 fail`.
- Published tarball:
  - filename: `repo-harness-0.5.3.tgz`
  - package size: `4.7 MB`
  - unpacked size: `6.5 MB`
  - total files: `280`
  - shasum: `1c412ca8f128760019c163ad396afa16481bdd16`
- `npm view repo-harness version dist-tags --json --registry https://registry.npmjs.org/`
  returned `version=0.5.3` and `latest=0.5.3`.
- `npm view repo-harness@0.5.3 version gitHead dist.shasum dist.tarball --json --registry https://registry.npmjs.org/`
  returned `gitHead=88a127181d07e5f53739e198134510f381a4ce2b`,
  `dist.shasum=1c412ca8f128760019c163ad396afa16481bdd16`, and
  `dist.tarball=https://registry.npmjs.org/repo-harness/-/repo-harness-0.5.3.tgz`.
- Clean-room package smoke:
  `npx --yes --package repo-harness@0.5.3 repo-harness --version` returned
  `0.5.3`.
- Created and pushed annotated tag `v0.5.3` at
  `88a127181d07e5f53739e198134510f381a4ce2b`.
- Created GitHub release:
  `https://github.com/Ancienttwo/repo-harness/releases/tag/v0.5.3`.
- `gh release view v0.5.3 --repo Ancienttwo/repo-harness --json tagName,name,publishedAt,url,targetCommitish,isDraft,isPrerelease,assets`
  returned `isDraft=false`, `isPrerelease=false`, `publishedAt=2026-06-14T21:36:07Z`,
  and the release URL above.
- Local npm global runtime:
  `command -v repo-harness` returned `/opt/homebrew/bin/repo-harness`,
  `repo-harness --version` returned `0.5.3`, and
  `npm list -g repo-harness --depth=0 --json` returned `0.5.3`.
- Regression runtime proof:
  `repo-harness update --version 0.5.3 --json` executed the update workflow
  instead of printing the top-level version. It installed
  `repo-harness@0.5.3`, synced the Codex/Claude skill links, left host adapters
  unchanged, and exited `0`.
- Post-refresh runtime checks:
  - `repo-harness status --json` returned `cli.version=0.5.3`, `routeCount=8`,
    and `8/8` managed entries for both Codex and Claude.
  - `repo-harness doctor --json` returned `0 fail`, `0 warn`, `11 ok`.
  - `repo-harness setup check --target codex --check-updates --json` returned
    `status=ok`, `28 ok`, `0 warn`, `0 fail`.

## Hold Reason

- None. npm publish, registry readback, tag push, GitHub release, and local
  runtime refresh are complete.
