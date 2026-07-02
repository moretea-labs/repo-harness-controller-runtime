# Controller Core Runtime Refactor — Review and Verification Report

Date: 2026-07-02  
Source: `repo-harness-source-20260702-114741.zip`  
Sandbox branch: `refactor/controller-core-runtime`

## Delivery objective

Refactor repo-harness from a transport-coupled, high-overhead Controller into a more stable local execution runtime:

- an MCP disconnect must not erase durable execution identity;
- Gateway, Tunnel, Controller daemon and Local Controller UI must not share one failure/restart boundary;
- status reads must be bounded and must not create refresh Jobs;
- high-frequency Worker heartbeats must not rewrite global indexes;
- the default Connector surface must be small and intention-oriented;
- legacy behavior must remain available during migration;
- source is delivered only after code review, focused regression, repository-wide test coverage and archive validation.

## Implemented architecture changes

### Resumable Work facade

Added `work_submit`, `work_get`, `work_list` and `work_cancel` over durable Execution Jobs.

- `request_id` is the idempotency and reconnect key.
- `work_id` is the stable durable execution handle.
- request lookup is repository-scoped.
- reuse of one `request_id` across repositories fails with `REQUEST_ID_REPO_CONFLICT`.
- repeated submission of the same request and operation returns the original Work instead of dispatching a duplicate.

This is business-level execution recovery after a new MCP Session is established. It is intentionally not presented as transparent continuation of the same in-memory SSE transport.

### Default core MCP surface

Added explicit `core` and `full` toolsets.

- Default `core`: 12 tools.
- Compatibility/full surface: 118 tools.
- Existing compatibility fingerprint remains `2f4977857957118e`.
- Core runtime fingerprint: `b060f20a3c02f1ab`.
- Full runtime fingerprint: `6a9ccc1e3f243008`.
- Calls to hidden legacy tools fail explicitly with `TOOL_NOT_EXPOSED`.
- CLI, setup, doctor, HTTP health headers and keepalive identity checks all use the same toolset contract.

### Read-side and storage performance

- Worker heartbeat now updates only its own Job record under the Job lock.
- Heartbeat no longer rewrites active/recent global indexes, emits evidence, dirties repository projections or wakes the Scheduler every few seconds.
- Legacy Job listing fallback is read-only and no longer backfills indexes during a status request.
- Dirty runtime projections are rebuilt as current bounded in-memory snapshots without rewriting the persisted projection or clearing the dirty marker.
- `controller_context` does not create a refresh Job or start repository reconciliation.
- Current Issue, ready Tasks, indexed active Runs, Local Jobs and named Checks are read directly and returned with explicit bounds.
- Runtime-storage information in `controller_context` is descriptive/read-only; it does not run storage migration.

### Independent process lifecycle

- Local Controller UI is started as a separate detached service process.
- Keepalive is started with `--no-local-ui` by the Controller service.
- Gateway restart no longer kills a live Tunnel or rotates a Quick Tunnel endpoint.
- A live unhealthy Tunnel is preserved while the local Gateway is unhealthy.
- Tunnel restart requires its own continuous failure window; a dead Tunnel still restarts immediately.
- Service cleanup protects the current process and all of its ancestors, fixing a real bug where the startup script could kill its own caller.

### Worker lifecycle correctness

- Late stdout/stderr chunks after child `exit` continue to be persisted but cannot overwrite an authoritative `finalizing` or completed phase.
- This fixes an auto-integration race where a Run returned to `editing` and entered `waiting_for_user` after the Agent process had already exited.

### Controller information architecture

The Local Controller snapshot and dashboard now expose bounded decision queues:

- Needs Attention
- Running Now
- Ready for Review
- Recently Completed

Scheduler, Lease and process details remain available as diagnostics rather than defining the main user workflow.

## Additional defects found during review

The review fixed issues beyond the initial refactor scope:

1. Cross-repository Work lookup/reuse through a shared request ID.
2. CLI `--toolset` defaults overriding a previously saved `full` configuration.
3. Runtime and compatibility fingerprints being conflated.
4. Controller Context reads creating durable refresh Jobs.
5. Read-side legacy index backfill acquiring global write locks.
6. Controller orphan cleanup killing the active startup ancestry.
7. Late Agent output overwriting terminal lifecycle phases.
8. Integration tests relying on a login shell that discarded the explicit Bun PATH.
9. CodeGraph tests accidentally reaching the host runtime instead of the fake runtime.
10. Migration tests relying on global Git author identity.
11. Integration tests using whole-scenario timeouts shorter than the normal scenario duration.
12. Public export secret scanning treating the `sk-` substring inside `task-workflow-*` as a token.

## Verification evidence

### Static and architecture gates

- TypeScript `tsc --noEmit`: passed.
- Runtime architecture check: 24 required modules/documents passed.
- MCP compatibility check: passed.
- Deploy SQL ordering: passed.
- Architecture sync: advisory mode, 0 blocking findings.
- Task sync: passed after updating the task snapshot.
- Strict task workflow: passed after refreshing the handoff packet.
- Repository inspection: no drift signals or required decisions.
- Public export scan: passed, 450 public files.
- `npm pack --dry-run`: passed, 543 files.

### Runtime smoke tests

- Runtime control plane: passed; Controller Context and Local Bridge reads completed in approximately 160 ms in the smoke fixture.
- Runtime recovery: passed.
  - ambiguous mutation -> `human_attention_required`;
  - receipt recovery -> `succeeded`;
  - stale Worker fenced;
  - automatic external Issue creation remained blocked.
- MCP HTTP runtime: passed.
  - default toolset `core`;
  - 12 exposed tools;
  - runtime fingerprint matched;
  - repository health ready.
- Schedule Engine: passed.

### Focused Controller/runtime tests

- Target architecture + MCP Controller: 46/46 passed.
- Local Execution Bridge: 21/21 passed.
- Keepalive, MCP setup, Controller service, MCP Session recovery, process-tree reclamation and Scheduler capacity: 40/40 passed.
- Global runtime init and init command tests: 29/29 passed.
- Hook runtime long suite: 106/106 passed.
- Migration suite: 27/27 unaffected scenarios passed in the isolated full-file run; the idempotency scenario passed separately after replacing its incorrect 30-second limit with the shared 60-second integration limit and configuring repository-local Git identity.

### Repository-wide test coverage

An isolated sweep executed all 110 test files. The first sweep produced 106 passing files and four infrastructure/time-budget findings:

- two fake-runtime isolation tests, fixed and rerun successfully;
- the Hook runtime file exceeded the artificial 240-second whole-file wrapper, rerun successfully as 106/106;
- the Migration file exceeded the artificial whole-file wrapper and one scenario's internal 30-second limit, with all scenarios subsequently passing as described above.

No remaining product-code test failure is known.

### Package validation

- Public release export: passed.
- Package dry-run: passed.
- Offline package-content smoke: passed using the generated `repo-harness-1.4.0.tgz` plus the already installed lock-compatible dependency tree.
  - packaged CLI returned version `1.4.0`;
  - packaged `status --json` started against a fresh Git repository;
  - packaged Hook entrypoint started successfully.

The repository's official tarball-install script attempted to resolve dependencies from the sandbox's private npm proxy and was blocked by proxy 404 responses for public packages. This is an external environment limitation, not a package-content or runtime failure. The same limitation prevents a fresh `bun install --frozen-lockfile`; all code/test gates used the installed dependency tree already present in the sandbox.

### Controller v8 wrapper note

The Controller v8 behavior groups completed with 74/74 passing assertions. In this sandbox, the aggregate wrapper did not reliably terminate after entering its final TypeScript phase, although standalone TypeScript and all constituent behavior groups passed. The report therefore records the constituent evidence and does not claim an aggregate wrapper exit code that was not observed.

## Deliberate remaining boundaries

These are explicit migration boundaries, not hidden defects:

- Recovery resumes durable Work after a new MCP Session; it does not transparently continue the same in-memory SSE stream.
- Runtime metadata remains file-backed. The highest-frequency write amplification and read-side writes are removed, but a SQLite WAL migration is deferred.
- The 118-tool legacy/full surface remains available for compatibility; new installations default to the 12-tool core surface.
- Process boundaries are separated within the existing Controller service. Native `launchd`/`systemd` units are not introduced in this slice.
- Public Cloudflare/ngrok availability cannot be proven from the offline sandbox; local restart isolation and endpoint-preservation behavior are covered by tests.

## Source review conclusion

The implemented slice meets its stated goals:

- execution identity survives transport reconnection through durable Work handles;
- high-frequency runtime writes are reduced;
- status reads no longer launch heavy refresh work;
- process failures no longer cascade across Gateway, Tunnel, daemon and UI by design;
- default Connector complexity is substantially reduced;
- Worker ownership and terminal-state races remain fail-closed;
- legacy compatibility is retained behind an explicit toolset.

No known high-severity code defect remains in the modified scope at delivery time.
