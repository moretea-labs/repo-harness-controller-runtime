# Local Execution Bridge and Visual Controller

## Purpose

The Local Execution Bridge keeps ChatGPT in the controller role without making every local development capability a remote MCP action.

- ChatGPT analyses the repository, manages Issues and Tasks, prepares launch decisions, and reviews results.
- The localhost-only Local Controller owns approvals and dispatches named local capabilities.
- Codex and Claude perform scoped Task Runs through the existing persistent Run/worktree system.
- GitHub remains the optional collaborative Issue, Project, Session, and pull-request surface.

This is a fallback and control boundary, not a way to bypass platform policy. When a ChatGPT write action is unavailable, the same Task can be launched or approved from the local visual controller.

## Start once

The recommended controller command starts both MCP supervision and the local visual controller:

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude --tunnel quick
```

The Local Controller is enabled by default for the `controller` profile and listens only on:

```text
http://127.0.0.1:8766/
```

It is **not** forwarded through the Cloudflare MCP tunnel. Use `--no-local-ui` to disable it, or `--open-local-ui` to open it at startup.

A standalone visual controller can also be started with:

```bash
repo-harness controller ui --repo .
```

This command is mainly for diagnostics or when MCP supervision is not running.

## Daily visual workflow

The V6 page is a direct-change-first execution workstation. Its primary surfaces are:

1. **执行中心 / Work Overview** — overall state and next actions.
2. **文件变更 / File Changes** — direct-edit sessions, changed files, persisted patch, checks, review, finalization, and rollback.
3. **当前主线 / Current Focus** — the one Issue used only for complex work.
4. **任务管理 / Task Management** — dependency-aware complex Tasks and five evidence gates.
5. **执行记录 / Run Monitor** — every Codex, Claude, or GitHub execution attempt.
6. **治理异常 / Governance** — inconsistent dependencies, stale states, and safe reconciliation.
7. **工作留痕 / Worklog** — Issue, Task, Run, edit, verification, approval, and GitHub events with export.
8. **历史归档 / Archive** — terminal complex-work history separated from current work.
9. **GitHub 插件 / GitHub Plugin** — optional explicit remote collaboration.

Known small edits use:

```text
read -> edit session -> atomic patch -> persisted diff -> named checks -> finalize
```

They do not require an Issue or Task. Complex work keeps the durable path:

```text
Issue -> Task -> Agent Run -> Integration -> Verification -> Acceptance -> Archive
```

A Run detail view separates activity, raw console, and diff. An edit detail view separately shows the exact applied patch and verification state, so “Issue created” is never presented as a file-change result.

## Local Job Tickets

High-level requests are persisted under:

```text
.ai/harness/local-jobs/<JOB-ID>/
  job.json
  events.jsonl
```

Supported actions:

- `launch-task`: dispatch an existing ready Task.
- `quick-agent-session`: create a small Issue/Task and dispatch it.
- `run-check`: execute one named check from the safe check registry.

Execution policy:

- New local Jobs execute immediately after submission.
- Risk labels determine expected evidence and verification depth; they do not create a pending approval state.
- Agent choice is supplied at execution time. When omitted, repo-harness uses the first enabled local Agent rather than binding the Task permanently to Codex.
- Explicitly destructive or irreversible work requires `approve_destructive: true` in the same request.
- Arbitrary shell input is never accepted by the MCP surface.

There is no visual approval queue, no `confirm` workflow, and no `approve_local_job` tool in V8. Existing persisted pending Jobs are compatibility records only and may be read or cancelled.

Repository-specific defaults may be stored in the ignored local file:

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 8766,
  "autoOpen": false,
  "execution": {
    "defaultMode": "direct-edit"
  }
}
```

Path:

```text
.repo-harness/local-bridge.json
```

## ChatGPT tools

The controller MCP surface includes direct-change tools plus the V5 complex-work execution-closure model:

- `assess_work_request`, `begin_edit_session`, `apply_patch`, `list_edit_sessions`, `get_edit_session_diff`, `verify_edit_session`, `finalize_edit_session`, `rollback_edit_session`;
- `local_bridge_status`, `submit_local_job`, `list_local_jobs`, `get_local_job`;
- `get_project_progress`, `get_task_progress_detail`, `get_worklog_timeline`, `export_worklog`;
- `get_github_plugin_status`, `configure_github_plugin`.

`controller_capabilities` reports:

```text
controller-chatgpt-bridge-v8
```

When ChatGPT can call the action, `submit_local_job` creates the same persistent Job used by the visual UI. When a platform policy blocks the action, open the local controller and launch the existing Task from its card or use Quick Agent Session.

## V6 worklog, edit evidence, and archiving

The append-only local ledger lives at `.ai/harness/controller/worklog.jsonl`. The directory is ignored by Git so routine activity does not dirty the working tree. Export selected history to `tasks/reports/` when it should become durable review evidence.

The browser uses token-protected SSE. It emits a refresh only when the controller state signature changes and emits an idle heartbeat otherwise; a slower timer remains as a fallback.

## Security model

The visual controller:

- binds only to `127.0.0.1`, `localhost`, or `::1`;
- rejects non-loopback bind addresses;
- is not exposed through the MCP tunnel;
- protects every `/api` call with a per-process random token embedded only in the locally served page;
- does not enable CORS;
- accepts structured actions rather than arbitrary shell commands;
- reuses Task scope, worktree isolation, Run logs, and the Verification Gate.

Manual-only local approval does not weaken the immutable deny rules for credentials, secrets, system directories, automatic push, or automatic merge.

## Codex and Claude sessions

Launching from the visual controller starts the same persistent local Agent Run used by `dispatch_task`:

- the Task prompt is generated from Issue intent and Task scope;
- execution placement defaults to `auto`: direct current-workspace execution when only one local Run exists, worktree isolation when concurrent work is detected;
- Codex JSON events and generic Agent output are parsed into structured phases and human-readable current activity while stdout/stderr remain available;
- the page displays live activity, output, heartbeat, elapsed/remaining time, diff, and execution mode;
- a successful isolated Run is automatically integrated into the current workspace, then its temporary worktree and branch are removed; integration conflicts preserve the worktree and surface a manual action;
- direct-workspace changes need no integration step;
- completion/integration moves the Task toward review, while verification remains a separate mandatory gate before done.

This version uses the installed Codex/Claude CLI worker. A future adapter may use Codex App Server for richer mid-run steering while retaining the same Job and Run records.

## Recovery and diagnostics

Call:

```text
local_bridge_status
```

or inspect:

```text
.repo-harness/mcp.runtime.json
```

The runtime state contains the local controller endpoint and startup error, when any. The CLI remains available for recovery:

```bash
repo-harness controller board --repo .
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log
repo-harness controller ui --repo .
```

These commands are not required for normal daily execution through ChatGPT or the visual controller.

## Timeout policy and retry

Local Codex/Claude Runs default to 60 minutes. The supported range is 5 seconds to 12 hours. The selected value is stored in `meta.json`, `worker-config.json`, and exposed as `timeoutMs` plus `deadlineAt`; a heartbeat event is written while the process remains alive.

The visual controller shows elapsed time, approximate remaining time, the configured limit, live logs, and Run events. Failed, cancelled, or orphaned Runs can be retried from the page. Retry creates a new Run and keeps the previous evidence instead of mutating history.

Values outside the configured range are rejected. They are never silently replaced by the default. Existing local configs that still contain the former 120-second default are migrated to 60 minutes when `repo-harness mcp setup chatgpt --repo .` is rerun.

## Connector diagnostics

The page displays the MCP runtime profile, tool-surface fingerprint, tool count, tunnel reconnect state, and whether the active service matches `controller-chatgpt-bridge-v8`. A warning means the local execution bridge can still be used, but ChatGPT may be holding an obsolete Planner tool snapshot.

Use the versioned default Connector name `repo-harness-controller-v7`, restart keepalive from the updated installation, and recreate or rescan the ChatGPT Connector when the warning persists. Ordinary repository source is readable in the `controller` profile; credentials, secrets, Git internals, runtime security files, lockfiles, and CI workflows remain denied.
