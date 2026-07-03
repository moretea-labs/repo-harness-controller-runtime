# Runtime Directory Map

> Status: **Runtime Authority**

```text
src/runtime/
  gateway/mcp/                 Thin command admission, policy and runtime tools
  control-plane/
    global-scheduler/          Global fairness, quotas, process dispatch and reconciliation
    repo-actor/                Repository-local single-owner scheduling
    governance/                External side-effect and requirement-growth policy
  workflow/
    schedules/                 Trigger, bounded Occurrence, persisted Decision and backoff
    portfolio/                 Cross-repository DAG and Saga
    findings/                  Deduplicated Candidate Finding and explicit promotion
  plugins/                     Derived manifests, discovery registry, policy-typed actions and provider adapters
  execution/
    jobs/                      Durable Job schema, indexes, Operation Receipts and compatibility projection
    workers/                   Isolated one-Job process execution
  resources/
    claims/                    Conflict taxonomy and conservative unknown scope
    leases/                    Lease, renewal, release and fencing
  evidence/                    Unified events, exact-revision evidence and bounded Artifacts
  projections/                 Dirty-marker invalidated materialized read models
  release/                     Release freeze, gate and manifest
  shared/                      Atomic file and portable Node TypeScript-loader utilities
```

Legacy code remains under `src/cli/` for public compatibility:

- `src/cli/mcp/tools.ts` is a stable export facade;
- `src/cli/mcp/legacy-tool-service.ts` contains the preserved operation implementation;
- Gateway handlers use schemas and compact reads;
- isolated Workers invoke compatibility implementations after durable admission;
- Local Jobs project into `ExecutionJob` while retaining their original IDs and UI contract.

New scheduling ownership must be added under `src/runtime/`, never inside MCP transport handlers.

## Runtime Storage Ownership and Quarantine

Each bound directory under Controller Home contains `.repo-harness-owner.json` with `repoId`, binding name, and management identity. Repository-local `.ai/harness/<binding>` paths are links to these owned directories.

When legacy and Controller Home directories both contain data, non-conflicting entries are merged. Conflicting source entries are preserved under:

```text
<controller-home>/repositories/<repoId>/quarantine/runtime-storage/<binding>/
```

Execution readiness remains false for active/unreadable Run or Local Job state and for non-directory/path conflicts. A non-empty worktree directory by itself is not a reason to perform an unsafe move or to block forever.
