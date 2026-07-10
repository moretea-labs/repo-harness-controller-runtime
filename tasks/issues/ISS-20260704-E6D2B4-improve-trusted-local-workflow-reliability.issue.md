---
id: "ISS-20260704-E6D2B4"
kind: "feature"
status: "cancelled"
updated_at: "2026-07-10T13:39:52.824Z"
archived_at: "2026-07-10T13:39:52.824Z"
source: "repo-harness-controller-v8"
---

# Improve trusted local workflow reliability

Add structured controller actions for safer local edit, verify, commit, handoff, and campaign state handling.

## Goals

- Add chunked direct-edit patch application with fresh file fingerprints and actionable failure reports.
- Add selected-path Git helper actions for diff, stage, commit, and commit SHA reporting.
- Add handoff artifact output when final repository updates cannot complete.
- Improve edit-session lineage and verification metadata.
- Harden campaign no-change and cleanup transitions.

## Non-goals

- None recorded.

## Acceptance Criteria

- [ ] Selected-path commits do not include unrelated dirty files.
- [ ] Patch failures are recoverable and explain what failed.
- [ ] Blocked finalization produces a handoff artifact.
- [ ] Edit sessions and campaign summaries show changes, checks, and blockers.

## GitHub

- Not published.

## Tasks

### T1 — Inspect current workflow code

- Status: `blocked`
- Objective: Find source files and tests for direct-edit, Git, handoff, and campaign transitions.
- Depends on: none
- Allowed paths: not defined
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T2 — Improve direct-edit patch handling

- Status: `integrated`
- Objective: Implement smaller patch batches, fingerprint refresh, safe partial failure reporting, and revision consistency.
- Depends on: none
- Allowed paths: not defined
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T3 — Add selected-path Git and handoff actions

- Status: `blocked`
- Objective: Implement structured diff/stage/commit helpers and fallback handoff artifacts.
- Depends on: none
- Allowed paths: not defined
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T4 — Harden campaign no-change transitions

- Status: `ready`
- Objective: Ensure no-change runs and blocked edits are marked clearly and cleaned up.
- Depends on: none
- Allowed paths: not defined
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T5 — Verify and package result

- Status: `ready`
- Objective: Run focused checks and produce either a commit or a handoff summary.
- Depends on: none
- Allowed paths: not defined
- Checks: `package:check:type`
- Execution hint: selected at runtime

## Related Artifacts

- None.
