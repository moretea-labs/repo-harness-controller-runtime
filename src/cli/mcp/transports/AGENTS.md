# Functional Block Agent Context

Keep this file focused on the local contract for this primary functional block.

<!-- BEGIN ARCHITECTURE CONTRACT -->
## Architecture Contract

- Functional block: `src/cli/mcp/transports`
- Capability ID: `mcp-http-transport-lifecycle`
- Matched prefix: `src/cli/mcp/transports`
- Architecture domain: `controller-runtime`
- Architecture capability: `transport-lifecycle`
- Architecture module: `docs/architecture/modules/controller-runtime/transport-lifecycle.md`
- Last architecture event: 2026-07-18T07:08:47.902Z
- Last changed path: `src/cli/mcp/transports`
- Severity: medium
- Change type: capability-config
- Module responsibility: Keep this block aligned with the local boundary described by surrounding human-owned context.
- Entrypoints: `src/cli/mcp/transports`
- Allowed dependencies: Follow root `AGENTS.md` / `CLAUDE.md` and this local contract.
- Forbidden dependencies: Do not cross sibling app/service/package boundaries without an architecture snapshot or explicit plan.
- Runtime path: `src/cli/mcp/transports`
- LSP/tooling profile: `typescript-lsp`
- Verification: Use root required checks plus local commands recorded in this capability contract.
- Latest snapshot: `(none yet)`
- Semantic diagram source: `docs/architecture/modules/controller-runtime/transport-lifecycle.md`
- Latest human diagram: `(none yet)`
- Pending architecture request: `none`

## Active Workstreams

- (none yet)

## Current Session Projection

- Durable progress lives under `tasks/workstreams/controller-runtime/transport-lifecycle`.
- `tasks/current.md` is the tracked derived status snapshot; it is not a live lock or task source.
- `tasks/todos.md` is the deferred-goal ledger; current execution slices stay in the active plan's `## Task Breakdown`.
<!-- END ARCHITECTURE CONTRACT -->
