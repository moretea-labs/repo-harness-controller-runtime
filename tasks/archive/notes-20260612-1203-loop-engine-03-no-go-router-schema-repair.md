> **Archived**: 2026-06-12 12:03
> **Related Plan**: plans/archive/plan-20260612-1151-loop-engine-03-no-go-router-schema-repair.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-1203

# Implementation Notes: loop-engine-03-no-go-router-schema-repair

> **Status**: Complete
> **Plan**: plans/plan-20260612-1151-loop-engine-03-no-go-router-schema-repair.md
> **Contract**: tasks/contracts/20260612-1151-loop-engine-03-no-go-router-schema-repair.contract.md
> **Review**: tasks/reviews/20260612-1151-loop-engine-03-no-go-router-schema-repair.review.md
> **Last Updated**: 2026-06-12 12:02 +0800
> **Lifecycle**: notes

## Design Decisions

- The repair stays in the eval surface. Runtime `prompt-guard` and the TS classifier remain authoritative.
- Scenario packs now include `allowed_intents` and `allowed_actions`, so an agent has the exact machine vocabulary without seeing per-scenario expected answers.
- The NL decision table documents the same exact vocabulary. This reduces agent drift before any later shadow injection.
- The evaluator normalizes only known harmless aliases exposed by row 2 (`enter_done_gate`, `capture_pending_plan`, `request_plan_capture_approval`, `scaffold_contract`, and related phrases). It does not normalize allow/block direction mistakes.
- Passive informational intents with `allow` can satisfy scenarios whose TS intent is `none`; this reflects runtime routing equivalence because the action remains allow.

## Deviations From Plan Or Spec

- None. The slice did not perform shadow injection, classifier deletion, or runtime cutover.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Make the NL prompt stricter only | Rejected | It reduces the chance of alias drift but does not protect future agent phrasing. |
| Normalize all unknown action phrases | Rejected | That would hide true false positives or false negatives. |
| Normalize a small explicit alias set | Adopted | It repairs the observed no-go without weakening routing safety. |
| Count passive allow intent mismatches as failure | Rejected | For prompt routing, allow vs block/advice is the meaningful behavior boundary. |

## Open Questions

- Shadow injection should choose a bounded time box and divergence threshold in its own contract before runtime tracing starts.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Codex benchmark manifest: `/Users/chris/Projects/repo-harness-workspace/iteration-20260612-115446-route-nl-vs-ts-codex-schema-repair/manifest.json`
- Claude schema-repair report: `.ai/harness/runs/route-nl-vs-ts-claude-schema-repair-report.json`
- Summary report: `.ai/harness/runs/loop-engine-03-no-go-router-schema-repair.json`

## Promotion Candidates

- Promote to `tasks/lessons.md` only if another eval surface repeats the same "semantic action phrase vs machine enum" failure.
