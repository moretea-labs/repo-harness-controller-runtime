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
