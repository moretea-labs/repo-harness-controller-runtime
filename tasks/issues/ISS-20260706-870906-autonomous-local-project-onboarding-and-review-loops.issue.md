---
id: "ISS-20260706-870906"
kind: "feature"
status: "planned"
updated_at: "2026-07-06T14:29:31.602Z"
source: "repo-harness-controller-v8"
---

# Autonomous local project onboarding and review loops

Make repo-harness act more like an autonomous personal engineering assistant: safely onboard local project directories, select latest sibling source trees, run daemon-owned review loops, stage iOS review status, and prepare backup model handoff without requiring repeated human confirmation.

## Goals

- Add latest-source diagnosis for stale registrations and richer sibling source directories.
- Add structured local project bootstrap for trusted non-Git project directories.
- Support non-destructive replacement/superseding of stale repo registrations.
- Make schedule execution more daemon-owned and observable.
- Stage iOS smoke review into independently reported steps.
- Prepare backup model handoff packets for blocked paths.
- Document the autonomous assistant philosophy and default operating policy.

## Non-goals

- Bypass platform safety checks.
- Push to remotes automatically.
- Delete user directories.
- Call external models without local configuration and explicit authorization.

## Acceptance Criteria

- [ ] PulseMetronomeApp-style local project directories can be bootstrapped and registered through a structured action.
- [ ] TinyMoments 1.7-style richer sibling source can supersede a stale registered path without destructive deletion.
- [ ] Active loop execution status is observable and does not require ChatGPT to manually trigger every occurrence.
- [ ] iOS review stages are reported separately with artifacts where available.
- [ ] Backup model fallback is prepare-only unless locally configured and authorized.
- [ ] Repo philosophy document states autonomous-first, policy-bound, low-interruption behavior.

## GitHub

- Not published.

## Tasks

### T1 — Document autonomous assistant policy

- Status: `ready`
- Objective: Add a durable product/engineering note defining repo-harness as an autonomous, policy-bound, self-improving personal assistant that reduces human interruption and tries safe repairs before escalating.
- Depends on: none
- Allowed paths: `docs/**`, `plans/**`, `.ai/harness/handoff/**`
- Checks: `npm run check:type`
- Execution hint: agent / codex

### T2 — Implement local source diagnosis

- Status: `ready`
- Objective: Add read-only diagnosis for stale registered paths and latest sibling source selection, with tests based on TinyMoments and TinyMoments 1.7 style fixtures.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T3 — Implement local project bootstrap

- Status: `ready`
- Objective: Add structured action for safe non-Git local project bootstrap and repository registration with sensitive path denial and audit evidence.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T4 — Harden loop and iOS review status

- Status: `ready`
- Objective: Improve daemon-owned active schedule observability and staged iOS review status; wire prepare-only backup model fallback for blocked stages.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

## Related Artifacts

- None.
