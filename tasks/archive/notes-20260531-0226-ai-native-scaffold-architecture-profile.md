> **Archived**: 2026-05-31 02:26
> **Related Plan**: plans/archive/plan-20260531-0032-ai-native-scaffold-architecture-profile.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260531-0226

# Implementation Notes: ai-native-scaffold-architecture-profile

> **Status**: Active
> **Plan**: plans/plan-20260531-0032-ai-native-scaffold-architecture-profile.md
> **Contract**: tasks/contracts/ai-native-scaffold-architecture-profile.contract.md
> **Review**: tasks/reviews/ai-native-scaffold-architecture-profile.review.md
> **Last Updated**: 2026-05-31 00:54
> **Lifecycle**: notes

## Design Decisions

- Kept A-K as the only project-type catalog. AI-native behavior is represented by `ai_native_profile` in `assets/initializer-question-pack.v4.json` and `aiNativeOverlayDefaults` in `assets/plan-map.json`.
- Default profile is `none`; generated Plan C output remains unchanged unless `AI_NATIVE_PROFILE` is explicitly supplied to template assembly.
- Implemented generated structure overlays only for `runtime-console`, `product-copilot`, and `sidecar-kernel`. The remaining profile taxonomy is metadata/documentation until generated files are needed.
- Routed profile rendering through `scripts/assemble-template.ts` so templates get a single profile summary, tech-stack rows, and optional project-structure overlay. Unknown profile IDs fail fast.
- Kept A2UI as optional/experimental payload schema language and kept Python/Go/Rust behind MCP or narrow HTTP sidecar boundaries.

## Deviations From Plan Or Spec

- Did not add a public `--ai-native-profile` CLI flag. The existing template assembly CLI already supports `--var AI_NATIVE_PROFILE=...`, and the public scaffold decision is owned by the question pack.
- Did not make `runtime-console` the global default. It is a recommended advanced overlay for Plan C/D/K, while `none` preserves backward-compatible scaffold output.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Add another plan code | Rejected | AI-native cuts across Plan C, D, E, J, and K; adding another letter would multiply the catalog. |
| Generate every profile structure | Rejected | Only three overlays had concrete structure requirements in the accepted plan; metadata covers the rest without pretending they are implementation-ready. |
| Install model/provider/tracing dependencies | Rejected | The scaffold should define boundaries first; credentials and providers are product-specific. |
| Use profile overlay variables | Accepted | This is the smallest change that keeps plan defaults stable and lets generated docs describe agent runtime boundaries when selected. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Focused verification: `bun test tests/initializer-question-pack.test.ts tests/plan-map-consistency.test.ts tests/output-parity.test.ts tests/scaffold-parity.test.ts tests/unit/ai-native-scaffold-architecture-profile.test.ts`
- Full verification: `bun test`
- Workflow verification: `bash scripts/check-deploy-sql-order.sh`; `bash scripts/check-task-sync.sh`; `bash scripts/check-task-workflow.sh --strict`; `bun scripts/inspect-project-state.ts --repo . --format text`; `bash scripts/migrate-project-template.sh --repo . --dry-run`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
