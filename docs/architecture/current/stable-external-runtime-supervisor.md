# Stable External Runtime Supervisor

> **Runtime Authority**

## Current implementation

An installed Controller Home may be owned by `src/runtime/supervisor/entry.ts` from an immutable release bundle. The Supervisor persists its epoch, process identity, desired/observed state, child identities, active-slot/runtime-generation projections, operation phases, restart budgets, and incident records under `<controllerHome>/supervisor/`. `src/cli/controller/lifecycle.ts` routes installed Homes through this owner and preserves the legacy lifecycle only as the no-release fallback.

The Supervisor owns the Daemon and Gateway Host process trees. `ensureControllerDaemon` returns a bounded unavailable state when an installed Supervisor must recover the Daemon, preventing a Gateway or MCP request from creating a competing Daemon. `active-slot.json` and `runtime-generation.json` remain the authorities for slot and generation truth.

The Unix control socket and loopback `/rescue/mcp` endpoint are typed recovery surfaces. The bearer token is Controller Home state with `0600` permissions. Rescue tools accept bounded operation requests only; arbitrary shell, PID, repository, path, and secret inputs are not part of the schema. Normal `rh_status`/`rh_work` facade operations project the same runtime status and durable operation identifiers.

## Architecture requirements

- A lifecycle owner must be stable across checkout changes and must execute an immutable release bundle.
- Accepted restart, rollout, rollback, and recovery intent must be durable before child shutdown.
- Process termination requires PID, start time, command fingerprint, Controller Home, and owner epoch identity evidence.
- An uncertain process is retained and reported; it is never killed by guesswork.
- Restart attempts are bounded by a windowed budget, backoff, jitter, stable reset, and persisted lockout.
- Recovery must preserve the stable Connector domain and return a reconnect contract rather than pretending the current MCP socket survives.
- Blue/green candidate startup must not introduce a legacy KeepAlive owner once the stable release is installed; active-slot and runtime-generation authorities remain canonical.

## Migration and compatibility

Homes without `supervisor/current` continue to use the existing detached lifecycle and restart coordinator. The old coordinator's request files remain readable; stable-owned restart requests publish a compatibility state with a `supervisorOperationId` and map Supervisor phases back to the legacy verification contract. New releases are published by atomic `current`/`previous` symlink changes, while launchd/systemd execute only the stable bundle.
