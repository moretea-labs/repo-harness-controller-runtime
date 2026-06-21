# repo-harness V5 Execution and Closure

V5 changes the Controller from a progress observer into a bounded execution-and-closeout system. Local Issue, Task, Run, Verification, and worklog files remain authoritative. GitHub remains optional.

## Problem addressed

V4 could show a large amount of durable history, but current work and historical attempts were easy to mix together:

- every investigation could become another active Issue;
- cancelled or superseded dependencies could leave downstream Tasks permanently planned;
- a failed Run could make a Task look permanently blocked;
- Task lifecycle state, latest Run state, and an estimated percentage could contradict each other;
- the UI exposed monitoring better than execution and closeout;
- completed work stayed mixed with the current queue.

V5 establishes one explicit current execution line and requires evidence before closure.

## Source of truth

Controller Issues continue to live under:

```text
tasks/issues/*.issue.json
tasks/issues/*.issue.md
```

Runtime attempts and worklog evidence live under:

```text
.ai/harness/jobs/
.ai/harness/controller/worklog.jsonl
.ai/harness/controller/project-state.json
```

The runtime directories are local operational state. Export selected evidence to `tasks/reports/` when it should enter Git history.

## Current execution focus

`.ai/harness/controller/project-state.json` records:

- `currentIssueId`: the one Issue that drives the execution queue;
- `issueCreationMode`: `open`, `focus_only`, or `paused`;
- `showArchivedByDefault`.

The default mode is `focus_only`.

When a current Issue is active, ordinary `create_issue` calls are rejected. The correct default is to append, split, retry, review, or close existing Tasks. A separate Issue requires an explicit override, which is recorded in the worklog. Exact duplicate active titles are rejected unless explicitly allowed.

The first active Issue created in a repository becomes the current Issue automatically. Archiving the current Issue clears the focus.

## Run failure is not Task cancellation

A Run is an execution attempt. A Task is durable intended work.

V5 applies these rules:

- failed, unknown, or cancelled Runs remain in Run history;
- the Task returns to `ready` for another attempt unless a real dependency or human decision blocks it;
- `blocked` and `launch_blocked` are reserved for actionable blockers, not generic agent failure;
- retry creates a new Run and never overwrites the prior attempt;
- cancelling an active Run does not cancel the Task;
- cancelling a Task is a separate explicit action.

## Governance diagnostics

`get_project_governance`, the CLI `controller governance`, and the local UI identify:

- no current Issue while multiple active Issues exist;
- a terminal or archived current Issue;
- multiple active Issues competing for attention;
- duplicate active Issue titles;
- cancelled dependencies;
- downstream Tasks that still depend on superseded Tasks instead of replacements;
- old failed Runs that permanently blocked a Task;
- review and acceptance backlog;
- all Tasks complete while the Issue remains open;
- terminal Issues that have not been archived;
- active Issues with no launch, retry, review, verification, acceptance, or dependency-repair action.

`reconcile_project_governance` and `controller reconcile` apply only safe repairs:

- replace superseded dependencies with declared replacement Task IDs;
- return failed-attempt Tasks to `ready`;
- close an Issue when all non-cancelled, non-superseded Tasks are done;
- clear a terminal or archived execution focus;
- select the only remaining active Issue as the current focus.

Ambiguous changes such as repairing a cancelled dependency or merging duplicate Issues always require an explicit decision.

## Evidence-gate progress

V5 does not present lifecycle labels as implementation percentages. Each Task exposes five gates:

1. **Implementation Run** — a linked Run succeeded.
2. **Change Integration** — current-workspace execution needed no merge, or isolated work was integrated; GitHub work has a visible PR path.
3. **Named Checks** — all recorded named checks passed.
4. **Acceptance Criteria** — every Task criterion has explicit positive evidence.
5. **Human Acceptance** — a verified Task was explicitly accepted and closed.

The Controller may display `3/5 gates complete`; this is a count of evidence, not a guess that code is “60% written.” Cancelled and superseded Tasks do not inflate active progress.

## Direct local workflow

The local Controller at `http://127.0.0.1:8766/` provides:

- **执行中心** — current focus, next actions, and “execute ready”;
- **当前主线** — choose the one current Issue;
- **任务管理** — launch, retry, inspect, verify, accept, request changes, cancel, and repair dependencies;
- **执行记录** — every local or GitHub Run attempt;
- **治理异常** — detected state inconsistencies and safe reconciliation;
- **工作留痕** — the unified timeline and export;
- **历史归档** — terminal Issues separated from current work;
- **GitHub 插件** — optional explicit synchronization.

The direct Task path is:

```text
ready
  -> launch
  -> Run succeeded
  -> review
  -> run named checks + explicit acceptance-criteria confirmation
  -> verified
  -> explicit accept
  -> done
  -> archive Issue when terminal
```

“Run verification” executes only checks declared in the Task and available through `.repo-harness/checks.json` or safe package scripts. The UI requires explicit human confirmation of the acceptance criteria and records that confirmation as evidence. It does not invent check results.

## Execution scope

`dispatch_ready_tasks` no longer walks every Issue by default. It uses:

1. an explicitly supplied Issue ID;
2. otherwise `currentIssueId`;
3. otherwise the only active Issue;
4. otherwise it fails with `CURRENT_ISSUE_REQUIRED`.

Launching an explicit Issue or Task selects that Issue as the current focus.

## Archiving

Only `done` or `cancelled` Issues can be archived. Archiving:

- sets `archivedAt`;
- removes the Issue from current progress and execution queues;
- retains all Tasks, Runs, verification evidence, GitHub links, and worklog events;
- clears the current focus when necessary.

Restoring an Issue removes `archivedAt`; a terminal restored Issue does not become current automatically.

## MCP V5 surface

The V5 fingerprint is:

```text
controller-execution-closure-v5
```

New or expanded tools include:

```text
get_project_progress
get_project_governance
reconcile_project_governance
get_project_state
set_current_issue
get_task_progress_detail
get_worklog_timeline
export_worklog
archive_issue
restore_issue
```

Existing execution tools remain available, but project-wide dispatch is current-Issue scoped.

The default ChatGPT Connector name is:

```text
repo-harness-controller-v5
```

Recreate or rescan the Connector if `controller_capabilities` reports an older fingerprint.

## GitHub plugin boundary

GitHub integration can mirror a parent Issue, Task sub-Issues, a Project, PRs, CI, and cloud-agent sessions. It is not the local scheduler and does not replace local state consistency.

Synchronization remains explicit. A GitHub outage never changes the local Task truth or blocks local closeout evidence.

## Migration from V4

After installing V5:

1. Start the Controller and open **治理异常**.
2. Run safe reconciliation.
3. Choose one current Issue.
4. Repair cancelled dependencies manually.
5. Retry failed attempts rather than creating replacement Issues.
6. Process review Tasks through Verification Gate.
7. Accept verified Tasks.
8. Close and archive terminal Issues.
9. Keep Issue creation in `focus_only` until the backlog is clean.

This migration intentionally does not delete historical Issues or Runs. It separates history from current execution and makes unresolved ambiguity visible.
