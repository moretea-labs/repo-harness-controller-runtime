# ChatGPT-Supervised Automation Implementation Report

## Scope

Implemented a durable Campaign layer over Controller V8 for ChatGPT-supervised, Codex-executed project progression.

## Delivered

- Campaign, GoalRevision, CampaignTask, Checkpoint, ReviewPacket, and SupervisorDecision models.
- Repository-scoped JSON persistence, indexes, event ledger integration, revision checks, and request-id idempotency.
- Bounded reconciler with DAG dependencies, parallel dispatch, independent failure progression, retry backoff, and final human acceptance gate.
- Pull, safe-operation, and built-in ChatGPT Workspace Agent Supervisor adapters.
- Core MCP management and review tools.
- Long-lived Campaign feature worktrees plus forced child-worktree isolation for Agent operations, while preserving broad executor and browser capabilities.
- ExecutionJob checkout routing fixed so workers honor the recorded checkout instead of silently using the active production checkout.
- Supervisor follow-up instructions in explicit Agent retries.
- Materialized projection counts and scheduler integration outside the global dispatch lock.
- Unit tests and offline smoke tests covering idempotency, failure isolation, per-Campaign locking, lease-free waiting, worktree claims, and Workspace Agent trigger transport.

## Safety and performance invariants

- No global Campaign lock.
- No worker, lease, or lock while waiting for ChatGPT/human review.
- Failed tasks block only dependants.
- Pull-mode waiting does not generate periodic write traffic.
- Child request IDs suppress duplicate dispatch.
- Campaign completion requires explicit human acceptance.
- Human acceptance does not merge `main` or delete the Campaign worktree.


## Workspace Agent trigger

- Uses a dedicated `workspace-agent` ExecutionJob target rather than extending the legacy MCP surface.
- Reads `OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN` (or the compatibility alias `CHATGPT_WORKSPACE_AGENT_ACCESS_TOKEN`) only inside the worker process.
- Uses bounded input/error bodies, an abort timeout, stable conversation keys, and per-attempt idempotency keys.
- A `202 Accepted` trigger is followed by a bounded decision timeout. Missing decisions are retried with cooldown and eventually pause the Campaign.
- The ChatGPT Agent must return its decision through `submit_campaign_review`; the trigger API response itself is not Campaign truth.

## Validation completed in the supplied offline source snapshot

- `git diff --check`: passed.
- Strict TypeScript check of all changed files: passed; full project typecheck could not be completed because the uploaded archive did not include the real dependency installation.
- `smoke:supervised-automation`: passed with four Campaigns and seven Jobs, including Campaign worktree idempotency and checkout routing.
- Workspace Agent mocked transport smoke: passed and verified no token in the returned record.
- Runtime architecture check: passed (24 required modules/documents).
- MCP compatibility check: passed; legacy tool count remains 97 and fingerprint remains `2f4977857957118e`.
- Bun test suite was not executed because Bun and complete package dependencies are unavailable in this sandbox.
