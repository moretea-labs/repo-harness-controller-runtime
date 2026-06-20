> **Archived**: 2026-06-12 06:25
> **Related Plan**: plans/archive/plan-20260612-0538-arch-doc-loop-04-research-surface-migration.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-0625

# Implementation Notes: arch-doc-loop-04-research-surface-migration

> **Status**: Complete
> **Plan**: plans/plan-20260612-0538-arch-doc-loop-04-research-surface-migration.md
> **Contract**: tasks/contracts/20260612-0538-arch-doc-loop-04-research-surface-migration.contract.md
> **Review**: tasks/reviews/20260612-0538-arch-doc-loop-04-research-surface-migration.review.md
> **Last Updated**: 2026-06-12 06:07 +0800
> **Lifecycle**: notes

## Design Decisions

- Canonical research moved to `docs/researches/*.md`. Durable research is report-shaped repo knowledge, not active task state, so the new surface matches the existing `docs/reference-configs/` and architecture-doc model.
- `tasks/research.md` remains as a tombstone pointer to `docs/researches/` and `docs/researches/20260612-legacy-research-notes.md`. This preserves old links without letting the singleton continue as an append-only source of truth.
- ResearchGate derives freshness from the newest Markdown report under `docs/researches/`, excluding `README.md`. That preserves the existing "research must be fresh before plan creation" guard while supporting multiple report files.
- Scaffold and migration behavior now seed `docs/researches/README.md`; migration archives a legacy singleton to `docs/researches/legacy-research-notes.md` and rewrites the singleton as a tombstone.
- Active-reference cleanup intentionally allows legacy mentions in migration scripts, workflow contract migrations, archives, sprint/review/history files, and the new research archive. The invariant is no active canonical guidance points users to append to `tasks/research.md`.

## Deviations From Plan Or Spec

- The sprint row mentioned adding `tasks/research.md` to downstream retired-removal. The implemented behavior is migration-with-tombstone rather than deletion, because `tasks/research.md` is still a useful compatibility pointer for existing repos and old links.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Delete `tasks/research.md` | Rejected | Old links would fail hard and migrations could not explain the new surface in place. |
| Keep appending research to `tasks/research.md` | Rejected | It preserves the bad singleton and keeps durable repo knowledge under task workflow state. |
| One `docs/researches/research.md` file | Rejected | Multiple timestamped report files match the existing research reports already present in the repo. |
| Latest report mtime for ResearchGate | Adopted | It is simple, file-backed, and mirrors the previous singleton freshness semantics. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Canonical research README: `docs/researches/README.md`
- Legacy archive: `docs/researches/20260612-legacy-research-notes.md`

## Promotion Candidates

- Promote the research-surface rule to `tasks/lessons.md` only if another migration attempts to reintroduce durable knowledge under `tasks/`.
