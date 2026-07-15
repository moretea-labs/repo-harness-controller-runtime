# Architecture Evolution History

> **Historical Design — Not Runtime Authority**
>
> Current architecture: [`docs/architecture/current/README.md`](current/README.md).

This document is the compact history of the Controller Runtime architecture. Detailed superseded V5–V8 design and verification documents were removed from the current tree after their useful decisions were consolidated here. Their exact contents remain recoverable from Git history.

## V5 — Durable execution and closure

V5 separated durable Issue and Task intent from individual Run attempts. It introduced explicit run failure semantics, evidence-gated progress, direct local execution, governance diagnostics, and terminal Issue archiving. The lasting rule is that a failed attempt must not silently cancel the underlying task and that completion must be supported by durable evidence.

## V6 — Direct change first

V6 made bounded Direct Edit the default for known, low-to-medium-risk changes. It added stale-write guards, explicit allowed paths, atomic patch operations, persisted diffs, targeted checks, rollback, and finalization. The lasting rule is that a small change should not require an agent worktree when a transactional edit can prove exactly what changed.

## V7 — Execution first and task-local policy

V7 classified execution by task scope and risk, selected workspace or worktree isolation deliberately, and tightened task-local verification and lifecycle handling. The lasting rule is that execution mode is chosen from current task evidence rather than from a global one-size-fits-all workflow.

## V8 — ChatGPT facade and visual controller

V8 established the compact ChatGPT-facing facade, Direct Edit as the common path, optional agent execution, recovery projections, and a visual Local Controller. Later revisions moved heavy reads off the Gateway hot path, bounded default responses, and retained atomic typed tools behind the facade.

## Legacy ChatGPT Controller and Local Bridge

The earlier Controller and Local Bridge documents described recovery projections, compact MCP capabilities, Local Job tickets, visual review, diagnostics, and optional Codex or Claude sessions. Their current contracts now live in executable code, `docs/architecture/current/`, and `docs/operations/`; these older documents are no longer separate product surfaces.

## Verification records

V5, V6, and V8 verification files were snapshots of checks performed against specific historical revisions and environments. They are not current release evidence. Current verification is produced by repository checks, durable Evidence records, and exact-revision test output.

## Preservation policy

- Current architecture belongs only in `docs/architecture/current/`.
- Important superseded decisions are summarized here instead of keeping many competing design documents.
- Detailed removed documents remain available in Git history.
- Historical text never overrides executable behavior, persisted schemas, accepted ADRs, or the current architecture set.
