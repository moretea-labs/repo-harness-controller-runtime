> **Archived**: 2026-06-12 04:33
> **Related Plan**: plans/archive/plan-20260612-0350-loop-engine-02-routing-ab-eval.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-0433

# Implementation Notes: loop-engine-02-routing-ab-eval

> **Status**: Active
> **Plan**: plans/plan-20260612-0350-loop-engine-02-routing-ab-eval.md
> **Contract**: tasks/contracts/20260612-0350-loop-engine-02-routing-ab-eval.contract.md
> **Review**: tasks/reviews/20260612-0350-loop-engine-02-routing-ab-eval.review.md
> **Last Updated**: 2026-06-12 11:42 +0800
> **Lifecycle**: notes

## Design Decisions

- The eval is a shadow comparison only. The A arm calls `runPromptGuardVerdictFromPrompt` with scenario-specific state env, while the B arm is supplied by the benchmark agent from `docs/reference-configs/loop-engine-nl-decision-table.md`.
- The scenario pack hides expected answers; the report generator compares an agent-authored `decisions` array against current expected route behavior and turns missing/mismatched decisions into no-go evidence.
- Token delta is an approximate per-prompt comparison of snapshot+NL-table bytes against the current TS verdict JSON. It is a screening metric, not a billing ledger.
- The benchmark grader validates report shape and metrics, not mandatory `go`. A no-go report is still useful proof-point evidence.
- Current rerun evidence changes G1 from owner-override go to no-go. Codex with_skill can produce exact enum actions, but Claude direct non-dry-run emits semantically equivalent action phrases such as `enter_done_gate` and `capture_pending_plan`; the evaluator records those as mismatches because the cutover path needs stable machine action vocabulary.

## Deviations From Plan Or Spec

- The original row 2 closeout used an owner override to skip Claude. The current verification removed that shortcut: Claude CLI smoke passed, the full benchmark wrapper stalled without writing artifacts, and a direct Claude non-dry-run against the same NL table/scenario pack produced valid decisions that evaluate to no-go.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Change runtime prompt-guard routing now | Rejected | Row 2 is evidence-only; runtime behavior belongs to row 3/7 gates. |
| Require `go` in benchmark grader | Rejected | The sprint needs decisive evidence; no-go must be representable as a passing benchmark artifact. |
| Normalize Claude's semantically equivalent actions in row 2 | Rejected | Normalization belongs in the no-go repair slice; row 2 should report the gap instead of hiding it. |
| Put reports under tracked source | Rejected | `.ai/harness/runs/` is the established ignored run-snapshot surface. |

## Open Questions

- The next Track A slice should repair the action vocabulary/output schema before any shadow injection. Until then TS remains authoritative.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Codex benchmark manifest: `/Users/chris/Projects/repo-harness-workspace/iteration-20260612-112618-route-nl-vs-ts-codex-rerun/manifest.json`
- Codex route report: `/Users/chris/Projects/repo-harness-workspace/iteration-20260612-112618-route-nl-vs-ts-codex-rerun/codex/with_skill/route-nl-vs-ts/.ai/harness/runs/route-nl-vs-ts-report.json`
- Claude route report: `.ai/harness/runs/route-nl-vs-ts-claude-report.json`
- Local run snapshots: `.ai/harness/runs/route-nl-vs-ts-report.json`, `.ai/harness/runs/loop-engine-02-routing-ab-eval.json`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
