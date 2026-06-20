---
title: "Document Governance Phase 1 Work Plan"
kind: "plan"
created_at: "2026-06-19T10:03:17.175Z"
source: "repo-harness-mcp"
---
# Document Governance Phase 1 Work Plan

## Goal

Repair the repository's current-state documents before any archival or large-scale document cleanup.

This phase is intentionally small. It does not reorganize all plans, PRDs, Sprints, notes, reviews, or reference documents.

## Why this comes first

The current workflow surfaces are inconsistent:

- `tasks/current.md` still contains stale worktree, branch, and absolute-path information.
- `.ai/harness/handoff/current.md` and `.ai/harness/handoff/resume.md` are not in the correct freshness order.
- `.ai/harness/checks/latest.json` does not contain a meaningful latest result.
- A document cleanup based on stale state could archive or retain the wrong files.

## Scope

Only update these workflow surfaces:

- `tasks/current.md`
- `.ai/harness/handoff/current.md`
- `.ai/harness/handoff/resume.md`
- `.ai/harness/checks/latest.json`
- The Phase 1 Sprint checklist

Do not modify application source code.
Do not move or delete historical documents in this phase.
Do not merge duplicate PRDs yet.
Do not rewrite large rule documents yet.

## Work sequence

### Step 1 — Rebuild current repository truth

Refresh `tasks/current.md` from the actual repository state.

Remove stale absolute paths, old worktree owners, closed branches, and inactive plan references. Keep the file as a compact current snapshot, not a history log.

### Step 2 — Regenerate handoff in order

Regenerate `.ai/harness/handoff/current.md` from the repaired current state.

Then regenerate `.ai/harness/handoff/resume.md` after `current.md`, so the resume packet is newer than the handoff it references.

The exact next step should point only to the Phase 1 Sprint.

### Step 3 — Produce an explicit latest check result

Run the strict repo-harness workflow check and write the actual result to `.ai/harness/checks/latest.json`.

The file must clearly state pass or fail, source command, timestamp, and failure reason when applicable. It must not remain an empty placeholder.

### Step 4 — Verify and stop

Run the strict workflow check again.

If it passes, mark Phase 1 complete, stage the changed workflow files, and stop.

If it fails, record the exact remaining blocker in the Sprint and handoff, stage only coherent fixes, and stop. Do not continue into document archival.

## Completion criteria

Phase 1 is complete only when:

- `tasks/current.md` reflects the actual current repository state.
- No stale user-home path or dead worktree is presented as active truth.
- `resume.md` is newer than `handoff/current.md`.
- `latest.json` contains an explicit check result.
- The strict workflow check passes.
- No product source or historical document archive was changed.

## Next phase after completion

Create a separate small plan for document classification and indexing. That later phase will define active, reference, and archive states before any files are moved.
