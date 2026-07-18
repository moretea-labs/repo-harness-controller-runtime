# Implementation Notes: fix-mcp-session-lifecycle

> **Status**: Active
> **Plan**: plans/plan-20260718-1452-fix-mcp-session-lifecycle.md
> **Contract**: tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md
> **Review**: tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md
> **Last Updated**: 2026-07-18 14:53
> **Lifecycle**: notes

## Design Decisions

- Treat SSE as a replaceable transport lease, not execution ownership; only active POST work is protected from capacity eviction.
- Keep one global registry across `/mcp`, `/mcp-grok`, and `/mcp-bearer`, while retaining route and principal checks on lookup.
- Keep initialize reservations inside that registry so concurrent handshakes cannot oversubscribe capacity or be evicted before their response completes.
- Supersede only an explicitly identified prior session; client metadata is not a unique agent identity. Do not apply OAuth-style per-principal fairness to a fleet sharing one static bearer token.
- Run stable ingress as a supervised child process from the same immutable Supervisor bundle; it reads active-slot authority per request and exits when its parent lifecycle owner disappears.
- Do not deploy or restart the live `_ops` runtime from this implementation worktree.

## Deviations From Plan Or Spec

- The user requested implementation-first after the initial minimal regression baseline; subsequent coverage was added after the behavior was implemented.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Reject new initialize at capacity | Rejected | Reproduces the live 502/503 loop because stale SSE sessions monopolize the fixed pool. |
| Evict every old request | Rejected | Could terminate durable work still executing through an active POST. |
| Lease stream-only sessions and isolate ingress | Selected | Reclaims transport state deterministically while preserving execution ownership and control-plane responsiveness. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
