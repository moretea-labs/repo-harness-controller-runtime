# Controller reliability and automation runbook

Use this runbook when repo-harness processes are running but tasks do not move, the UI reports readiness that does not match actual execution, or one repository affects another repository's controller resources.

## Interpret readiness in layers

Do not treat a single `ready` value as proof that autonomous delivery is active.

| Layer | What it proves | Typical evidence |
| --- | --- | --- |
| Runtime readiness | Gateway, daemon, scheduler, worker loop, and Local Bridge can respond. | `controller_ready` process and queue fields |
| Execution readiness | A suitable executor is authenticated, enabled, and able to start bounded work. | executor preflight and recent run classification |
| Delivery readiness | The task can be integrated, verified, accepted, and committed without unresolved repository conflicts. | clean selected paths, checks, integration evidence |
| Automation readiness | At least one enabled **live** schedule or live goal can create execution work. | schedule policy, occurrence status, budget and cooldown |

A shadow schedule is observation-only. It may emit `would_execute` or `shadowed`, but it does not queue or start an Execution Job. A configured provider is also not proof that work is currently running.

## First response sequence

1. Read `controller_ready` and note queue depth, running workers, active leases, current attention, and plugin summary.
2. Run `self_healing_monitor_tick` to compare daemon, scheduler, worker-loop, projection, connector, and plugin state.
3. If process readiness and projection disagree, inspect `runtime_maintenance_status` before restarting anything.
4. Apply `runtime_maintenance_apply` with `full_maintenance_pass` only after the bounded plan is reviewed. This may reconcile local jobs and rebuild projections; it must not be used as a substitute for source-code repair.
5. Re-run readiness and retry the original operation with the same intent. Restart the controller only when maintenance cannot restore a coherent projection.

## Schedule diagnosis

Use `list_schedules` with occurrences enabled and classify each enabled schedule:

- **shadow**: `policy.shadowMode` is true; no execution should be expected.
- **live but idle**: live schedule exists, but no occurrence is `created`, `queued`, or `running`.
- **live and active**: a live schedule has an occurrence in one of those active states.
- **blocked by policy**: occurrence is suppressed by cooldown, failure threshold, daily budget, dependency, or stop condition.

Do not turn every schedule live. Health snapshots and cleanup previews should normally remain shadow/read-only. Enable live execution only for a bounded action with explicit budget, cooldown, failure limit, and stop conditions.

## Failed-run classification

Classify the last failure before retrying:

- `auth_required`: authenticate the named executor or plugin; do not retry in a loop.
- `usage_limit` or provider capacity: select an allowed fallback or wait for the provider boundary to clear.
- interactive stdin / startup timeout: fail fast and relaunch with a non-interactive invocation.
- controller process disappeared: reconcile the run as `unknown`, then inspect daemon ownership before retrying.
- patch precondition failed: refresh file fingerprints and reapply only selected paths. Never overwrite unrelated dirty work.
- check failure: separate failures introduced by the current diff from known baseline failures and retain both evidence sets.

A stale health label must not override live run evidence. A run that is producing heartbeats, edits, and test output is active even if an old executor snapshot still says `auth_required`; fix the stale status projection rather than discarding the run.

## Multi-repository resource isolation

High CPU must be attributed to a repository before action. Record the process command, repository root, PID, CPU, and owner controller. A busy MCP process from another repository is a peer-repository incident, not proof that the current repository is unhealthy.

Recommended policy:

- one controller-home repository namespace per registered repository;
- repository-scoped leases, schedules, local jobs, and cleanup candidates;
- per-repository CPU/memory diagnostics and watchdog thresholds;
- no cross-repository process termination from a repository-scoped repair action;
- explicit operator authorization before terminating a peer repository process.

## Restart coordination and reconnect contract

For a Controller Home with `supervisor/current`, the Stable External Runtime Supervisor is the primary lifecycle owner. Use its typed `supervisor` CLI or the normal `rh_status`/`rh_work` runtime operations; use loopback Rescue MCP only when the primary Gateway is unavailable. Do not start a second KeepAlive or Daemon manually. The legacy coordinator remains the fallback for Homes without an installed stable release and remains readable for compatibility verification.

Use `scripts/controller-runtime.sh restart` or an authorized recovery action. All MCP, Local Bridge, GUI, and Worker-owned restart requests must be accepted before the old process tree is stopped.

The restart coordinator provides these guarantees:

- a request from inside the managed Supervisor, Gateway, Local Bridge, Daemon, or Worker ancestry is handed to a detached process group;
- the accepted request is persisted under `<controllerHome>/restart/requests/<requestId>.json`, with the latest request also written to `<controllerHome>/restart/current.json`;
- overlapping requests are deduplicated by request ID and by a controller-wide schedule/execution lock;
- only the process that acquired a lock removes it;
- phases are durable: `scheduled`, `coordinator_started`, `waiting_for_handoff`, `stopping`, `starting`, `verifying`, then `succeeded` or `failed`;
- errors are bounded and retained instead of being reported as a successful daemon probe;
- verification checks local MCP, Controller Daemon, Local Bridge, repository projection, current source/generation, connector readiness, the configured public health endpoint, and OAuth protected-resource discovery.

A full Gateway restart can close the single in-flight MCP HTTP request. It cannot preserve that socket. The supported continuity contract is the stable domain plus durable request, Work, and Job identifiers: retry the same conversation after the endpoint is healthy and continue reading the existing durable state. Do not recreate the ChatGPT Connector when the endpoint, OAuth configuration, and tool schema are unchanged. Recreate or rescan only after an auth/schema change or an explicit `UNKNOWN_TOOL`/connector-staleness result.

KeepAlive tolerates brief local `/health` failures so one transient probe does not tear down active sessions. A continuously unresponsive Gateway is replaced after 45 seconds, rather than being preserved for several minutes, because a live process with a blocked request path presents externally as repeated 502 responses. Large status and error payloads must remain bounded and heavy reads must execute through the durable control plane instead of the Gateway hot path.

After a restart, confirm:

1. `controller_ready` reports Gateway, Daemon, Worker loop, Local Bridge, and projection ready.
2. `controller_capabilities` reports no missing tools and the expected fingerprint.
3. The public `/health` and `/.well-known/oauth-protected-resource/mcp` endpoints return valid JSON.
4. `connectorNeedsReconnect` is not true.
5. Previously accepted Work/Job identifiers remain readable and no mutation was blindly replayed.

## Cleanup

Run cleanup as preview-first work:

1. Inspect `runtime_cleanup` or the cleanup preview from performance diagnostics.
2. Select only repo-harness-owned, repo-scoped candidates.
3. Exclude active worktrees, active local jobs, pending approvals, and processes whose ownership is uncertain.
4. Apply `runtime_cleanup_apply` with an age threshold and bounded candidate count.
5. Confirm that the repository projection and active work remain intact.

Temporary directories should have a TTL, but age alone is not sufficient: current leases and worktree registration remain authoritative.

## Plugin degraded states

Distinguish lifecycle from action readiness:

- `enabled + ready`: configured actions can run, subject to confirmation policy.
- `enabled + degraded`: plugin is selected but missing auth, permission, or provider availability.
- `disabled`: not part of the current capability set.
- `ready but not applicable`: tooling exists, but the repository has no matching project or artifact.

For Google Workspace plugins, resolve the specific credential source and required scope. Do not report the whole controller as delivery-ready when a task requires a degraded plugin.

## Board governance

A healthy runtime can still have an unhealthy delivery board. Regularly:

- select one current focus when focus is required;
- review completed tasks and accept verified work;
- retry or explicitly unblock failed attempts;
- archive terminal issues after evidence is retained;
- keep generated runtime metadata out of long-lived source diffs;
- clean merged worktrees and delete merged branches.

Do not create more automation work while review, acceptance, and failed-run queues are growing unchecked.

## Exit criteria

Reliability work is complete only when:

- runtime and projection report a coherent state;
- automation reporting distinguishes shadow, live-idle, and live-active states;
- targeted checks pass or remaining baseline failures are explicitly documented;
- selected-path changes are committed without absorbing unrelated work;
- the feature branch is merged and its worktree is removed;
- no destructive cleanup or peer-repository process action occurred without authorization.
