# Architecture Domain: Runtime Harness

> **Source**: `.ai/context/capabilities.json`
> **Owner**: Hook implementation, user-level adapter settings, runtime event files, and handoff state.

## Purpose

The runtime harness gives Claude and Codex a file-backed workflow shell. The
shared implementation lives under `.ai/hooks/`; adapters point into that layer
instead of becoming separate hook sources of truth.

## Capabilities

- `runtime-harness-hook-adapters` -> `docs/architecture/modules/runtime-harness/hook-adapters.md`

## Stable Rules

- `.ai/hooks/` is the shared hook implementation.
- User-level `~/.claude/settings.json` and `~/.codex/hooks.json` are the host adapter surfaces.
- Repo-local `.claude/settings.json` and `.codex/hooks.json` hook adapters are retired legacy config, not required contract files.
- Other repo-local `.codex/*` files are runtime residue unless promoted by an explicit contract change.
- Runtime files under `.ai/harness/checks`, `.ai/harness/handoff`, `.ai/harness/failures`, `.ai/harness/architecture/events.jsonl`, `.ai/harness/worktrees`, and `.ai/harness/runs` are ignored state, not durable deliverables.

## Verification Surface

- `bun test tests/hook-runtime.test.ts tests/hook-contracts.test.ts tests/workflow-contract.test.ts`
- `bash scripts/check-task-workflow.sh --strict`


## Local execution bridge

The localhost-only Local Controller stores approval-aware Job Tickets under `.ai/harness/local-jobs/`. These Jobs are runtime state, are ignored by Git, and dispatch into the same durable Issue, Task, Run, diff, and verification flow used by MCP.

