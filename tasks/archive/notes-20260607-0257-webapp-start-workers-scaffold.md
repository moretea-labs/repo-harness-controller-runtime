> **Archived**: 2026-06-07 02:57
> **Related Plan**: plans/archive/plan-20260607-0216-webapp-start-workers-scaffold.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260607-0257

# Implementation Notes: webapp-start-workers-scaffold

> **Status**: Completed
> **Plan**: plans/plan-20260607-0216-webapp-start-workers-scaffold.md
> **Contract**: tasks/contracts/20260607-0216-webapp-start-workers-scaffold.contract.md
> **Review**: tasks/reviews/20260607-0216-webapp-start-workers-scaffold.review.md
> **Last Updated**: 2026-06-07 02:54
> **Lifecycle**: notes

## Design Decisions

- Keep `webappRenderingModel` as an overlay on the existing A-K plan catalog. Plan C now defaults to `start-workers`, while Plan B remains `client-only`; no Plan L was added.
- Let `scripts/assemble-template.ts` resolve webapp rendering before AI-native overlays so Plan C/Plan D/Plan E can carry Start/Workers structure and still compose with later AI-native project overlays.
- Guard project-structure injection against duplicate structure text. Plan C already names `assets/project-structures/tanstack-start-workers.txt` as its base structure, so the overlay should not append the same file again.
- Keep agent-facing Cloudflare notes compact enough to preserve the existing generated AGENTS line budget.

## Deviations From Plan Or Spec

- Focused tests initially failed because Plan C rendered the Start/Workers project structure twice and pushed the AGENTS target over its line-count budget. The fix was to de-duplicate overlay structure injection and tighten the agents Cloudflare partial.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Add a new Plan L | Rejected | The existing A-K plan catalog remains the project-type authority; rendering/deploy shape is a cross-cutting overlay. |
| Split `apps/marketing` + `apps/web` by default | Rejected | The contract requires one `apps/web` frontend for SaaS SEO/SSR plus authenticated workspace routes. |
| Remove Plan C project structure file | Rejected | Plan C should still have a concrete Start/Workers structure; the real bug was duplicate overlay append. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Focused verification: `bun test tests/plan-map-consistency.test.ts tests/initializer-question-pack.test.ts tests/output-parity.test.ts tests/scaffold-parity.test.ts tests/unit/webapp-start-workers-scaffold.test.ts` -> 51 pass / 0 fail
- Full verification: `bun test` -> 579 pass / 6 skip / 0 fail

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
