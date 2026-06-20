> **Archived**: 2026-06-12 05:38
> **Related Plan**: plans/archive/plan-20260612-0453-arch-doc-loop-03-productize-assets.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-0538

# Implementation Notes: arch-doc-loop-03-productize-assets

> **Status**: Active
> **Plan**: plans/plan-20260612-0453-arch-doc-loop-03-productize-assets.md
> **Contract**: tasks/contracts/20260612-0453-arch-doc-loop-03-productize-assets.contract.md
> **Review**: tasks/reviews/20260612-0453-arch-doc-loop-03-productize-assets.review.md
> **Last Updated**: 2026-06-12 05:03 +0800
> **Lifecycle**: notes

## Design Decisions

- Productized the queue/freshness surfaces through the existing workflow contract and helper-template inventory. This keeps downstream scaffolds on the same install path as other repo-harness helper scripts.
- Kept the default downstream freshness gate advisory. Strict mode remains a policy flip after a repo proves the signal/noise ratio, matching slice 2's gate design.
- Seeded `docs/architecture/index.md` with explicit architecture pending BEGIN/END markers so `architecture-queue.sh reindex` has a stable controlled block in fresh scaffolds.
- Added `architecture-drift.sh` to retired-removal for both `scripts/` and `assets/templates/helpers/` so migrated repos remove legacy copies instead of carrying two queue engines.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Put new scripts only in `scripts/` | Rejected | New repos and migrations would miss the queue/freshness helpers. |
| Add a second installer path for architecture helpers | Rejected | The workflow contract already owns helper script inventory and chmod behavior. |
| Make downstream freshness strict by default | Rejected | Slice 2 deliberately established advisory-first rollout while signal quality is still being observed. |
| Keep `architecture-drift.sh` as compatibility shim | Rejected | The accepted architecture is one queue CLI; retired-removal gives the compatibility migration path without preserving duplicate runtime logic. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Focused productization tests: `bun test tests/workflow-contract.test.ts tests/create-project-dirs.runtime.test.ts tests/migration-script.test.ts tests/scaffold-parity.test.ts tests/bootstrap-files.test.ts`
- Full test suite: `bun test`
- Required checks: `bash scripts/check-deploy-sql-order.sh`, `bash scripts/check-architecture-sync.sh`, `bash scripts/check-task-sync.sh`, `bash scripts/check-task-workflow.sh --strict`, `bun scripts/inspect-project-state.ts --repo . --format text`, `bash scripts/migrate-project-template.sh --repo . --dry-run`
- Fresh scaffold smoke: `/tmp` scaffold contained `scripts/architecture-queue.sh`, `scripts/check-architecture-sync.sh`, advisory policy, and architecture pending markers; it did not contain `scripts/architecture-drift.sh`.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
