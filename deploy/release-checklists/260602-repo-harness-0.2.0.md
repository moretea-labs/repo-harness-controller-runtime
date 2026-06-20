# Release Filing: repo-harness 0.2.0

Date: 2026-06-02
Filing ID: 260602-repo-harness-0.2.0
Status: Published

## Naming

Release filing documents use a `YYMMDD-<package>-<version>.md` filename. This
file uses `260602` so the release artifact sorts by filing date without relying
only on GitHub or npm metadata.

## Scope

- Package: `repo-harness@0.2.0`
- Generated workflow compatibility: `5.2.3` (unchanged)
- Public CLI commands: adds `repo-harness security scan`
- Host adapter contract: unchanged, still `repo-harness-hook <event> --route <route>`;
  the `SessionStart.default` route gains an ordered `security-sentinel.sh` script.
- Main change: a read-only config security sentinel (scan command + low-frequency
  SessionStart hook + `doctor` check), plus README promotion of the installer, the
  draft-plan lifecycle, and the file-backed cross-session / token-lean value props.

## Included Changes

- Added `repo-harness security scan [--json]` (`src/cli/commands/security.ts`): read-only
  checks over `~/.claude/settings.json`, `~/.codex/hooks.json`, repo-local
  `.vscode/tasks.json`, and legacy project-level `.claude`/`.codex` hook adapters for
  suspicious command patterns, unmanaged hooks, and auto-run `folderOpen` tasks. Never
  mutates config.
- Added the `SessionStart` sentinel `.ai/hooks/security-sentinel.sh` (and the
  `assets/hooks/` template) wired into the `SessionStart.default` route; it fingerprints
  the config set and re-scans only on fingerprint change, with `latest.json` /
  `state.sha256` kept as ignored runtime state under `.ai/harness/security/`.
- Added a `security-config` check to `repo-harness doctor`.
- Bumped `package.json`, `src/cli/index.ts`, and `src/cli/commands/status.ts` from
  `0.1.5` to `0.2.0`; updated `tests/bootstrap-files.test.ts` accordingly.
- Added `Why repo-harness` and `What's New in 0.2.0` sections to `README.md`,
  `README.zh-CN.md`, `README.ja.md`, `README.fr.md`, and `README.es.md`; fixed
  the Chinese README's stale `0.1.4` reference.
- Added `docs/images/repo-harness-hook-carrot.png` to the package allowlist so
  the README hero image is present in the npm tarball.

## Verification

- `bun src/cli/index.ts --version` returned `0.2.0`.
- `bun src/cli/index.ts status` reported `repo-harness 0.2.0`.
- `bun src/cli/index.ts doctor --json` reported `security-config` as `ok`
  after scanning 5 files with no findings.
- `npm pack --dry-run --json` reported `repo-harness@0.2.0`, included
  `docs/images/repo-harness-hook-carrot.png`, and included all five README files.
- `bash scripts/check-npm-release.sh` passed before publish: 558 pass, 6 skip,
  0 fail; it also ran `bun install --frozen-lockfile`, `bun test`,
  `bash scripts/check-deploy-sql-order.sh`, `bash scripts/check-task-sync.sh`,
  `bash scripts/check-task-workflow.sh --strict`,
  `bun scripts/inspect-project-state.ts --repo . --format text`,
  `bash scripts/migrate-project-template.sh --repo . --dry-run`, and
  `npm pack --dry-run --json`.
- `npm publish --registry https://registry.npmjs.org/ --access public` passed
  after rerunning the release gate: 558 pass, 6 skip, 0 fail.
- `npm view repo-harness@0.2.0 version dist.tarball gitHead --registry
  https://registry.npmjs.org/` returned `0.2.0`, the published tarball URL, and
  package git head `51a6ff40788dc890be87fd401dd0e38b36ee562d`.

## Published Artifacts

- npm: https://www.npmjs.com/package/repo-harness/v/0.2.0
- GitHub release: https://github.com/Ancienttwo/repo-harness/releases/tag/v0.2.0
