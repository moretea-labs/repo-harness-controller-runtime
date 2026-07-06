---
id: "ISS-20260705-D8BE1B"
kind: "feature"
status: "planned"
updated_at: "2026-07-05T08:37:14.781Z"
source: "repo-harness-controller-v8"
---

# Add external filesystem grants

Implement explicit grants for trusted local assistant filesystem reads and import-into-workspace flows, with runtime enforcement and tests.

## Goals

- Add an ExternalPathGrant data model and authorization action.
- Require active grants when a local assistant operation references paths outside the repository.
- Preserve existing blocking behavior for non-import external mutations.
- Add a denylist for sensitive user locations and credential-like files.
- Add runtime tests for missing grant, active grant, import grant, blocked mutation, expired grant, symlink escape, and denylisted path.

## Non-goals

- None recorded.

## Acceptance Criteria

- [ ] Missing grant fails and active grant succeeds for external reads.
- [ ] Importing a granted external path into the repo succeeds.
- [ ] Non-import external mutations remain blocked.
- [ ] Expired grant, symlink escape, and sensitive-path cases are covered and blocked.
- [ ] Requested typecheck and focused runtime tests are run; commit only if all pass.

## GitHub

- Not published.

## Tasks

### T1 — Implement grant enforcement and tests

- Status: `ready`
- Objective: Update the local assistant repository operation preview and execution flow to use explicit external path grants, revalidate at execution, audit usage, and add the requested tests. Do not touch unrelated existing modified files.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

## Related Artifacts

- None.
