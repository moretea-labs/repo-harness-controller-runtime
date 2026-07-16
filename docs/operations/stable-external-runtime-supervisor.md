# Stable External Runtime Supervisor

> Runtime operations guide for the immutable, externally launched Controller Supervisor.

The Stable External Runtime Supervisor is the primary lifecycle owner after a release is installed. It owns one Controller Home's Daemon and Gateway Host, persists accepted operations before stopping a child, and retains the existing runtime generation, active-slot authority, restart coordinator compatibility state, KeepAlive health behavior, and blue/green authority.

## Install and register

```bash
bun src/cli/index.ts supervisor install \
  --repo /path/to/repo-harness-controller-runtime \
  --controller-home /path/to/controller-home \
  --register-service
```

Installation creates an immutable bundle under `<controller-home>/supervisor/releases/<timestamp>-<revision>/` with `supervisor.js`, `repo-harness.js`, `daemon.js`, and `manifest.json`, then atomically advances `supervisor/current` and `supervisor/previous`.

`launchd` and `systemd` definitions execute the immutable `supervisor/current/supervisor.js` bundle. They do not execute a checkout's TypeScript entrypoint. Reinstall publishes a new release; the running Supervisor keeps its existing release until the next restart.

```bash
bun src/cli/index.ts supervisor start --repo /path/to/repo --controller-home /path/to/controller-home
bun src/cli/index.ts supervisor status --controller-home /path/to/controller-home --json
bun src/cli/index.ts supervisor logs --controller-home /path/to/controller-home
```

Without an installed release, the existing lifecycle and restart coordinator remain the compatibility fallback. Once `current` is installed, Gateway and Daemon startup paths refuse to create a competing Daemon; the Supervisor is the only creator and terminator.

## Runtime state and ownership

```text
<controller-home>/supervisor/state.json
<controller-home>/supervisor/supervisor.lock
<controller-home>/supervisor/operations/<operationId>.json
<controller-home>/supervisor/control.sock
<controller-home>/supervisor/rescue-auth.json  # mode 0600
<controller-home>/supervisor/logs/supervisor.log
```

State records the Supervisor epoch, PID start time, executable fingerprint, child identities, desired/observed state, active slot/generation projections, ingress status, restart budget, incidents, and current operation. A PID is never enough to terminate a process: PID reuse, start-time changes, command-fingerprint changes, missing probes, and owner-epoch mismatches fail closed.

The Supervisor reuses `active-slot.json` and `runtime-generation.json` as authorities. Its slot and generation fields are projections for recovery and status, not replacement authorities.

## Connector and Rescue MCP surfaces

The primary Connector continues to use the configured MCP Gateway endpoint (`server.host`/`server.port`, and its configured public endpoint when present). A transient Gateway restart may close the current HTTP request. Retry the stable domain with the same durable request, Work, or operation identifier; do not recreate the Connector when auth and the MCP schema are unchanged.

The recovery surface is loopback-only and is not a public REST restart API:

```text
GET  http://127.0.0.1:<control-port>/health
POST http://127.0.0.1:<control-port>/rescue/mcp
Unix <controller-home>/supervisor/control.sock
```

The bearer token is generated at `supervisor/rescue-auth.json`, stored with mode `0600`, and must not be committed. Rescue MCP exposes only these typed tools: `runtime_status`, `runtime_operation_get`, `runtime_restart_controller`, `runtime_restart_gateway`, `runtime_restart_full`, `runtime_rollout`, `runtime_rollback`, and `runtime_unlock_and_recover`.

Mutation tools require a bounded `request_id` and return `accepted`, `operationId`, `reconnectContract=stable_domain_retry`, and `mayDisconnect=true` before child stop/start begins. No arbitrary shell, repository command, PID, path, secret, or generic HTTP restart input is accepted.

The same recovery operations are available through the normal `rh_status`/`rh_work` facade as `runtime_status`, `runtime_operation_get`, and the `runtime_*` mutations. The legacy restart coordinator remains readable and is used when no stable release is installed.

## Recovery policy

The default policy probes every five seconds, treats continuous unhealthy readiness for 45 seconds as restartable, permits five attempts per ten-minute window, applies bounded backoff (`1s`, `2s`, `5s`, `15s`, `30s`) with jitter, and resets the failure budget after fifteen minutes of stability. Exhaustion persists `locked_out`; it does not loop indefinitely. `runtime_unlock_and_recover` clears the bounded lockout and accepts one explicit recovery operation.

An observed process with uncertain identity is never killed automatically. The Supervisor records the incident and waits for an explicit, identity-proven recovery path. Gateway failure does not imply Daemon failure, and Daemon recovery does not restart the Gateway unless a full operation is requested.

## Blue/green and rollback

Blue/green continues to use `active-slot.json`, slot identities, runtime generations, and the existing cutover/rollback verification. Candidate slot homes receive the stable release before startup, so an installed stable Controller never falls back to a detached legacy KeepAlive for a candidate. Candidate health is verified before authority cutover; failed verification restores the previous active authority and stops the candidate through identity-checked lifecycle control.

## Stop and uninstall

```bash
bun src/cli/index.ts supervisor stop --controller-home /path/to/controller-home
bun src/cli/index.ts supervisor uninstall --controller-home /path/to/controller-home
```

Stop sends a typed Unix-socket command and waits for the managed tree to exit. If the socket is unavailable, it may terminate only the Supervisor PID after identity verification. Uninstall removes service registration and the `current` pointer; release directories and durable evidence remain available unless an explicit bounded cleanup is requested.
