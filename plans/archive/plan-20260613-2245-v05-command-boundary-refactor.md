# Plan: v0.5 Command Boundary Refactor

> **Status**: Archived
> **Created**: 20260613-2245
> **Slug**: v05-command-boundary-refactor
> **Planning Source**: ChatGPT share
> **Source Ref**: https://chatgpt.com/s/t_6a2d6bf9742c8191a6d47bf0e10c6fd3
> **Local Ref**: `plans/repo-harness-v0.5-refactor-plan.md`
> **Related Issue**: https://github.com/Ancienttwo/repo-harness/issues/2

## Summary

The archived proposal recommends a v0.5 breaking refactor that separates command ownership:

```text
init        = first-run user/machine bootstrap
update      = CLI package plus user-level managed runtime refresh
adopt       = repo-level workflow contract install, refresh, migration, and compaction
setup check = read-only readiness checks and Agent action output
```

The core invariant is that user-level commands must not write repo workflow files, repo-level commands must not write HOME, and readiness commands must remain read-only.

## Problem

Issue #2 reports that `repo-harness update` v0.4.3 can resolve the target repo as `$HOME`, walk the full home directory, discover vendored `AGENTS.md` / `CLAUDE.md` files under read-only trees such as `go/pkg/mod`, and fail during context-file mirroring with `cp: Permission denied`. The failure leaves the migration half-applied and also drives CodeGraph indexing over a non-project tree.

The observed design pressure is broader than a missing prune: the current `update` command mixes repo refresh, host adapter writes, skill sync, external tooling bootstrap, CodeGraph setup, and brain sync through one `runInit()` path.

## Target UX

```bash
bun add -g repo-harness
repo-harness init

repo-harness update

cd my-repo
repo-harness adopt --dry-run
repo-harness adopt

repo-harness setup check --json
```

## Command Contract

| Command | Writes HOME | Writes Repo | Read-only | Notes |
|---|---:|---:|---:|---|
| `init` | yes | no | no | First-run user runtime bootstrap. |
| `update` | yes | no | no | CLI/user-runtime refresh only. |
| `adopt` | no | yes | no | Repo workflow contract install/refresh/migration. |
| `setup check` | no | no | yes | Formal product name for the current `init-hook` readiness checklist. |
| `doctor` | no | no | yes | Diagnostics remain read-only. |

## Phases

1. Command semantics: add `adopt`, add `setup check`, keep `init-hook` as a compatibility alias, and make `update --repo` a rejected migration hint.
2. Module split: move user-runtime, repo-adoption, setup, and helper runtime code behind explicit import boundaries.
3. Contract v2: move policy to package defaults plus repo overrides, and keep repo reference docs as resolver stubs.
4. Helper dispatch: add `repo-harness run <helper>` and move common helper runtime to package dispatch, with self-host repo override support.
5. Compact/migrate: provide `adopt --migrate-legacy --compact` for v1 repo cleanup while preserving user-authored files.
6. Docs and release: document the breaking command semantics and migration path.

## This Slice

This implementation starts with phase 1 and the issue #2 safety rail:

- `repo-harness update` becomes user-level runtime refresh.
- `repo-harness update --check` / `--no-runtime-refresh` expose the read-only
  readiness surface without runtime writes.
- `repo-harness adopt` takes over the current repo-level refresh options.
- `repo-harness adopt` rejects user-level CodeGraph/brain configuration flags.
- `repo-harness setup check` forwards to the read-only readiness checklist.
- repo adoption refuses `$HOME` and default non-git cwd targets before any writes.
- legacy context discovery prunes vendored/cache trees at any depth.
- context mirroring skips unwritable directories instead of aborting the migration.

## Deferred Work

- Extract `src/cli/user-runtime/*`, `src/cli/repo-adoption/*`, `src/cli/setup/*`, and `src/cli/runtime/*`.
- Add import-boundary tests.
- Introduce workflow contract v2 and override-only policy resolver.
- Add `repo-harness run <helper>` package dispatch.
- Implement `adopt --compact` and full v1-to-v2 migration.
