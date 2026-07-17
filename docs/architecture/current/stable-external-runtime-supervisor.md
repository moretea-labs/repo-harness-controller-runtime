# Stable External Runtime Supervisor

> **Runtime Authority**

## Current implementation

An installed Controller Home is owned by `src/runtime/supervisor/entry.ts` from an immutable release bundle. The operating-system service manager launches only that stable bundle; blue/green slots, repository checkouts, and temporary worktrees never contain the top-level lifecycle authority.

The runtime topology is:

```text
launchd / systemd
        |
Stable Supervisor
        +-- stable loopback ingress (configured public MCP port)
        +-- loopback control + Rescue MCP
        +-- active Controller Daemon
        +-- active Gateway Host / KeepAlive
                +-- MCP serve
                +-- embedded Local Controller
```

The stable ingress owns the public local binding, normally `127.0.0.1:8765`. Active Gateway Hosts bind private slot backends (`8785` for blue and `8795` for green by default) and run with `--tunnel none`. An operator-managed named tunnel therefore continues to target one stable local port while Gateway Hosts restart or slots change. Recovery routes are served independently of the active Gateway at `/rescue/mcp` and `/rescue/health`; ordinary paths proxy to the active slot selected by the existing `active-slot.json` authority.

The Supervisor persists its epoch, process identities, desired/observed state, active and standby child identities, slot/generation projections, durable operation phases, restart budgets, ingress status, and incidents under `<controllerHome>/supervisor/`. `runtime-generation.json` in each managed Controller Home and root `active-slot.json` remain canonical. Supervisor state is a recovery projection, not a competing authority.

## Lifecycle ownership

The Supervisor is the only creator and terminator of the top-level Controller Daemon and Gateway Host after installation. Gateway KeepAlive continues to own MCP serve and the embedded Local Controller; the Supervisor does not compete for those children. Backend Gateway Hosts do not own a tunnel.

Process termination requires PID, process start time, command fingerprint, Controller Home, component, and Supervisor epoch identity. An uncertain process is retained and reported. PID existence alone is never sufficient.

Installation over a running legacy stack uses a detached activation handoff. The activation request is persisted before the current Gateway is stopped, the legacy process tree is identity-scoped and fully stopped, then the OS service is registered and verified. A loaded service is started through launchd/systemd rather than by creating an untracked detached duplicate.

launchd uses `KeepAlive.SuccessfulExit=false`, and systemd uses `Restart=on-failure`. A crash is restarted; a successful explicit stop remains stopped.

## Durable operations and recovery

Restart, rollout, rollback, and lockout recovery are persisted before mutation. Reusing a request ID returns the original operation. If the Supervisor itself restarts, operations that were merely accepted or scheduled remain eligible to run, while operations interrupted after mutation began are terminalized as explicit failures rather than blindly replayed.

Restart attempts use component- and generation-scoped persistent budgets, bounded backoff, jitter, a stable reset window, and lockout. Business readiness, projection age, WorkContract state, plugin state, and historical incidents are not top-level restart triggers. The Gateway Host's existing KeepAlive remains responsible for bounded MCP health recovery.

## Rescue MCP and ChatGPT paths

The loopback control server exposes a fixed eight-tool Rescue MCP surface:

- `runtime_status`
- `runtime_operation_get`
- `runtime_restart_controller`
- `runtime_restart_gateway`
- `runtime_restart_full`
- `runtime_rollout`
- `runtime_rollback`
- `runtime_unlock_and_recover`

It accepts the Controller Home recovery token, the configured main MCP bearer token, or an unexpired access token from the existing MCP OAuth token store. It applies bounded request bodies, JSON content-type enforcement, mutation rate limiting, durable request IDs, and fixed schemas. Arbitrary commands, PIDs, paths, repository actions, plugins, and secrets are absent.

Normal operation remains:

```text
ChatGPT -> primary Connector -> main MCP facade -> durable Supervisor operation
```

When the main Gateway is unavailable:

```text
ChatGPT -> Recovery Connector -> stable /rescue/mcp -> durable Supervisor operation
```

The two connectors use the same stable public origin but different MCP paths. The Recovery Connector has only the fixed recovery toolset.

## Blue/green invariants

Rollout and rollback are executed by the stable owner. Candidate Daemon and Gateway Host processes start in the inactive slot home on private ports. Candidate readiness is verified before `active-slot.json` changes. The ingress follows that authority atomically, and the stable public health surface is re-verified with the candidate generation. Failure restores the previous authority and upstream before the candidate is stopped.

A successful rollout retains the previous processes as standby for the rollback window. An active top-level component failure during that window may create one durable automatic rollback operation when the standby identities are still healthy. Expired standby processes are reclaimed without deleting active, candidate, or rollback-referenced slot state.

## Compatibility

Homes without `supervisor/current` continue to use the legacy lifecycle and detached restart coordinator. Existing coordinator request files remain readable. Once installed, legacy restart commands and normal ChatGPT facade actions submit durable Supervisor operations and retain the stable-domain reconnect contract.
