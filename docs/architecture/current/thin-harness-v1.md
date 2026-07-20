# Thin Harness V1

> Status: **Runtime Authority (additive)**  
> Baseline revision: implemented on feature branch `grok/thin-harness-v1`

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
| Latency Trace | `src/runtime/execution/thin-harness/latency-trace.ts` | Bounded in-process segment timing |
| Fast Executor | `src/runtime/execution/thin-harness/fast-executor.ts` | In-process / short-child execution |
| Fast Receipt | `src/runtime/execution/thin-harness/fast-receipt.ts` | One bounded receipt per fast call |
| Batch Executor | `src/runtime/execution/thin-harness/batch-executor.ts` | Typed multi-step batch (≤20) |
| Lightweight Lanes | `src/runtime/execution/thin-harness/lightweight-lanes.ts` | Read-only + patch-proposal lanes |
| MCP integration | `src/cli/mcp/repository-tools.ts` | Fast path for eligible `repository_command_execute`; optional full-surface batch/lanes tools |

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

- repository file read
- bounded search
- Git status / bounded Git diff
- small path-scoped patch
- path-scoped stage / commit
- allowlisted typed argv readonly commands
- allowlisted short focused checks
- continuous local edits on one checkout

### Must use Durable Path

- background / cross-session recovery
- full test suites or timeouts above Fast Path cap (30s)
- remote writes (`git push`, PR merge/delete, publish)
- deploy / release / supervisor switch
- destructive operations
- worker isolation / worktree / durable retry
- Agent Run
- untrusted / unclassified commands
- device / browser long interaction sessions
- human handoff flows

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
- typed argv, timeout, cancellation, output caps, secret redaction
- before/after Git snapshot for commands
- checkout-level short write lock (not global scheduler lock)
- one final Fast Receipt

## Batch API (typed)

```ts
interface RepositoryBatchRequest {
  repoId: string;
  checkoutId?: string;
  mode?: "auto" | "fast" | "durable";
  steps: RepositoryBatchStep[]; // max 20
  stopOnError?: boolean; // default true
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
- one primary Fast Receipt for the batch
- large payloads may use existing result references

## Lightweight Lanes

### Read-only Analysis Lane

- max concurrency 4
- shared checkout, no branch / worktree / Issue / Campaign
- parent receipt only; child lanes return summaries
- fail-fast optional (default continue)

### Patch Proposal Lane

- returns proposed patch, writePaths, assumptions, risk notes
- never writes the main checkout
- Integrator applies selected proposals sequentially through Fast Path patch
- write/write, write/read, project file, and schema conflicts demote proposals to analysis-only

## Campaign boundary

- Fast Path never depends on Campaign
- Campaign remains **opt-in** long orchestration
- ordinary Direct Edit must not auto-upgrade to Campaign
- this slice does **not** rewrite Campaign completion, merge, cleanup, or workspace models

## Latency measurement

Segments:

```text
gatewayValidationMs authorizationMs resourceClaimMs jobPersistenceMs
schedulerWaitMs workerStartupMs repositorySnapshotMs operationExecutionMs
evidencePersistenceMs projectionUpdateMs responseSerializationMs totalMs
```

Defaults return only `totalMs`. Full breakdown is available under debug/benchmark (`includeLatencyBreakdown`).

Benchmark entrypoint:

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
