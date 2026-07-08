# repo-harness Capability Recovery and Assistant Monitoring

repo-harness now exposes a bounded recovery model for capability degradation. The model separates local recoverable faults from client/platform-side blocks so the controller can avoid ineffective restart loops and route blocked sessions toward sandbox patch handoff.

## Failure classes

| Class | Meaning | Local recovery |
| --- | --- | --- |
| `local_recoverable` | Controller daemon, Local Bridge, repository metadata, or runtime storage can be repaired locally. | Yes, with bounded action. |
| `stale_runtime_state` | Jobs, leases, worktrees, or projections appear stale. | Yes, via reconcile/rebuild actions. |
| `auth_required` | A plugin or agent runtime needs OAuth/token/user re-authorization. | User action required. |
| `policy_denied` | repo-harness policy denied the operation. | No automatic retry. |
| `platform_blocked` | ChatGPT/platform blocked the tool call before it reached repo-harness. | No local fix; use patch handoff or narrower typed tools. |
| `dirty_worktree_conflict` | Integration would overwrite existing local edits. | No automatic integration. |
| `agent_runtime_failure` | The local agent runtime failed or disconnected. | Maybe, with bounded retry/reconcile. |
| `plugin_configuration_error` | Plugin is enabled but unhealthy. | Reconfigure plugin. |
| `source_defect_suspected` | Repeated local evidence suggests a repo-harness source defect. | Create a self-fix task in an isolated worktree. |
| `user_action_required` | Recovery needs an explicit human decision. | No automatic mutation. |
| `unknown` | Evidence is insufficient. | Probe again. |

## Exposed MCP tools

- `capability_recovery_probe`: read-only matrix of daemon, bridge, scheduler, workers, connector, runtime projections, tools, plugins, and assistant monitor state.
- `capability_recovery_plan`: compact recovery plan containing blocking capabilities and next actions.
- `capability_recovery_apply`: authorized bounded recovery action. Actions that mutate state require `confirm_authorization=true` and `authorization=<action_id>`.

## Local Bridge GUI

The Local Bridge dashboard adds a **监控** page and an overview card:

- overall assistant capability state
- blocked/degraded counts
- platform-blocked fallback indicator
- detailed capability matrix
- recommended recovery actions
- one-click local recovery actions with explicit confirmation

## Safety rules

1. Read-only probes can run automatically.
2. Mutating recovery requires explicit authorization.
3. `platform_blocked` never recommends daemon restart loops.
4. Runtime cleanup and projection rebuilds are bounded to repo-harness runtime storage.
5. Source fixes must go through isolated worktrees and existing verification gates.
6. Dirty local files remain protected by integration conflict checks.

## Recommended operating flow

```text
capability_recovery_probe
  -> classify failure
  -> capability_recovery_plan
  -> capability_recovery_apply(action_id) for local recoverable faults
  -> sandbox patch handoff for platform_blocked faults
```

When ChatGPT cannot call high-risk tools because the platform blocks them, use the Local Bridge GUI or `capability_recovery_plan` to create a durable handoff instead of repeatedly restarting local services.

## Recovery state machine

Every failed, unknown, or user-waiting execution should be converted into a structured recovery record before any retry is attempted.

```text
observed
  -> classified
  -> planned
  -> local_recoverable | user_action_required | platform_blocked | source_defect_suspected | unknown
  -> action_executed
  -> verified
  -> resumed | failed_with_continuation_packet
```

Transition rules:

- `observed -> classified`: parse durable job/run status, error text, current activity, process liveness, runtime storage readiness, worktree state, and tool response shape.
- `classified -> planned`: attach the smallest safe next action. A plan can be read-only, local maintenance, user handoff, sandbox patch handoff, or source repair task creation.
- `planned -> local_recoverable`: only for bounded repo-harness runtime metadata actions such as reconcile, projection rebuild, registration refresh, or empty abandoned worktree cleanup.
- `planned -> user_action_required`: when auth, policy, quota, dirty-user-files, or ambiguous destructive state prevents safe automation.
- `planned -> platform_blocked`: when the client/platform blocked the tool before repo-harness can observe or fix the local state.
- `planned -> source_defect_suspected`: only after repeatable local evidence shows repo-harness implementation failure, not merely stale state or auth failure.
- `action_executed -> verified`: recovery actions must produce audit evidence and a targeted verification result before the original intent is resumed.

## Current failure mapping

These mappings are grounded in recent controller runs and should be implemented before broader autonomous source repair.

| Observed evidence | Stable class | Retry policy | Next safe action |
| --- | --- | --- | --- |
| `Auth(AuthorizationRequired)`, `AuthorizationRequired`, OAuth/token required | `auth_required` | Do not immediately retry the same agent/tool. | Produce user-action handoff, stop retry loop, preserve continuation packet. |
| `Controller process ... is no longer running` with a non-terminal or `unknown` run | `agent_runtime_failure` + `stale_runtime_state` | Retry only after reconcile marks the prior run interrupted/orphaned. | Reconcile jobs/runs, rebuild projection, generate retry continuation. |
| `edit operations failed precondition checks` | `dirty_worktree_conflict` | Do not overwrite. | Produce sandbox patch handoff or manual integration packet with touched paths and failed operations. |
| `ContentLengthError`, `Response payload is not completed`, truncated large response | `platform_blocked` or `agent_runtime_failure` depending on origin | Do not repeat the same full-payload read. | Retry through summary/detail pagination or bounded artifact reads. |
| `You've hit your usage limit` or model quota message | `user_action_required` | Do not agent-retry until quota/provider changes. | Save continuation packet and suggest alternate configured executor only if available. |
| `EXTERNAL_FILESYSTEM_GRANT_REQUIRED` | `user_action_required` | Do not broaden filesystem reads automatically. | Request named external read grant through the dedicated preview/apply flow. |
| Missing/unreadable Local Job records, stale active-index, stale lease | `stale_runtime_state` | Retry after maintenance only. | Use `runtime_maintenance_status` then authorized `runtime_maintenance_apply`. |
| Repeated recovery action exception after maintenance and restart | `source_defect_suspected` | Do not loop maintenance indefinitely. | Create bounded source-fix task in isolated worktree with targeted verification. |

## Failure diagnosis contract

The classifier should return a stable diagnosis object rather than only a free-text error:

```ts
type RecoveryClass =
  | "local_recoverable"
  | "stale_runtime_state"
  | "auth_required"
  | "policy_denied"
  | "platform_blocked"
  | "dirty_worktree_conflict"
  | "agent_runtime_failure"
  | "plugin_configuration_error"
  | "source_defect_suspected"
  | "user_action_required"
  | "unknown";

type FailureDiagnosis = {
  recoveryClass: RecoveryClass;
  severity: "low" | "medium" | "high" | "critical";
  localRecoverable: boolean;
  retryable: boolean;
  requiresUserAction: boolean;
  evidence: string[];
  nextSafeActions: string[];
  avoidActions: string[];
};
```

`avoidActions` is required so repeated known failures do not cause wasteful retry loops. For example, `auth_required` should include `retry_same_agent_immediately`, and large payload failures should include `repeat_full_payload_read`.

## Dirty workspace boundary

Pre-existing user or unrelated agent changes are never part of self-healing recovery unless the recovery task explicitly owns those paths. If the workspace is dirty before recovery starts, the recovery record must capture the dirty path list and mark those paths as protected. Current examples include unrelated Local Bridge edits such as:

```text
src/cli/local-bridge/dashboard.ts
src/cli/local-bridge/server.ts
```

A recovery patch may still update unrelated documentation or runtime metadata, but integration must stage and commit only the owned paths. Dirty protected paths must not be reformatted, overwritten, or included in source-repair diffs.
