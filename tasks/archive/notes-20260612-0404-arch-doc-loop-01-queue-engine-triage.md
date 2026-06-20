> **Archived**: 2026-06-12 04:04
> **Related Plan**: plans/archive/plan-20260612-0318-arch-doc-loop-01-queue-engine-triage.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-0404

# Implementation Notes: arch-doc-loop-01-queue-engine-triage

> **Status**: Complete
> **Plan**: plans/plan-20260612-0318-arch-doc-loop-01-queue-engine-triage.md
> **Contract**: tasks/contracts/20260612-0318-arch-doc-loop-01-queue-engine-triage.contract.md
> **Review**: tasks/reviews/20260612-0318-arch-doc-loop-01-queue-engine-triage.review.md
> **Last Updated**: 2026-06-12 03:46
> **Lifecycle**: notes

## Design Decisions

- Use `scripts/architecture-queue.sh` as the single repo-local CLI for architecture request queue operations: `record`, `status`, `reindex`, `triage`, and `check`.
- Keep `scripts/architecture-event.ts` responsible for parsing event metadata, rendering request cards, and deriving the controlled pending block in `docs/architecture/index.md`.
- Preserve the existing hook-visible `[ArchitectureDrift] Request:` prefix so downstream post-edit orchestration and context sync behavior remain compatible.
- Keep PostToolUse advisory-only. Strict blocking is implemented for queue `check`, but normal policy remains `freshness_gate=advisory` until slice 2 wires finish/check surfaces.
- Archive legacy requests instead of deleting them. The pending root directory is for live cards only; historical per-file cards move under `docs/architecture/requests/archive/2026/`.

## Deviations From Plan Or Spec

- The original task acceptance expected an intermediate state of four capability cards after cutoff triage. This implementation completed the follow-on resolve pass in the same slice, so `docs/architecture/requests/` is now empty and the index pending block is `- (none)`.
- The archive helper needed a small compatibility fix for empty artifact arrays under macOS bash 3 with `set -u`; both source and template copies were updated.
- Productization-adjacent helper inventory and scaffold parity tests were included in this slice because deleting `architecture-drift.sh` would otherwise leave generated repo surfaces inconsistent.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Keep `architecture-drift.sh` as a wrapper | Reject | It would preserve two names for one state owner and keep the old append-oriented mental model alive. |
| Move queue rendering into bash | Reject | `architecture-event.ts` already owns structured parsing and deterministic markdown generation. |
| Turn freshness strict now | Defer | The queue has strict mode tests, but finish-time diff/capability intersection belongs to slice 2. |
| Stop after four derived cards | Reject | The sprint acceptance also required an agent resolve pass; resolving now leaves the real queue clean. |

## Open Questions

- Slice 2 must decide the exact finish-time diff source and how advisory warnings should be formatted for developer ergonomics.
- Slice 3 should confirm whether generated downstream repos default to advisory or off if queue warnings prove noisy.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Review: `tasks/reviews/20260612-0318-arch-doc-loop-01-queue-engine-triage.review.md`
- Queue tests: `tests/architecture-queue.test.ts`

## Promotion Candidates

- The PostToolUse rule is now explicit: hooks record drift and remain advisory; finish/check gates own blocking.
- The architecture request directory invariant is now explicit: root files are live pending cards, archives hold resolved or superseded history.
