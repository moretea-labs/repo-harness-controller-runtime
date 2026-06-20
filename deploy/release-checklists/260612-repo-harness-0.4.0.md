# Release Filing: repo-harness 0.4.0

Date: 2026-06-12
Status: Published

## Scope

- Package: `repo-harness@0.4.0`
- GitHub tag: `v0.4.0`
- Base npm tag: `v0.3.0`
- Target branch: `main`
- Generated workflow stamp: `repo-harness@0.4.0+template@0.4.0`

## Version Decision

Use `0.4.0`, not `0.3.1`. The diff since `repo-harness@0.3.0` adds public
workflow and CLI surfaces: state snapshots, architecture queue gates,
contract-run delegation, heartbeat triage, route evals, and generated-repo
template sync. That is a minor release, not a patch-only bugfix.

The old separate `5.x` generated workflow compatibility line is retired in this
release. `package.json`, `repo-harness --version`, `assets/skill-version.json`,
and generated `.claude/.skill-version` stamps now share `0.4.0`.

## Release Notes

- Adds `repo-harness-hook state-snapshot --json`, the NL decision-table
  reference, route NL-vs-TS benchmark fixtures, and a loop-engine cutover gate.
- Replaces the retired append-only architecture drift helper with
  `scripts/architecture-queue.sh`, `scripts/check-architecture-sync.sh`, and a
  derived architecture request index.
- Adds contract delegation metadata (`budget`, `permission_scope`, `roles`) and
  the `scripts/contract-run.ts` worker/verifier pilot runner.
- Adds `scripts/heartbeat-triage.sh` plus `.ai/harness/triage/` for scheduled
  workflow, sprint-next, and architecture-request triage.
- Syncs the new workflow assets into generated-repo templates, migration
  handling, reference docs, and parity tests.

## Verification

- `bash scripts/check-npm-release.sh`
  - `bun test`: 678 pass, 0 fail, 6476 assertions across 67 files.
  - `bash scripts/check-deploy-sql-order.sh`: OK.
  - `bash scripts/check-architecture-sync.sh`: advisory mode, 4 changed
    capabilities, 0 blocking findings.
  - `bash scripts/check-task-sync.sh`: synchronized task notes present.
  - Brain manifest and brain sync checks: OK.
  - `bash scripts/check-task-workflow.sh --strict`: OK.
  - npm package gate: OK.
- `bun test tests/bootstrap-files.test.ts tests/readme-dx.test.ts tests/skill-version.test.ts`
  - 31 pass, 0 fail.
- `bun scripts/check-skill-version.ts --project .`
  - `Workflow version check passed: repo-harness=0.4.0, template=0.4.0`.
- `bash scripts/migrate-project-template.sh --repo . --dry-run`
  - Self-migration dry run completed after the tracked `.claude/.skill-version`
    stamp was updated to `0.4.0`.
- `npm pack --dry-run --json`
  - filename: `repo-harness-0.4.0.tgz`
  - entry count: 290
  - package size: 1,955,348 bytes
  - unpacked size: 3,718,598 bytes
  - shasum: `88b5877750392991d78c6042ab96245d1bdb8246`

## Publish Status

- npm: published to the official registry.
- Registry readback:
  - `npm view repo-harness version --registry https://registry.npmjs.org/`
    returned `0.4.0`.
  - `npm view repo-harness@0.4.0 version dist.tarball gitHead dist.shasum
    dist.integrity --json --registry https://registry.npmjs.org/` returned:
    - `version = "0.4.0"`
    - `dist.tarball =
      "https://registry.npmjs.org/repo-harness/-/repo-harness-0.4.0.tgz"`
    - `gitHead = "bef7cdc34b01b2a3c929d171dd35a4e87bea26eb"`
    - `dist.shasum = "88b5877750392991d78c6042ab96245d1bdb8246"`
    - `dist.integrity =
      "sha512-REXWc7LLowPP6snXkZgirZlTGTNJRKGev7up/C2C6V6keiq/ZQF8KfLSZvlvg433gOboTkb72W13ksqJSDld4Q=="`
- GitHub release: create or verify `v0.4.0` from the published source commit.
