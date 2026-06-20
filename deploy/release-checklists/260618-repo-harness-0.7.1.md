# Release Filing: repo-harness 0.7.1

Date: 2026-06-18
Status: Published

## Scope

- Package target: `repo-harness@0.7.1`
- Base release: `v0.7.0`
- Release branch: `main`
- Registry: `https://registry.npmjs.org/`

## Version Decision

Use `0.7.1` as a patch release. The release adds the GPT Pro setup and consult
skill facades over the existing ChatGPT Web browser-session bridge, keeps the
user-facing command language focused on `gptpro_*`, and fixes PostBash advisory
metadata so it no longer pollutes the authoritative `latest.json`
`repo-harness-run-trace.v1` slot.

## Required Alignment

- `package.json`
- `assets/skill-version.json`
- README current release/stamp references, including localized READMEs
- `docs/CHANGELOG.md`
- `assets/skill-commands/manifest.json`
- `assets/skill-commands/repo-harness-gptpro-setup/SKILL.md`
- `assets/skill-commands/repo-harness-gptpro/SKILL.md`
- PostBash installable and self-host hook runtime copies
- version expectation tests
- release checklist

## Preflight Evidence

- `npm view repo-harness version --registry https://registry.npmjs.org/`
  returned current latest `0.7.0`.
- `npm view repo-harness@0.7.1 version --json --registry https://registry.npmjs.org/`
  returned `E404`, proving the target package is unpublished before publish.
- `repo-harness setup check --target codex --check-updates --json` reported
  `status=ok`, `28 ok`, and no warnings, failures, or agent actions after Waza
  and CodeGraph bounded update commands were rerun.

## Verification

- `bun src/cli/index.ts --version` returned `0.7.1`.
- `bun scripts/check-skill-version.ts --project .` passed with
  `repo-harness=0.7.1`, `template=0.7.1`, and project stamp up to date.
- Full release gate passed:
  `BUN_TEST_TIMEOUT_MS=180000 BUN_TEST_MAX_CONCURRENCY=1 bun run check:release`
  returned `842 pass`, `0 fail`, then completed deploy SQL order,
  architecture sync, task sync, brain sync, strict workflow, repository
  inspection, package dry-run, tarball install smoke, and
  `[release] OK: npm package gate passed`.
- `npm pack --dry-run --json --registry https://registry.npmjs.org/`
  returned:
  - filename: `repo-harness-0.7.1.tgz`
  - package size: `7823545`
  - unpacked size: `10111036`
  - total files: `329`
  - shasum: `b5578e47bf8638f9f3ac994577f8ce6637269205`
  - integrity:
    `sha512-EAZMeECUmCCcm7oZWHQTfrKrZbe7FFwpAaQ/iGy2Ru0DcRNRPnroPP6eii03bL+1uzMOhPrscdBii+NiB+CQiw==`
- The package dry-run includes
  `assets/skill-commands/repo-harness-gptpro-setup/SKILL.md`,
  `assets/skill-commands/repo-harness-gptpro/SKILL.md`, and the updated
  `assets/hooks/post-bash.sh`.
- `npm publish --registry https://registry.npmjs.org/ --access public` used a
  temporary npmrc backed by the local `_ops/env/npm-token.md` token, verified
  the publish identity as `ancienttwo`, reran the full `prepublishOnly` release
  gate successfully, and published `repo-harness@0.7.1`.
- `npm view repo-harness@0.7.1 version dist.tarball dist.shasum dist.integrity gitHead --json --registry https://registry.npmjs.org/`
  returned:
  - `version = "0.7.1"`
  - `dist.tarball = "https://registry.npmjs.org/repo-harness/-/repo-harness-0.7.1.tgz"`
  - `dist.shasum = "b5578e47bf8638f9f3ac994577f8ce6637269205"`
  - `dist.integrity = "sha512-EAZMeECUmCCcm7oZWHQTfrKrZbe7FFwpAaQ/iGy2Ru0DcRNRPnroPP6eii03bL+1uzMOhPrscdBii+NiB+CQiw=="`
  - `gitHead = "43d2f3d9362f4d4018286b94815aa9e21f015dbc"`
- `npm view repo-harness dist-tags --json --registry https://registry.npmjs.org/`
  returned `{ "latest": "0.7.1" }`.
- `bash scripts/check-release-published.sh 0.7.1` passed, proving registry,
  dist-tag, tarball, local tag, and local version files agree.
- Clean temporary install smoke passed:
  `npm install --registry https://registry.npmjs.org/ repo-harness@0.7.1`
  followed by `node_modules/.bin/repo-harness --version` returned `0.7.1`.
- Git tag `v0.7.1` points to release commit `43d2f3d`.

## Post-Release Local Install

- `bun add -g repo-harness@0.7.1` installed the local PATH-visible
  `repo-harness` and `repo-harness-hook` binaries.
- `repo-harness --version` returned `0.7.1` from `/Users/kito/.bun/bin/repo-harness`.
- Final `repo-harness setup check --target codex --check-updates --json`
  reported repo-harness itself current with `current=0.7.1; latest=0.7.1`,
  CodeGraph up to date, Waza up to date, and one residual external-tooling
  action for `gbrain`.
- Residual: `bun add -g gbrain` now installs npm `gbrain@1.3.1`, a GPU
  JavaScript library with no CLI `bin`; the previous `~/.bun/bin/gbrain` shim
  therefore remains non-runnable. Do not treat this as a `repo-harness@0.7.1`
  release blocker.

## Release Links

- npm: https://www.npmjs.com/package/repo-harness/v/0.7.1
- npm tarball: https://registry.npmjs.org/repo-harness/-/repo-harness-0.7.1.tgz
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.7.1
