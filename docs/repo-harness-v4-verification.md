# repo-harness V4 Verification Record

Date: 2026-06-21

## Release baseline

- Source baseline: `repo-harness` live-workspace V3 (`0.9.0`)
- V4 package version: `1.0.0`
- Controller fingerprint: `controller-progress-ledger-v4`
- Default ChatGPT Connector name: `repo-harness-controller-v4`
- Controller schema: `6`

## Verified V4 capabilities

- Project, Issue, and Task progress aggregation from durable task state plus the latest Run.
- Effective Task status that exposes queued, running, attention-required, and failed Run states without overwriting durable Task status.
- Project completion, active work, throughput, blocker, stale Run, and failed Run summaries.
- Unified Task detail containing objective, scope, dependencies, Run history, verification evidence, and timeline.
- Append-only controller worklog for Issue, Task, Run, verification, local approval, and GitHub events.
- Markdown and JSON worklog export to safe repository-relative paths.
- Local V4 dashboard with Progress Center, Task detail, Run monitor, worklog, approvals, checks, and GitHub plugin views.
- SSE refresh on meaningful state changes, with heartbeat-only traffic while idle.
- Optional GitHub Issue/Project plugin. It is disabled by default, stores no credentials, and uses explicit publish/refresh/close operations.
- MCP and CLI surfaces for progress, Task detail, timeline, report export, and GitHub plugin configuration.
- Runtime worklog and plugin configuration remain ignored local state; exported reports under `tasks/reports/` can be committed as review evidence.

## Verification performed

The following focused regression command passed:

```bash
bun test \
  tests/cli/controller-progress-v4.test.ts \
  tests/cli/local-bridge.test.ts \
  tests/cli/mcp-controller.test.ts \
  tests/cli/mcp-setup.test.ts \
  tests/bootstrap-files.test.ts \
  tests/workflow-contract.test.ts
```

Result:

```text
62 pass
0 fail
866 expect() calls
```

The changed runtime entry points were also bundled successfully with Bun:

```bash
bun build \
  src/cli/index.ts \
  src/cli/mcp/server.ts \
  src/cli/local-bridge/server.ts \
  src/cli/controller/progress.ts \
  src/cli/controller/worklog.ts \
  src/cli/github/plugin.ts \
  --outdir /tmp/repo-harness-v4-build \
  --target bun \
  --external commander
```

Result: 466 modules bundled successfully.

## Environment limitations

A complete dependency reinstall could not be performed in the packaging container because outbound dependency access was unavailable. The partial dependency directory also lacked `@types/bun` and `commander`, so a clean `tsc --noEmit` run was not treated as release evidence here. The source dependency declarations and lockfile are retained unchanged except for the V4 package version.

An attempted broad test run reached unchanged, environment-sensitive architecture-queue tests that use a fixed five-second timeout. Those scripts were not modified by V4. The focused suites covering all changed Controller, MCP, dashboard, setup, bootstrap, and workflow-contract surfaces passed as recorded above.

For final host validation, run:

```bash
bun install --frozen-lockfile
bun test
bun run check:type
```
