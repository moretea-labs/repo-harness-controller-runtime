# Stable External Runtime Supervisor

> Runtime operations guide for the immutable, externally launched Controller Supervisor.

## Install and activate

Run installation from the canonical, verified source tree:

```bash
bun src/cli/index.ts supervisor install \
  --repo /path/to/repo-harness-controller-runtime \
  --controller-home /path/to/controller-home \
  --register-service \
  --json
```

Installation builds an immutable release under:

```text
<controller-home>/supervisor/releases/<timestamp>-<revision>/
```

The release contains `supervisor.js`, `repo-harness.js`, `daemon.js`, and `manifest.json`. `current` and `previous` are updated atomically.

When `--register-service` is used while the legacy stack is running, the command first persists and launches a detached activation handoff. The current request can return before shutdown. Activation then:

1. stops the legacy Controller tree with full identity-scoped ownership checks;
2. removes an obsolete service registration;
3. registers launchd or systemd against the immutable `current` release;
4. waits for the Supervisor control surface to become healthy;
5. records the result in `<controller-home>/supervisor/activation.json`.

Do not start a second KeepAlive manually during this handoff.

Service definitions restart failures but preserve an intentional successful stop:

- launchd: `KeepAlive.SuccessfulExit=false`
- systemd: `Restart=on-failure`

## Runtime topology and ports

The configured MCP server port becomes the stable ingress port, normally `8765`.

```text
named tunnel / stable local client
             |
        stable ingress :8765
             +-- ordinary MCP/health -> active Gateway backend
             +-- /rescue/mcp         -> Supervisor control server
             +-- /rescue/health      -> Supervisor health

blue Gateway backend  :8785
blue Local Controller :8766
green Gateway backend :8795
green Local Controller:8776
Supervisor control    :8770
```

The offsets are defaults and are derived from the configured stable port. Gateway Hosts run with `--tunnel none`; the external named tunnel remains a separate stable ingress client and should continue to point at the stable port, not a slot backend.

## Status and control

```bash
bun src/cli/index.ts supervisor status \
  --controller-home /path/to/controller-home \
  --json

bun src/cli/index.ts supervisor logs \
  --controller-home /path/to/controller-home

bun src/cli/index.ts supervisor operation <operation-id> \
  --controller-home /path/to/controller-home \
  --json
```

State and evidence are stored under:

```text
<controller-home>/supervisor/state.json
<controller-home>/supervisor/supervisor.lock
<controller-home>/supervisor/activation.json
<controller-home>/supervisor/operations/<operationId>.json
<controller-home>/supervisor/control.sock
<controller-home>/supervisor/rescue-auth.json
<controller-home>/supervisor/logs/
```

The recovery token file is mode `0600` and must never enter Git or logs.

## ChatGPT control paths

### Primary Connector

The existing Repo Harness Connector continues to use the stable `/mcp` endpoint. Normal `rh_status` and `rh_work` facade operations can read Supervisor status and submit restart, rollout, rollback, operation-query, and lockout-recovery requests.

Every mutation is persisted before child shutdown and returns an operation ID plus `reconnectContract=stable_domain_retry`. A Gateway restart can close the current socket; retry the same stable domain and query the original operation ID. Do not recreate the primary Connector unless authentication or its schema changed.

### Recovery Connector

Register a second ChatGPT Connector with the same stable public origin and the recovery path:

```text
https://<stable-host>/rescue/mcp
```

Its protected-resource metadata is available at:

```text
https://<stable-host>/.well-known/oauth-protected-resource/rescue/mcp
```

The Recovery Connector exposes only:

```text
runtime_status
runtime_operation_get
runtime_restart_controller
runtime_restart_gateway
runtime_restart_full
runtime_rollout
runtime_rollback
runtime_unlock_and_recover
```

Authentication accepts the dedicated recovery bearer token, the configured main MCP bearer token, or an existing unexpired MCP OAuth access token. Requests must use `Content-Type: application/json`; bodies and mutation rates are bounded. There is no public generic restart REST API.

The Recovery Connector remains usable while the main Gateway backend is dead because `/rescue/mcp` terminates in the stable Supervisor control server.

## CLI mutations

```bash
bun src/cli/index.ts supervisor restart controller --controller-home /path/to/controller-home --request-id <id>
bun src/cli/index.ts supervisor restart gateway    --controller-home /path/to/controller-home --request-id <id>
bun src/cli/index.ts supervisor restart full       --controller-home /path/to/controller-home --request-id <id>
bun src/cli/index.ts supervisor rollout            --controller-home /path/to/controller-home --request-id <id>
bun src/cli/index.ts supervisor rollback           --controller-home /path/to/controller-home --request-id <id>
bun src/cli/index.ts supervisor unlock-and-recover --controller-home /path/to/controller-home --request-id <id>
```

Request IDs are idempotency keys. Repeating one returns the original durable operation instead of repeating an uncertain mutation.

## Recovery and lockout policy

The Supervisor independently observes the two top-level units: Controller Daemon and Gateway Host. A proven process exit recovers only that component. MCP serve and Local Controller health recovery remain inside Gateway KeepAlive. Projection freshness, queue state, WorkContracts, plugins, and historical events do not trigger process restarts.

Restart budgets are persisted per component and generation. The default budget permits five attempts per ten-minute window with bounded backoff and jitter, and resets after a stable interval. Exhaustion leaves the Supervisor and Rescue MCP running in `locked_out`; `runtime_unlock_and_recover` accepts one explicit bounded recovery attempt.

A process whose identity cannot be proved is retained and reported rather than terminated.

## Blue/green rollout and rollback

A rollout starts the inactive slot's Daemon and private Gateway backend, verifies both, records candidate identity, then switches the existing `active-slot.json` authority. The stable ingress immediately follows that authority and verifies `/health` against the candidate generation. The previous active processes remain as standby during the rollback window.

If candidate startup or verification fails, the active authority and public upstream stay unchanged. If post-cutover verification fails, authority and ingress return to the previous slot before the failed candidate is stopped. A healthy standby may also be selected automatically after an active top-level process failure within the rollback window.

## Stop and uninstall

```bash
bun src/cli/index.ts supervisor stop --controller-home /path/to/controller-home
bun src/cli/index.ts supervisor start --repo /path/to/repo --controller-home /path/to/controller-home
bun src/cli/index.ts supervisor uninstall --controller-home /path/to/controller-home
```

Stop sends the typed control command and waits for managed children, ingress, and control sockets to close. A successful exit is not restarted by launchd/systemd. `start` uses an already loaded OS service when available and only falls back to a detached process when no registered service exists.

Uninstall removes service registration and the `current` pointer. Immutable releases and durable operation evidence remain until an explicit bounded cleanup removes them.

## Verification checklist

After installation, confirm:

1. exactly one Stable Supervisor owns the Controller Home;
2. the active Daemon and Gateway Host carry the same owner epoch;
3. the main public endpoint reaches the stable ingress;
4. the active Gateway listens only on its private backend port;
5. `/rescue/mcp` answers even while the main Gateway is unavailable;
6. killing the Daemon restarts only the Daemon;
7. killing the Gateway Host restarts only the Gateway Host;
8. a repeated request ID returns the same operation;
9. rollout failure leaves the active slot unchanged;
10. no temporary test Controller daemons remain after their bounded lifetime.
