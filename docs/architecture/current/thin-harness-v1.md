# Thin Harness V1

> Status: **Runtime Authority (additive)**  
> Baseline revision: feature branch `grok/thin-harness-v1`  
> Review remediation: round-2 P0.1/P0.2/P1.1 — lease-backed Mutation Ownership, async cancel, typed effects

## Purpose

Reduce fixed middleware latency for everyday repository operations without weakening safety boundaries.

Core principle:

```text
Default to direct Fast Path execution.
Escalate to Durable Work only when recovery, background, isolation,
concurrent writes, or high-risk control is required.
Use Campaign only for multiple truly independent, long-lived deliverables.
```

## Current Implementation

### Components

| Component | Path | Responsibility |
| --- | --- | --- |
| Execution Router | `src/runtime/execution/thin-harness/execution-router.ts` | Decide `fast` / `durable` / `reject` |
| Latency Trace | `src/runtime/execution/thin-harness/latency-trace.ts` | Mutually exclusive Fast Path segments |
| Async Process | `src/runtime/execution/thin-harness/async-process.ts` | Bounded async spawn + process-tree kill + AbortSignal |
| Mutation Ownership | `src/runtime/execution/thin-harness/mutation-gate.ts` | Fast/Durable shared ownership via Execution Lease arbiter (`workspace:<checkoutId>`) |
| Request Ledger | `src/runtime/execution/thin-harness/request-ledger.ts` | Atomic create-if-absent idempotency before mutation |
| Fast Executor | `src/runtime/execution/thin-harness/fast-executor.ts` | Async Fast Path execution |
| Fast Receipt | `src/runtime/execution/thin-harness/fast-receipt.ts` | Bounded receipt; failures do not mask mutation success |
| Batch Executor | `src/runtime/execution/thin-harness/batch-executor.ts` | Typed multi-step batch (≤20); one parent receipt; whole-batch write ownership |
| Lightweight Lanes | `src/runtime/execution/thin-harness/lightweight-lanes.ts` | Read lanes (strict readonly effects) + patch_proposal_validate |
| MCP integration | `src/cli/mcp/repository-tools.ts` | Fast path for eligible `repository_command_execute`; optional batch/lanes tools |
| Command executor | `src/cli/repositories/command-executor.ts` | `repositorySnapshotAsync`, AbortSignal, process-group kill on async path |

### Execution modes

```ts
interface ExecutionDecision {
  mode: "fast" | "durable" | "reject";
  reasons: string[];
  risk: string;
  estimatedClass: "short" | "long" | "unknown";
  requiresIsolation: boolean;
  requiresRecovery: boolean;
  suggestedOperation?: string;
}
```

### Fast Path eligibility (default)

- repository file read (size-capped)
- bounded search (async `rg` preferred; inspector fallback after yield)
- Git status / bounded Git diff (async spawn)
- small path-scoped patch (pre-apply path validation + rollback)
- path-scoped stage / commit under Checkout Mutation Gate
- allowlisted typed argv **readonly** commands
- **strict** focused checks only (typed argv + explicit file/filter; bare `bun test` / `npm test` / `pytest` → durable)
- continuous local edits on one checkout

### Must use Durable Path

- background / cross-session recovery
- unfocused or full test suites
- timeouts above Fast Path cap (**15s**)
- remote writes (`git push`, PR merge/delete, publish)
- deploy / release / supervisor switch
- destructive operations
- worker isolation / worktree / durable retry
- Agent Run
- untrusted / unclassified / shell commands
- device / browser long interaction sessions
- human handoff flows
- checkout mutation busy (durable writer or competing fast writer)

### Must reject (or strong confirmation path)

- out-of-scope repository writes
- secret reads
- shell injection / policy bypass
- implicit remote writes
- unsupported system-level mutation

## What Fast Path does **not** create

- ExecutionJob
- Local Job
- Scheduler record
- Worker process
- Campaign state
- Issue Task
- Project Board records
- full projection rebuild per step
- per-step Evidence files

## What Fast Path retains

- repository binding + checkout identity
- path validation + command policy
- permission snapshot / authorization for mutating commands
- typed argv, timeout, **AbortSignal** cancellation, output caps (streamed, not unbounded buffer), secret redaction
- before/after Git snapshot for commands
- **Checkout Mutation Gate** shared with durable write leases (plus controller lock for serialization)
- one final Fast Receipt (`receiptMode: standalone`); batch/lanes use parent receipt only (`receiptMode: none` on children)
- optional `requestId` + `inputHash` idempotent replay for mutations

## Async execution model (P0)

```text
Gateway
  ↓
Fast Router
  ↓
async Fast Executor
  ↓
bounded child process (process group) / yielded search
```

- `repository_command_execute` Fast Path uses `executeRepositoryCommandAsync`.
- Git status/diff/stage use `runBoundedGit` (async spawn).
- Timeout/cancel: SIGTERM process group → grace → SIGKILL via `terminateProcessTree`.
- stdout/stderr collectors cap while streaming.

## Checkout Mutation Ownership (round-2)

Fast and Durable share the **same** Execution Lease arbiter:

```text
resourceKey = workspace:<checkoutId>
mode = write
ownerJobId = fast:<session>:<op>:<requestId> | JOB-<durable>
fencingToken = per-resource monotonic counter (lease store)
```

- Fast mutation calls `acquireExecutionLeases` — **no** separate file-gate rename race.
- Durable lease acquire conflicts with Fast ownership and vice versa (atomic under controller lock).
- Heartbeat renew every TTL/3 while holding ownership; renew failure stops further writes.
- Release is compare-and-delete via leaseId + fencingToken.
- Write batches hold **one** ownership for the entire batch wall-clock deadline (`FAST_BATCH_MAX_TOTAL_MS`).
- Router decision carries typed `effects` (`mutatesWorkspace`, etc.); ownership is based on effects, not operation name lists alone.
- Focused checks that may write (snapshots/caches) set `mutatesWorkspace=true` and take ownership.
- Read lanes reject any step with `mutatesWorkspace` / non-readonly effect before execution.
- stage/commit and write batches require `request_id` + Request Ledger (atomic O_EXCL) for Fast Path.

## Batch API (typed)

```ts
interface RepositoryBatchRequest {
  repoId: string;
  checkoutId?: string;
  mode?: "auto" | "fast" | "durable";
  steps: RepositoryBatchStep[]; // max 20
  stopOnError?: boolean; // default true
  requestId?: string;
  signal?: AbortSignal;
}
```

Allowed step kinds:

```text
read_file | search | git_status | git_diff | apply_patch
run_short_command | run_focused_check | stage_paths | commit_paths
```

Rules:

- one repository binding and one pre-execution route decision for the whole batch
- never silently upgrade mid-batch; durable steps fail closed before any step runs
- one primary Fast Receipt for the batch (no per-step receipts)
- write batches: single mutation gate for all mutating steps
- commit-containing batches are marked `nonAtomic=true` (no pseudo-transaction rollback)
- large payloads may use existing result references

## Lightweight Lanes

### Read-only Analysis Lane

- max concurrency 4
- shared checkout, no branch / worktree / Issue / Campaign
- parent receipt only; child lanes use `receiptMode: none`
- real overlap via async primitives; `concurrent` flag reports start/finish overlap
- fail-fast optional (default continue)

### Patch Proposal Validate (not Agent analysis)

- validates caller-supplied proposals for path conflicts only
- returns `proposalId`, `baseRevision`, digests, writePaths
- never writes the main checkout
- Integrator rechecks revision, conflicts, writePaths subset, digests before apply

## Campaign boundary

- Fast Path never depends on Campaign
- Campaign remains **opt-in** long orchestration
- ordinary Direct Edit must not auto-upgrade to Campaign
- this slice does **not** rewrite Campaign completion, merge, cleanup, or workspace models

## Latency measurement

Fast Path local segments (mutually exclusive; not full Gateway fiction):

```text
routingMs policyMs snapshotMs executionMs receiptMs totalMs
```

Compatibility aliases may map:

```text
gatewayValidationMs ← routingMs
authorizationMs ← policyMs
repositorySnapshotMs ← snapshotMs
operationExecutionMs ← executionMs
evidencePersistenceMs ← receiptMs
```

Unmeasured durable pipeline stages stay 0 (not claimed as measured zero cost).

Defaults return only `totalMs`. Full breakdown under `includeLatencyBreakdown`.

Benchmark entrypoint (library path; A/B via real Gateway still recommended before merge claims):

```bash
bun scripts/benchmark-thin-harness.ts
bun scripts/benchmark-thin-harness.ts --json
```

## Public surface note

Thin Harness is primarily a **library execution path** used by eligible repository operations (for example short readonly `repository_command_execute`). Optional batch/lanes/receipt tools exist on the repository tool definition set for `full` toolset / programmatic use. They are intentionally **not** bulk-added to the 128-cap stable ChatGPT schema in this slice.

## Migration Rule

1. Prefer Fast Path for short local work.
2. Escalate explicitly — never silent mid-flight upgrades.
3. Keep Durable Work / Scheduler / Worker unchanged for long and high-risk work.
4. Do not trade safety for speed.
5. Receipt persistence failure never rewrites a successful mutation outcome.
