# Blue/Green Runtime Efficiency — Design Notes

## Active slot authority

- Path: `<controllerHome>/active-slot.json`
- Single owner of which slot is public-active (`blue` | `green`)
- Never store active ownership inside a slot home
- Cutover/rollback both write this file atomically after health gates

## Slot state layout

```text
controllerHome/
  active-slot.json
  runtime-slots/
    blue/
      daemon/  system/  mcp/  restart/  logs/  slot.json
    green/
      ...
```

Each slot home is a full `REPO_HARNESS_CONTROLLER_HOME` for that process tree.
Ports: base from service config; inactive slot offsets by +10 unless tests inject free ports.

## Cutover / rollback sequence

1. Resolve active/inactive from authority
2. Start inactive with isolated home + ports + generation
3. Verify: daemon, scheduler heartbeat, gateway, local UI, tool fingerprint, source commit, generation, no orphan workers, min durable job, restart durability
4. Atomic authority flip + optional tunnel retarget
5. Keep previous slot for bounded rollback window
6. On failure: never flip authority; stop inactive; retain logs/evidence

Rollback restores previous healthy slot, flips authority, re-verifies, stops failed slot processes.

## Failure handling

- Green start failure → blue untouched
- Cutover verification failure → automatic rollback
- Two actives forbidden: authority file is sole owner; slot.json only records local role

## Cache invalidation model

Key: `repoId + checkoutId + branch + HEAD + workingTreeFingerprint + path + fileSha`
Invalidate precisely: file SHA change (one file), checkout switch, HEAD, merge/rebase, runtime generation, active slot, config files.
Writes always re-check checkoutId/HEAD/target SHA/allowed paths.

## Reused modules

- `lifecycle.ts` start/stop/status
- `restart-coordinator.ts` durable restart request/state
- `runtime-generation.ts` generation + source identity
- `check-runner.ts` focused checks
- `inspector.ts` read/search/git (session cache wraps these)
- `process-hygiene.ts` test process cleanup
