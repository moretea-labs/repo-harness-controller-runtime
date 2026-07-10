# Tutorial 3: Complete the First Repository Task

Use a small documentation or configuration change for the first run. The goal is to verify routing, bounded editing, review evidence, and cleanup before delegating complex code.

## 1. Start read-only

Ask ChatGPT:

```text
Use repo-harness. Check rh_status, then load rh_context for my selected repository. Summarize the current branch, working-tree state, relevant files, and available named checks. Do not modify anything yet.
```

Resolve a dirty tree or ambiguous repository selection before writing.

## 2. Give a bounded task

Example:

```text
Update the installation note in docs/example.md. Keep the change limited to that file, show the diff, and run the most relevant named documentation check. Do not push or publish anything.
```

Good first tasks name the desired outcome, allowed area, verification, and remote-write boundary.

## 3. Understand the execution mode

repo-harness should prefer Direct Edit for a small known change. A Direct Edit records file fingerprints, revisions, a persisted diff, and check evidence. Larger or dependency-aware work may be promoted to a durable Issue/Task/Run. Coding agents remain optional workers, not the default controller.

## 4. Review before acceptance

Check:

- only intended files changed;
- the diff matches the request;
- the named check actually ran and passed;
- no credentials, logs, runtime state, or personal paths were added;
- no remote action occurred without authorization.

Request corrections through `rh_work` when needed. Use `rh_inbox` for explicit decisions or approvals.

## 5. Commit and remote actions

A local commit may be part of an authorized repository workflow, but pushing, opening a pull request, editing GitHub state, tagging, or publishing are separate external actions. State the desired boundary explicitly, for example “commit locally but do not push.”

## 6. Confirm cleanup and resumability

At the end, ask for:

- final Git status;
- changed files and checks;
- commit hash when a commit was requested;
- any remaining worktree, branch, Job, or attention item;
- the next safe action.

A completed local task should leave either a clean working tree or clearly identified unrelated concurrent changes. Runtime logs and evidence remain in ignored Controller storage.

Read [Features and Setup Levels](../operations/features.md) before enabling agents, GitHub, browser, schedules, or Workspace plugins.
