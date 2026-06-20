> **Archived**: 2026-06-12 13:11
> **Related Plan**: plans/archive/plan-20260612-1239-loop-engine-05-contract-run-pilot.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-1311

# Implementation Notes: loop-engine-05-contract-run-pilot

> **Status**: Complete
> **Plan**: plans/plan-20260612-1239-loop-engine-05-contract-run-pilot.md
> **Contract**: tasks/contracts/20260612-1239-loop-engine-05-contract-run-pilot.contract.md
> **Review**: tasks/reviews/20260612-1239-loop-engine-05-contract-run-pilot.review.md
> **Last Updated**: 2026-06-12 12:48
> **Lifecycle**: notes

## Design Decisions

- `contract-run` is a repo-local helper, not a hook hot-path command. The host or parent session must pass explicit child commands with `--worker-command` and `--verifier-command`.
- Parent responsibility is orchestration only: read the contract, write worker/verifier prompts, run child commands, record logs/manifest, and stop before the next child when the budget is exhausted.
- The verifier prompt is intentionally limited to the contract `exit_criteria` block so review quality can be compared against the contract rather than a new free-form rubric.
- Budget enforcement starts with child-command count (`tool_calls`). This is the only reliable metric available before provider-specific child runner telemetry exists.

## Deviations From Plan Or Spec

- Added `.ai/harness/workflow-contract.json` to the contract allowed paths because the self-host runtime manifest must remain byte-for-byte in parity with `assets/workflow-contract.v1.json`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Default provider spawning | Deferred | Would force Claude/Codex runtime decisions before the runner contract is stable. |
| Explicit child commands | Chosen | Testable in temp repos and keeps responsibility at the repo-local helper boundary. |
| Token budget enforcement | Deferred | No trusted child telemetry exists in this slice. |
| Child-command count budget | Chosen | Provides a deterministic overrun gate and prevents accidental verifier execution after budget exhaustion. |

## Open Questions

- How provider-native child commands should pass token/tool telemetry into the manifest.
- Whether future `contract-run` should call `contract-worktree.sh finish` or remain a lower-level primitive that parent sessions compose.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Focused tests: `bun test tests/contract-run.test.ts`
- Manifest/install parity tests: `bun test tests/bootstrap-files.test.ts tests/migration-script.test.ts tests/workflow-contract.test.ts`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
