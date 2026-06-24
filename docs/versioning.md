# Versioning and Release Branch Strategy

## Decision

Use four separate version tracks and do not collapse them into one number:

1. Package release line: npm and CLI follow semantic versioning on the current `1.x` line.
2. Controller tool surface line: keep the public Controller compatibility line as `controller-chatgpt-bridge-v8`.
3. Controller implementation train: use `v8.1` only as an internal feature train label for additive V8-era work.
4. Document generations: keep V4/V5/V6/V7/V8 document names as historical architecture and release records, not package versions.

This repository should publish the open-source package line from `1.4.0` forward. It should not renumber the package down to `0.8.x`, `0.81.x`, or `8.1.x`.

## Why `8.1` must not become the package version

`8.1` is already overloaded in the repository:

- The runtime Controller surface is still named `controller-chatgpt-bridge-v8`.
- The runtime schema is still `10` and the surface version is still `8`.
- `src/cli/v81-entry.ts` only adds the repository command onto the existing CLI program; it does not define a new public MCP surface.
- The package line already advanced from `0.8.0` in upstream to `1.0.0` -> `1.1.0` -> `1.2.0` -> `1.3.0` -> `1.4.0` in this fork.

Lowering the package version to `8.1` or `0.8.1` would create three avoidable problems:

1. It would imply a new semver baseline even though published package history already moved onto `1.x`.
2. It would falsely suggest that `v8.1` is a breaking MCP surface revision, while the implemented surface remains V8-compatible.
3. It would make tags, release notes, and dependency update logic harder to reason about because package semver and protocol lineage would no longer be monotonic.

## Recommended compatibility statement

Use this wording in release notes and public docs:

> `repo-harness` package versions `1.4.x` and later implement the Controller `controller-chatgpt-bridge-v8` tool surface. `v8.1` names the additive implementation train inside the V8 compatibility family; it is not a separate package-major or protocol-major line.

Compatibility rules:

- Bump package `PATCH` for fixes and packaging-only changes with no intended user-facing contract change.
- Bump package `MINOR` for additive CLI, docs, workflow, or MCP capabilities that remain compatible with `controller-chatgpt-bridge-v8`.
- Bump package `MAJOR` only when the npm package or CLI contract itself breaks in a way that needs an upgrade guide.
- Mint a new Controller surface generation only when the MCP/tool contract changes incompatibly enough that clients must refresh expectations, for example `controller-chatgpt-bridge-v9`.
- Reserve `v8.1`, `v8.2`, and similar labels for internal planning, milestones, and release notes subtitles inside the V8 family.

## Branch model

Use a single public convergence branch plus short-lived release stabilization branches:

- `main`: the only long-lived public development branch and the default branch.
- `release/1.x`: optional short-lived stabilization branch for a package release candidate when a public cut needs focused docs, packaging, or verification fixes.
- `feature/<topic>`: short-lived work branches named after the actual capability or change scope.
- `archive/<legacy-name>`: optional local or remote archive namespace for preserving historically meaningful branches before deletion if maintainers want a visible record.

Do not keep long-lived public branches named after protocol trains such as `release/v8.1` or `package/v8.1-*`. Those names confuse package semver with Controller surface lineage.

## Branch convergence for current topology

Current topology shows:

- `origin/main` and `origin/release/v8.1` point at the same commit `987f485`.
- `origin/package/v8.1-full-ready` and `origin/codex/package-v8.1-full-ready` are packaging/staging branches, not durable release lines.
- `origin/feature/v8.1-runtime-storage-isolation-ready` also points at `987f485`.
- `origin/main` and `upstream/main` have no merge base in the current visible history walk, and `git rev-list --left-right --count refs/remotes/origin/main...refs/remotes/upstream/main` reports `83 334`, so this fork should be governed as its own release line rather than pretending it is a fast-follow branch of upstream.

Recommended convergence:

1. Treat `origin/main` as the source of truth for the public MIT-derived fork.
2. Stop creating new `release/v8.1` and `package/v8.1-*` branches.
3. For the next release, cut `release/1.4` or `release/1.x` from `main` only if stabilization is needed.
4. Merge or close active `feature/v8.1-*` branches into `main`, then stop using protocol-train names in branch prefixes.
5. Keep upstream tracking as audit/reference only until an explicit merge or rebase policy is defined in a later governance task.

## Tagging rules

Use Git tags for the package line only:

- Release tags: `v1.4.0`, `v1.4.1`, `v1.5.0`, and so on.
- Do not create `v8.1` Git tags for package releases.
- If an internal milestone marker is truly needed, prefer annotated non-release labels in notes or GitHub milestones rather than semver-looking Git tags.

The repository currently has `v0.1.2` through `v0.8.0`, then historical `v3.x` to `v5.2.3` tags from predecessor product lines, but no `v1.x` tags. The first public open-source release on this fork should start a clean package-tag sequence at the actual published package version.

## Archive and deletion rules

Branch archival policy:

- Archive a branch when it is historically useful but no longer an active integration lane.
- Delete a branch after it is merged or superseded when its name carries misleading version semantics.
- Before deletion, preserve needed evidence in `docs/CHANGELOG.md`, `tasks/reports/`, or GitHub release notes.

Apply that rule to current branches as follows:

- `release/v8.1`: archive or rename, then delete after `main` is declared authoritative.
- `package/v8.1-full-ready` and `codex/package-v8.1-full-ready`: delete after extracting any packaging evidence into release notes or task reports.
- `feature/v8.1-runtime-storage-isolation*`: merge/supersede into `main`, then delete.
- `feature/v8.1-multi-repository*`: merge/supersede into `main`, then delete.
- `v7-1-runtime-efficiency`: archive only if the name still has governance value; otherwise delete.

## Operating rule for future public releases

Public release communication should always state all three of these facts explicitly:

- package version: for example `1.4.0`
- controller surface: `controller-chatgpt-bridge-v8`
- compatibility note: for example `includes the V8.1 multi-repository train without changing the V8 MCP surface`

## Branch governance snapshot on 2026-06-24

Current verified topology after `git fetch --all --prune`:

- `main` is the newest local branch and matches `origin/main` at `1c83448`.
- `release/1.4` matches `origin/release/1.4` at `dbbb86b`; it currently sits one commit behind `main`.
- `upstream/main` is a separate lineage and remains audit/reference only. The current divergence is `107 ahead / 384 behind` relative to local `main`, so it should not be treated as a same-line fast-forward target.
- Local archive branches `archive/local-main-pre-convergence-20260624` and `codex/v81-current-snapshot-20260623` preserve historical evidence and should stay out of normal release flow.

Recommended active branch structure:

1. `main`: only long-lived integration branch for this fork and the default push target.
2. `release/1.x`: cut only when a public stabilization lane is needed, then fast-forward or merge back to `main` before closeout.
3. `codex/<task-slug>`: short-lived local implementation branches for direct-edit or bounded controller work.
4. `controller/<issue-task-run>`: strictly ephemeral execution branches owned by Local Bridge or task worktrees; never treat them as durable release branches.
5. `archive/<name>`: evidence-preserving branches that are intentionally excluded from normal integration policy.

Remote policy:

1. Keep `origin` as the only writable canonical remote for this fork.
2. Keep `upstream` fetch-only for comparison, cherry-pick, and governance audit.
3. Do not create new long-lived remote branches named `release/v8.1`, `package/v8.1-*`, or `controller/*`.
4. Push `codex/<task-slug>` only when review or collaboration actually needs a remote branch; otherwise keep them local and short-lived.

Current cleanup guidance:

- Safe immediate cleanup candidate: `controller/iss-20260623-dde2e7-t4-06febfda`. It is clean and fully merged into `main`.
- Hold for manual review, do not auto-delete yet:
  - `controller/iss-20260623-dde2e7-t4-273e44ac`
  - `controller/iss-20260623-dde2e7-t6-73bf8513`
  These two linked worktrees still contain uncommitted tracked and untracked changes, so automated pruning would risk losing unpublished work.

Operational rule:

- Before deleting any `controller/*` branch or linked worktree, verify three conditions: it is fully merged into `main`, the linked worktree is clean, and no active Local Bridge or Agent Run still references it.
