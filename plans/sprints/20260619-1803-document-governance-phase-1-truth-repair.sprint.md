---
title: "Document Governance Phase 1 — Truth Repair"
kind: "sprint"
created_at: "2026-06-19T10:03:29.975Z"
source: "repo-harness-mcp"
---
# Document Governance Phase 1 — Truth Repair

> **Status**: Draft

## Source

- PRD: `plans/prds/20260619-1729-repo-harness-document-governance.prd.md`

## Execution Rule

- Execute task cards in order.
- Keep each task card reviewable as one staged slice.
- After every completed phase, update the checklist and stage the result before continuing.
- Do not treat unstaged work as a completed phase.

## Checklist

### Task Card 1: Refresh current-state snapshot

- [ ] Objective: Rebuild tasks/current.md from actual repository state and remove stale paths, branches, worktrees, and inactive plan references.
- [ ] Files/entrypoints: `tasks/current.md`
- [ ] Verification: `Current focus and active work match the real repository state.`, `No obsolete absolute path is presented as active truth.`, `The file remains a compact snapshot rather than a historical log.`
- [ ] Stage gate: Stage tasks/current.md before continuing.

### Task Card 2: Regenerate handoff and resume in order

- [ ] Objective: Regenerate the current handoff from the repaired snapshot, then regenerate the resume packet so its timestamp is newer than handoff/current.md.
- [ ] Files/entrypoints: `.ai/harness/handoff/current.md`, `.ai/harness/handoff/resume.md`
- [ ] Verification: `The exact next step points only to this Phase 1 Sprint.`, `resume.md is newer than current.md.`, `No stale branch or worktree is named as active.`
- [ ] Stage gate: Stage the handoff pair before continuing.

### Task Card 3: Write an explicit latest check result

- [ ] Objective: Run the strict workflow check and replace the empty latest check placeholder with a meaningful pass or fail result.
- [ ] Files/entrypoints: `.ai/harness/checks/latest.json`
- [ ] Verification: `The result contains status, timestamp, command or source, and exit code.`, `A failure includes the exact blocker.`, `The file is not an empty object or placeholder.`
- [ ] Stage gate: Stage latest.json before the final verification.

### Task Card 4: Verify Phase 1 and stop

- [ ] Objective: Run the strict workflow check again, update this Sprint checklist and handoff with the outcome, then stop without entering archival work.
- [ ] Files/entrypoints: `plans/sprints/document-governance-phase-1-truth-repair.sprint.md`, `.ai/harness/handoff/current.md`, `.ai/harness/handoff/resume.md`
- [ ] Verification: `Strict workflow check passes, or the remaining blocker is recorded precisely.`, `No product source file was modified.`, `No historical plan, PRD, Sprint, note, or review was moved or deleted.`
- [ ] Stage gate: Stage the coherent Phase 1 result and stop. Do not start Phase 2 in the same execution.

## Final Acceptance

- [ ] All task cards are checked.
- [ ] Required checks pass.
- [ ] Handoff explains staged state, residual risks, and next bottleneck if any.
