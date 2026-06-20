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

The page provides four primary surfaces:

1. **Quick Agent Session** — create a small durable Issue/Task and launch Codex or Claude without preparing a script or goal file.
2. **Approval Queue** — review confirmation-required or manual-only local Jobs.
3. **Issue/Task Board** — launch ready Tasks directly from their cards.
4. **Runs and Checks** — inspect live logs and execute named repository checks.

A Quick Agent Session still uses the normal durable model:

```text
Issue -> Task -> Local Job -> Agent Run -> Review -> Verification -> Done
```

It is not an untracked terminal process.

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

Approval levels:

- `auto`: execute immediately under local policy.
- `confirm`: wait in the visual approval queue.
- `manual-only`: cannot be approved through MCP; it must be approved from the localhost visual controller.

Default policy is intentionally conservative:

- isolated low/medium-risk local Tasks with an explicit allowed-path scope may auto-dispatch;
- high-risk, unscoped, or non-isolated Tasks require confirmation;
- named checks may auto-run;
- arbitrary shell input is never accepted.

Repository-specific defaults may be stored in the ignored local file:

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 8766,
  "autoOpen": false,
  "approvals": {
    "launch-task": "confirm",
    "quick-agent-session": "confirm",
    "run-check": "auto"
  }
}
```

Path:

```text
.repo-harness/local-bridge.json
```

## ChatGPT tools

The controller MCP surface adds:

- `local_bridge_status`
- `submit_local_job`
- `list_local_jobs`
- `get_local_job`
- `approve_local_job`

`controller_capabilities` reports:

```text
controller-local-execution-v2
```

When ChatGPT can call the action, `submit_local_job` creates the same persistent Job used by the visual UI. When a platform policy blocks the action, open the local controller and launch the existing Task from its card or use Quick Agent Session.

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
- a Git worktree is created when isolation is enabled;
- stdout and stderr stream into Run logs;
- the page polls and displays live output;
- completion moves the Task to review, not done;
- integration and verification are still separate controller decisions.

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

The page displays the MCP runtime profile, tool-surface fingerprint, tool count, tunnel reconnect state, and whether the active service matches `controller-local-execution-v2`. A warning means the local execution bridge can still be used, but ChatGPT may be holding an obsolete Planner tool snapshot.

Use the versioned default Connector name `repo-harness-controller-v2`, restart keepalive from the updated installation, and recreate or rescan the ChatGPT Connector when the warning persists. Ordinary repository source is readable in the `controller` profile; credentials, secrets, Git internals, runtime security files, lockfiles, and CI workflows remain denied.

