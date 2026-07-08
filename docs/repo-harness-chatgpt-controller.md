# ChatGPT Controller Workflow

> **Historical Design — Not Runtime Authority**
>
> This document records an earlier ChatGPT Controller workflow and remains available for migration history and audit. It may describe behavior that is still implemented, superseded, or not yet migrated.
>
> Current Controller Runtime architecture: [docs/architecture/current/README.md](architecture/current/README.md).

## Purpose

The `controller` profile makes ChatGPT the coordinator of repository-backed engineering work. It can inspect the current implementation, manage product and implementation documents, create Issues, split work into dependency-aware Tasks, dispatch short local Agent Runs or visible GitHub Copilot cloud sessions, review evidence, and decide whether to accept, retry, block, split, or re-plan work.

ChatGPT is not the durable state store. Issues, Tasks, Runs, edit sessions, checks, diffs, and handoffs remain recoverable from repository files and ignored local runtime artifacts.

## State model

```text
Issue
  -> Task T1
       -> Run 1
       -> Run 2 (retry)
  -> Task T2 (depends on T1)
  -> Task T3
```

## Recovery projection

`controller_context` now includes a `taskLedger` projection derived from the durable Issue, Task, Run, and worklog state. The projection is intentionally compact: it identifies the current Issue, attention Tasks, ready/queueable work, recent evidence, a single `taskLedgerStatus` continuation state, and suggested next actions without replaying the whole repository or returning raw logs.

`prepare_handoff_artifacts` also writes:

- `.ai/harness/controller/task-ledger.json` — machine-readable recovery/status projection.
- `.ai/harness/handoff/controller-current.md` — human-readable handoff optimized for a fresh ChatGPT controller session.

This projection is a recovery and planning aid only. Implementation decisions must still expand the exact source snippets, related types/callers, current diff, and focused verification output at the decision point. `controller_ready`, `controller_context`, and `work_status_digest` expose the same compact continuation state so a fresh controller can tell whether the next step is review, retry, blocker resolution, active-run monitoring, dispatch, closeout, or new-Issue creation before asking for raw code.

`controller_context` also exposes `operationalPlan`, a compact `controller-operational-plan` projection that ties together task recovery, diff review, validation recipes, worker routing, GUI action vocabulary, MCP schema rules, controllerHome storage policy, and safe branch/worktree cleanup policy. It is an execution guide, not durable authority.

`controller_context_pack` is the first bounded code-context read model for implementation planning. It accepts task focus, known paths, search terms, and include/exclude globs, then returns the selected checkout's live Git metadata (`branch`, `status`, `diffStat`, `dirty`), structured validation hints (`policy`, `checks`), and policy-readable candidate files with line-bounded raw snippets around explicit paths and search hits. The pack is deliberately conservative: it helps ChatGPT avoid scanning the whole repository, but it does not certify relevance or correctness. Before editing, the controller must still expand exact ranges for target files and review the post-change diff plus focused validation output.

Issue and Task definitions are written under `tasks/issues/` in both JSON and readable Markdown. Runtime agent evidence is written under `.ai/harness/jobs/`. Direct-edit evidence and backups are written under `.ai/harness/edit-sessions/`.

Task statuses include:

```text
backlog -> analysis -> planned -> ready -> running -> review
                                               -> integrated -> verifying -> verified -> done
review/integrated/verifying/verified -> changes_requested -> running
running -> blocked | cancelled
```

A Run does not close its Task. Successful execution moves the Task to `review`; the controller must inspect the result, record check and acceptance evidence through the Verification Gate, and explicitly accept it.

## Capability model

### Observe

- `project_snapshot`
- `search_repository`
- `read_repository_file`
- `get_git_diff`
- `list_issues`, `get_issue`, `get_project_board`
- `list_task_runs`, `get_task_run`, `get_task_run_events`, `get_task_run_log`, `get_task_diff`

Repository search and reads are bounded and policy-aware. Secret, credential, Git-internal, generated, and explicitly denied paths remain unavailable.

### Manage

- `create_issue`, `update_issue`
- `plan_issue`, `append_task`, `split_task`, `supersede_task`, `set_task_dependencies`
- `inspect_issue_readiness`, `prepare_issue_launch`
- `publish_issue_to_github`, `refresh_github_issue`, `close_github_issue`
- `update_task`, `verify_task`, `accept_task`, `request_task_changes`
- existing PRD, Sprint, Plan, handoff, and reviewable workflow artifacts

Small fixes do not require a full PRD/Sprint. Large product work can keep those higher-level artifacts and create one or more implementation Issues beneath them.

### Edit

- `begin_edit_session`
- `apply_patch`
- `create_edit_savepoint`
- `get_edit_session`, `get_edit_session_diff`
- `verify_edit_session`
- `rollback_edit_session`
- `finalize_edit_session`

Direct Edit is the default execution path when ChatGPT already understands the required implementation. A session is a long-lived transaction: multiple small patch batches may be appended to the same session, every batch creates a revision, savepoints can be named, and rollback can target a revision or savepoint. This keeps each MCP call bounded while still producing one aggregate localized diff.

SHA-256 preconditions, allowed paths, cumulative file/line budgets, backups, and named checks remain available as integrity controls. They are not human approval gates. Finalization closes the transaction after the configured checks have passed, or immediately when no check is configured.

### Local execution bridge

- `local_bridge_status`
- `submit_local_job`
- `list_local_jobs`, `get_local_job`

The localhost-only Controller runs alongside MCP keepalive for the `controller` profile. It provides a hierarchical Issue -> Task -> Execution workspace, runtime Agent selection, Direct Edit revisions/savepoints, live Run logs, and named checks at `http://127.0.0.1:8766/`. It is not exposed through the MCP tunnel.

V8 has no ordinary local approval queue and no `approve_local_job` action. Medium/high risk classifications are metadata for verification depth, not permission gates. An explicitly destructive or irreversible operation must carry `approve_destructive: true` in the same request; it is never parked for later human approval.

Local Job records remain persisted under `.ai/harness/local-jobs/` for audit and status inspection. Legacy pending records can be read or cancelled, but must be resubmitted under the V8 execution model.

### Execute

- `launch_issue`
- `dispatch_task`
- `dispatch_ready_tasks`
- `cancel_task_run`
- `retry_task_run`
- `integrate_task_run`

Local Codex/Claude execution is opt-in through `--enable-dev-runner` and restricted to configured agents. Each Task receives a generated scope contract, acceptance criteria, checks, and execution rules. The default local isolated mode creates a dedicated Git worktree and branch.

A Task assigned to `github-copilot` starts a GitHub Copilot coding-agent cloud session through authenticated GitHub CLI. The Run records its GitHub session and draft pull-request links, and progress can be inspected through GitHub's Agents experience, `get_task_run_events`, `get_task_run_log`, or `repo-harness controller watch`.

`dispatch_ready_tasks` conservatively skips Tasks whose allowed path scopes overlap. Tasks without explicit allowed paths are treated as potentially conflicting and are not parallelized with another selected Task.

A successful isolated Run remains in its worktree until ChatGPT reviews `get_task_diff` and calls `integrate_task_run`. Integration copies the reviewed textual create/write/delete changes into the main worktree through a rollback-capable edit session, rejects stale base revisions and unsupported binary or rename changes, and records the integration session on the Run. `accept_task` rejects an isolated Run that has not been integrated.

### Verify

- `list_checks`
- `run_check`
- `verify_task`
- `run_workflow_check`

`run_check` accepts a check ID, not a shell command. It discovers safe package scripts with prefixes such as `test`, `check`, `lint`, and `typecheck`. Additional checks can be configured as fixed command arrays:

```json
{
  "version": 1,
  "checks": {
    "ios-domain-tests": {
      "description": "Focused medication domain tests",
      "command": ["xcodebuild", "test", "-scheme", "App", "-only-testing:AppTests/MedicationTests"],
      "cwd": ".",
      "timeoutMs": 900000
    }
  }
}
```

## GitHub Issue Launcher

GitHub Issues and Projects can be used as the collaborative task surface while local controller files remain the durable execution source. The controller can explicitly publish a parent Issue, mirror Tasks as sub-issues, add them to a Project, and launch selected Tasks as GitHub Copilot cloud sessions. See [GitHub Issue Launcher and Copilot Cloud Sessions](repo-harness-github-issue-launcher.md).

Local and cloud Runs are visible from the terminal:

```bash
repo-harness controller board --repo .
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log

The `--log` view streams local Codex/Claude output while the process is running and polls GitHub cloud-session logs when available.
```

## Setup

```bash
repo-harness adopt --repo .
repo-harness mcp setup chatgpt --repo .
repo-harness mcp setup codex --repo . --scope project
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude --tunnel quick
```

For routine use, replace the quick tunnel with a stable named tunnel. Keep the MCP HTTP server bound to loopback and expose it only through authenticated HTTPS.

## Daily operating patterns

### Analyze without executing

```text
Read project_snapshot, active Issues, and the relevant implementation. Analyze the request, create or update an Issue, and split it into small dependency-aware Tasks. Do not execute yet.
```

### Execute incrementally

```text
Inspect launch readiness for ISS-..., publish it to the repository GitHub Project when collaboration is useful, then launch at most two path-independent Tasks. Read every completed Run, inspect its local diff or GitHub pull request, record verification evidence, and accept or request changes before continuing.
```

### Recover in a new chat

```text
Use repo-harness as controller. Read project_snapshot, get_project_board, and active Runs. Continue from repository state without relying on the previous conversation.
```

### Apply a small direct fix

```text
Open a bounded edit session for this defect, restricted to the named files. Read current hashes, apply the smallest replacement, inspect the diff, run the focused check, then finalize or rollback.
```

## Task sizing rules

A Task should have one objective, a narrow path scope, observable acceptance criteria, and focused verification. Split a Task when it spans unrelated modules, requires independent product decisions, has multiple risky migrations, or cannot be reviewed from one coherent diff.

A Run is an execution attempt, not a project phase. Retrying a failed Run preserves prior evidence and creates another attempt for the same Task.

## Compatibility

The existing planner/executor/orchestrator profiles remain available. PRD -> checklist Sprint -> Codex Goal and `run_agent_goal` remain supported for repositories already using that workflow. New controller work should prefer Issue -> Task -> Run because it supports incremental execution, recovery across chats, targeted retries, and explicit review.

## Safety and authority

- No arbitrary shell tool is exposed through MCP.
- Repository-local policy may narrow access but cannot remove immutable hard denies.
- Local Agent workers do not commit, merge, push, publish, or delete their worktrees. GitHub cloud sessions may create draft pull requests when explicitly requested, but repo-harness never merges them automatically.
- ChatGPT must review completed Runs; worker self-reports are not acceptance evidence. Isolated local Runs must be integrated before acceptance, and every Task must pass `verify_task`.
- Local build, test, deploy, and release systems remain authoritative.
- Human approval remains required for destructive, externally visible, or high-risk changes.
