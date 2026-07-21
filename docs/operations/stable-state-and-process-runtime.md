# Stable State, Process Runtime, and Blue/Green

## Root causes (pre-change)

1. **Ordinary commands used Durable Jobs** — `run_check` and many shell commands created `ExecutionJob` → Worker → `LocalBridgeJob` → shell, inflating latency and contention.
2. **Heavy exclusive locks** — every check competed on `heavy-check:<repoId>`.
3. **Dual execution paths** — Direct/Fast and long-running commands could re-issue work after interactive timeout instead of returning a handle to the same process.
4. **Repository state inside slots** — durable repo data under `runtime-slots/{blue,green}` coupled sessions/worktrees/processes to runtime generations.
5. **Versioned Supervisor owned stable ingress** — control socket and port 8770/8765 contention; activation could report success while still pending.

## Unified Process Runtime

```text
MCP request
  → classify (Thin Harness + command classifier)
  → spawnManagedProcess (single spawn)
  → finishes within interactiveWaitMs → Direct result
  → still running → Managed Process handle (same PID / processId)
```

- No re-execution after spawn.
- Terminal writes are fence-token CAS (`terminalFenceToken` + `terminalWritten`).
- Restart recovery: `recoverManagedProcesses` re-validates PID + `processStartTime`.
- Passive / fenced slots must not write process terminal state.

## Direct / Managed / Durable boundaries

| Class | Examples | Path |
| --- | --- | --- |
| Direct / Fast | read, search, git status/diff, short focused checks, safe `&&` validation combos | Process Runtime / Thin Harness |
| Managed Process | long typecheck/test that exceeds interactive wait | Same process, return `processId` |
| Durable Workflow | approval, schedule, release/rollback, multi-phase, non-idempotent remote write | ExecutionJob |

## `run_check`

- Ordinary package checks → Process Runtime (no LocalBridgeJob / ExecutionJob / Worker).
- `check:release`, migration, controller-v8, explicit `mode=durable` → Durable.
- Claims: fine-grained (workspace-read + build-cache) unless heavy/release.

## Stable repository layout

```text
_ops/controller-home/
├─ bootstrap/                 # Stable Bootstrap (ingress, control socket, writer authority)
├─ repositories/<repoId>/     # durable state (outside slots)
├─ runtime-slots/blue|green/  # runtime-only (slot.json, logs, pids)
└─ releases/
```

Migration: `migrateRepositoryStateOutOfSlots({ dryRun })` — idempotent, keeps source until validated, repairs worktree `.git` gitdir prefixes.

## Writer fencing

`bootstrap/writer-authority.json` holds `{ epoch, fencingToken, activeSlot }`.

Cutover / rollback via `markCutoverAuthority` / `markRollbackAuthority` also call `atomicActivateRuntime` so the previous slot immediately fails `assertWriterAuthority` / `assertActiveWriterForAction`.

## Control socket

`ensureControlSocketReady` removes a socket only when the recorded owner is dead or identity mismatches. Never unconditional delete on start.

## Versioned ports

`assertVersionedRuntimePort` rejects 8765/8770 for versioned Gateway/Daemon. Stable ingress owns public ports.

## Rollback

```bash
# Roll back active slot + writer authority (within rollback window)
bun run controller -- rollback   # or existing bluegreen rollback CLI

# Inspect writer authority / pointer
cat _ops/controller-home/bootstrap/writer-authority.json
cat _ops/controller-home/bootstrap/active-runtime.json
cat _ops/controller-home/active-slot.json
```

## Agent default

Coding Agent remains **opt-in only** (`a07c6d24`). Worktree isolation / long process / recovery never imply agent authorization.
