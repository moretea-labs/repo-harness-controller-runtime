# repo-harness V4 Progress Ledger

V4 adds a project-level progress and evidence layer on top of the existing Controller. It does not replace the Issue/Task/Run model or make GitHub authoritative.

## State model

The Controller derives a Task's `effectiveStatus` from its durable Task status and latest associated Run. A Task can therefore remain visibly `running`, `needs_attention`, or `run_failed` even when an older persisted label has not yet been reconciled.

Project progress includes:

- overall and per-Issue completion percentage;
- active and completed Task counts;
- current Task activity and latest Run;
- dependency blockers, failed Runs, stale heartbeats, and requested changes;
- 24-hour and 7-day throughput plus average completed Task cycle time;
- Verification state and linked GitHub URLs.

The derived view is available through:

```bash
repo-harness controller progress --json
repo-harness controller timeline --json
repo-harness controller timeline --issue ISS-... --task T1 --json
```

Equivalent MCP tools are `get_project_progress`, `get_task_progress_detail`, and `get_worklog_timeline`.

## Worklog and evidence

The raw append-only ledger is stored at:

```text
.ai/harness/controller/worklog.jsonl
```

It records controller mutations, Run lifecycle events, local Job approvals, Verification evidence, and GitHub synchronization actions. This raw runtime directory is ignored by Git to prevent constant dirty working trees and merge conflicts.

Export a reviewable report when the history should become a tracked artifact:

```bash
repo-harness controller export-worklog --format markdown
repo-harness controller export-worklog --issue ISS-... --output tasks/reports/issue-worklog.md
repo-harness controller export-worklog --format json --output tasks/reports/controller-worklog.json
```

Export paths are restricted to the repository. Parent-directory traversal and absolute output paths are rejected.

## Local control center

Start the localhost-only UI through the existing Controller/keepalive flow or directly with the local bridge command. The V4 UI contains:

- Work Overview;
- Progress Center;
- Task Management and Task detail timeline;
- Run Monitor with live output and diff;
- Worklog filters and export;
- Local approval queue;
- named checks;
- optional GitHub plugin configuration and Issue synchronization.

The UI uses token-protected SSE. It emits full refresh events only when Issue, Task, Run, Job, or worklog state changes; an idle heartbeat keeps the connection observable, with a slower browser polling fallback.

## Optional GitHub plugin

GitHub support is repository-scoped. Newly registered GitHub-backed repositories enable it by default; other repositories can configure it with:

```bash
repo-harness controller github configure \
  --enable \
  --github-repo owner/repository \
  --sync-mode manual \
  --include-tasks

repo-harness controller github status --json
repo-harness controller github publish ISS-...
repo-harness controller github refresh ISS-...
```

`checkpoint` is also accepted as a sync policy label, but synchronization remains an explicit operation. V4 intentionally avoids hidden background writes to GitHub.

The plugin can publish a parent Issue, mirror Tasks as sub-Issues, and add them to a GitHub Project when `projectOwner` and `projectNumber` are configured. Authentication remains owned by the local `gh` CLI. No token is stored in the plugin config.

Local files remain authoritative:

- Controller Issue/Task state: `tasks/issues/`;
- Run evidence: `.ai/harness/jobs/`;
- local worklog: `.ai/harness/controller/`;
- tracked exported reports: `tasks/reports/`;
- repository registry GitHub config, with legacy `.repo-harness/plugins/github.json` compatibility.

## MCP V4 surface

The `controller-progress-ledger-v4` tool surface adds:

- `get_project_progress`;
- `get_task_progress_detail`;
- `get_worklog_timeline`;
- `export_worklog`;
- `get_github_plugin_status`;
- `configure_github_plugin`.

After upgrading, recreate or rescan the ChatGPT Connector as `repo-harness-controller-v4` when `controller_capabilities` reports an older fingerprint.
