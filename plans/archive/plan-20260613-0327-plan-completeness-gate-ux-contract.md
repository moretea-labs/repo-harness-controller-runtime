# Plan: PlanCompletenessGate UX contract

> **Status**: Archived
> **Created**: 20260613-0327
> **Slug**: plan-completeness-gate-ux-contract
> **Planning Source**: codex-plan
> **Orchestration Kind**: codex-plan
> **Source Ref**: user agreed to next slice after diagnosing Stop gate UX
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Sprint Contract**: `tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md`
> **Sprint Review**: `tasks/reviews/20260613-0327-plan-completeness-gate-ux-contract.review.md`
> **Implementation Notes**: `tasks/notes/20260613-0327-plan-completeness-gate-ux-contract.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from codex-plan planning output.
- Source ref: user agreed to next slice after diagnosing Stop gate UX
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260613-0327-plan-completeness-gate-ux-contract.md`
- Sprint contract: `tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md`
- Sprint review: `tasks/reviews/20260613-0327-plan-completeness-gate-ux-contract.review.md`
- Implementation notes: `tasks/notes/20260613-0327-plan-completeness-gate-ux-contract.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260613-0327-plan-completeness-gate-ux-contract.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260613-0327-plan-completeness-gate-ux-contract.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md`
- Review file: `tasks/reviews/20260613-0327-plan-completeness-gate-ux-contract.review.md`
- Implementation notes file: `tasks/notes/20260613-0327-plan-completeness-gate-ux-contract.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260613-0327-plan-completeness-gate-ux-contract.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md`, `tasks/reviews/20260613-0327-plan-completeness-gate-ux-contract.review.md`, and `tasks/notes/20260613-0327-plan-completeness-gate-ux-contract.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260613-0327-plan-completeness-gate-ux-contract.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260613-0327-plan-completeness-gate-ux-contract.md`; after execution revert branch `codex/plan-completeness-gate-ux-contract` or the generated task artifacts

## Captured Planning Output

## Summary
Fix the Stop-stage PlanCompletenessGate UX so a pending Waza/Codex planning answer gets a precise capture instruction instead of a generic self-review interruption, while preserving the one-shot guard and the plans/ source-of-truth invariant.

## Scope
- Update Stop hook gate output for fresh pending orchestration with a known slug/source/draft path.
- Keep the gate read-only except for its existing one-shot signature record.
- Mirror the runtime hook change into assets/hooks so installed copies stay in parity.
- Update focused hook runtime tests to assert the clearer capture guidance.

## Non-Scope
- Do not remove PlanCompletenessGate.
- Do not auto-capture assistant messages from the Stop hook.
- Do not change UserPromptSubmit planning classification.
- Do not implement the separate init-hook feature.
- Do not edit user-level ~/.codex or ~/.claude hook configs.

## P1 Map
- .ai/hooks/prompt-guard.sh creates pending orchestration with workflow_write_pending_orchestration after explicit think/plan starts.
- .ai/harness/planning/pending.json is the bridge from transient host planning to repo-local plan capture.
- .ai/hooks/stop-orchestrator.sh owns Stop handoff refresh and the one-shot PlanCompletenessGate.
- scripts/capture-plan.sh owns the authoritative plans/ artifact and clears pending orchestration after successful capture.
- assets/hooks/stop-orchestrator.sh is the product/template mirror of the live hook.
- tests/hook-runtime.test.ts is the behavior surface for Stop hook planning completeness.

## P2 Trace
A $think planning prompt creates a Draft plan and pending.json. The assistant produces a plan-like answer, but no active plan exists until capture-plan.sh writes the final body into plans/ and active markers. On Stop, stop-orchestrator sees fresh pending orchestration, no active plan, and a plan-like last assistant message, records the signature, and blocks once. The fix changes only the emitted guidance so the agent can capture the final plan directly when it is complete or revise once if incomplete.

## P3 Decision Rationale
Keep the guard because it protects the repo source of truth: transient host messages must not become implementation authority without plans/. The current failure is UX/control-flow friction, not an invariant failure. The smallest coherent change is to improve the Stop message and tests, not to remove the gate or add automatic capture to a veto hook.

## Fragile Assumption
This assumes the host cannot safely pass the full assistant plan body into a deterministic capture script from Stop without agent judgment. If that changes, a future orchestration layer could capture directly, but that is out of scope here.

## Rejected Alternative
Auto-run capture-plan.sh from stop-orchestrator. Rejected because Stop hook does not own semantic validation of plan completeness and would turn a veto hook into a mutating orchestration engine.

## Public API / File Interface Changes
No new command or config. The observable hook output for PlanCompletenessGate changes to include concrete capture guidance derived from pending.json: slug, title/source ref, source, orchestration kind, and status choice.

## Verification
- bun test tests/hook-runtime.test.ts -t "stop-orchestrator: blocks once to force pending plan completeness review"
- bun test tests/hook-runtime.test.ts -t "stop-orchestrator: skips recursive Stop continuations and supports Codex block JSON"
- bash -n .ai/hooks/stop-orchestrator.sh assets/hooks/stop-orchestrator.sh

## Rollback / Failure Handling
Rollback is a normal git revert of .ai/hooks/stop-orchestrator.sh, assets/hooks/stop-orchestrator.sh, and tests/hook-runtime.test.ts. No data or external state is changed.

## Task Breakdown
- [x] Patch runtime Stop gate message to include concrete capture guidance and preserve one-shot behavior.
- [x] Mirror the patch to assets/hooks/stop-orchestrator.sh.
- [x] Update focused hook runtime assertions for the clearer UX.
- [x] Run focused tests and shell syntax checks.
- [x] Fix linked-worktree hook-runtime fixture dependency resolution and rerun the full hook-runtime suite.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Patch runtime Stop gate message to include concrete capture guidance and preserve one-shot behavior.
- [x] Mirror the patch to assets/hooks/stop-orchestrator.sh.
- [x] Update focused hook runtime assertions for the clearer UX.
- [x] Run focused tests and shell syntax checks.
- [x] Fix linked-worktree hook-runtime fixture dependency resolution and rerun the full hook-runtime suite.
