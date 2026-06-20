# Plan: CodeGraph structural-first discovery nudge + Bash scope signals

> **Status**: Archived
> **Created**: 20260530-1529
> **Slug**: think-users-ancienttwo-agents-skillsthink-skill-md
> **Planning Source**: waza-think
> **Orchestration Kind**: waza-think
> **Source Ref**: /Users/ancienttwo/.agents/skills/think/SKILL.md
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`
> **Sprint Review**: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`
> **Implementation Notes**: `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: /Users/ancienttwo/.agents/skills/think/SKILL.md
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260530-1529-think-users-ancienttwo-agents-skillsthink-skill-md.md`
- Sprint contract: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`
- Sprint review: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`
- Implementation notes: `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260530-1529-think-users-ancienttwo-agents-skillsthink-skill-md.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260530-1529-think-users-ancienttwo-agents-skillsthink-skill-md.md`.

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
- Contract file: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`
- Review file: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`
- Implementation notes file: `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260530-1529-think-users-ancienttwo-agents-skillsthink-skill-md.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`, `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`, and `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260530-1529-think-users-ancienttwo-agents-skillsthink-skill-md.md`; after execution revert branch `codex/think-users-ancienttwo-agents-skillsthink-skill-md` or the generated task artifacts

## Captured Planning Output

# CodeGraph structural-first discovery nudge + Bash scope signals

## Outcome

Build a small agent-efficiency layer on top of the existing repo-harness hook + CodeGraph architecture. The goal is not token reduction as a KPI; the goal is to help coding agents establish the right structural code map earlier, avoid repeated broad exploration, and leave better evidence for broad Bash usage.

## Scope

- Add session-local CodeGraph usage and nudge markers under ignored `.claude/.codegraph-state/`.
- Reuse the existing `PostToolUse.always` trace path to mark CodeGraph usage.
- Upgrade the existing CodeGraph prompt hint in `prompt-guard.sh` into a one-shot, stateful nudge.
- Extend `post-bash.sh` evidence with broad-command metadata.
- Mirror all hook changes between `.ai/hooks/` and `assets/hooks/`.
- Extend focused hook tests for one-shot behavior, marker behavior, Bash metadata, and parity.

## Non-Scope

- Do not make token reduction the success metric.
- Do not hard-block `cat`, `rg`, `find`, `sed`, or shell usage.
- Do not add Headroom, Caveman, RTK, context-mode, or any new runtime dependency.
- Do not add a new hook route or change `src/cli/hook/route-registry.ts`.
- Do not change user-level host adapter command shape in `~/.codex/hooks.json` or `~/.claude/settings.json`.
- Do not trigger Codex trust hash churn.

## P1 Map

Current authority boundaries:

- User-level adapters are the real host entrypoints: `~/.codex/hooks.json` and `~/.claude/settings.json`.
- Public hook route authority is `src/cli/hook/route-registry.ts`.
- Hook runtime dispatch authority is `src/cli/hook/runtime.ts` and the minimal hot-path `src/cli/hook-entry.ts`.
- Repo-local hook implementation lives in `.ai/hooks/*.sh`, mirrored to `assets/hooks/*.sh` for installable assets.
- CodeGraph readiness/configuration lives in `src/cli/tools/codegraph.ts` and `docs/reference-configs/external-tooling.md`.
- CodeGraph is currently ready, but its use is mostly discipline/documentation-driven rather than runtime-feedback-driven.

## P2 Trace

Target path:

1. `PostToolUse.always` runs `trace-event.sh` first.
2. `trace-event.sh` already derives `tool_name` and `session_key`.
3. If `tool_name` matches `mcp__codegraph__*` or `codegraph_*`, it marks `.claude/.codegraph-state/<session>.used`.
4. `UserPromptSubmit.default` runs `prompt-guard.sh`.
5. `prompt-guard.sh` resolves the same session key.
6. If `.used` exists, CodeGraph hint is silent.
7. If `.nudged` exists, CodeGraph hint is silent.
8. If the prompt is explicit structural exploration or a non-trivial code task, `prompt-guard.sh` emits one short `[CodegraphRoute]` nudge and writes `.nudged`.
9. `PostToolUse.bash` runs `post-bash.sh`, classifies obvious broad Bash commands, and writes metadata into the latest post-bash checks JSON without blocking execution.

## P3 Decision Rationale

Use a soft advisory state machine, not a hard gate. This preserves Codex shell-first workflows, avoids false blocks in hook/debug work, and keeps the existing stdout protocol safety intact. The implementation should prefer the existing `trace-event.sh` path over a new marker script because trace already observes every tool call and already has the needed session/tool data.

## Key Decisions

1. Reuse `trace-event.sh` for CodeGraph usage markers instead of adding a new `codegraph-discovery-marker.sh`.
2. Keep the nudge one-shot per session to bound noise even if the trigger surface is widened.
3. Treat CodeGraph usage markers as ignored runtime state, not durable memory.
4. Treat broad Bash classification as evidence only; never block shell commands in this slice.
5. Keep all changes inside existing route scripts and mirrored assets; no adapter or route registry churn.

## File Changes

| File | Action | Description |
| --- | --- | --- |
| `.ai/hooks/lib/session-state.sh` | edit | Add `session_state_codegraph_dir`, mark/test helpers for `.used` and `.nudged`. |
| `assets/hooks/lib/session-state.sh` | edit | Mirror session-state helper changes. |
| `.ai/hooks/trace-event.sh` | edit | Mark CodeGraph used when observed tool name matches `mcp__codegraph__*` or `codegraph_*`; failures must not break tracing. |
| `assets/hooks/trace-event.sh` | edit | Mirror trace marker change. |
| `.ai/hooks/prompt-guard.sh` | edit | Upgrade existing CodeGraph hint to stateful one-shot nudge with carve-outs. |
| `assets/hooks/prompt-guard.sh` | edit | Mirror prompt guard change. |
| `.ai/hooks/post-bash.sh` | edit | Add `broad_command`, `output_line_count`, and `recommended_next_tool` metadata. |
| `assets/hooks/post-bash.sh` | edit | Mirror post-bash metadata change. |
| `tests/hook-runtime.test.ts` | edit | Add one-shot CodeGraph nudge, used-marker silence, and broad Bash evidence tests where existing harness fits. |
| `tests/hook-contracts.test.ts` / `tests/scaffold-parity.test.ts` / `tests/output-parity.test.ts` | verify/edit only if needed | Ensure hooks and mirrored assets remain in sync. |

## Trigger Rules

Nudge when:

- The prompt explicitly asks for structural exploration: callers, callees, impact, trace, dependency path, architecture path, module boundary, route/runtime chain.
- The prompt is a non-trivial code task likely to cross files: bug hunt, shared contract change, architecture/hook/runtime work, multi-file refactor, implementation plan that touches code.

Do not nudge when:

- The prompt is pure plan discussion or pending plan capture.
- The prompt is a diagnostic question about the hook/workflow itself and does not ask to implement.
- The prompt is pure git/status/release bookkeeping.
- The prompt is pure prose or small one-file text edit.
- The session already has `.used` or `.nudged` marker.

## Bash Scope Signals

First version is intentionally conservative. Flag only obvious broad commands:

- `find .` / `find ./` broad tree scans.
- `ls -R`.
- bare `rg <pattern>` or `grep -R <pattern>` with no path/glob constraint.
- `cat` on globs, directories, or multiple files.

Write metadata only. Do not emit blocking exits. If a recommendation is useful, write `recommended_next_tool` such as `codegraph_context` or `codegraph_search`; stdout advisory is optional and secondary because Codex non-SessionStart stdout is protocol-sensitive.

## Rejected Alternatives

- New `codegraph-discovery-marker.sh` plus route insertion: same behavior with larger route/parity/test churn.
- Hard `bash-ban-raw-tools`: too risky for Codex shell-first work, hook script debugging, and required checks.
- Headroom/Caveman/context-mode/RTK: user-level runtime/proxy/style changes outside repo-harness contract and not necessary for the desired agent-efficiency improvement.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Prompt nudge becomes noisy | Medium | Medium | One-shot `.nudged` marker and conservative carve-outs. |
| Tool name is missing for CodeGraph MCP calls | Medium | Low | Degrades to one-shot nudge only; workflow remains unblocked. |
| Broad Bash regex misclassifies useful commands | Medium | Low | Evidence-only metadata; no block. Keep first regex conservative. |
| Existing dirty worktree causes mixed implementation diff | High in current checkout | High | Before implementation, confirm or isolate current unrelated changes. Do not mix this slice into existing dirty changes without ownership clarity. |
| Hook stdout protocol regression | Low | High | Keep non-SessionStart additions mostly file-based; focused hook protocol tests. |

## Verification

Focused checks:

```bash
bun test tests/hook-runtime.test.ts tests/hook-contracts.test.ts tests/hook-protocol.test.ts tests/scaffold-parity.test.ts tests/output-parity.test.ts
bun test tests/cli/codegraph.test.ts tests/tooling/codegraph-integration.test.ts
```

Required repo checks:

```bash
bun test
bash scripts/check-deploy-sql-order.sh
bash scripts/check-task-sync.sh
bash scripts/check-task-workflow.sh --strict
bun scripts/inspect-project-state.ts --repo . --format text
bash scripts/migrate-project-template.sh --repo . --dry-run
```

Manual smoke:

```bash
repo-harness doctor --json
printf '{"prompt":"帮我排查这个 hook 为什么不触发，跨多个文件","hook_event_name":"UserPromptSubmit"}' | HOOK_HOST=codex bash .ai/hooks/prompt-guard.sh
HOOK_TOOL_NAME=mcp__codegraph__codegraph_context bash .ai/hooks/trace-event.sh
printf '{"tool_input":{"command":"rg foo"},"exit_code":0}' | bash .ai/hooks/post-bash.sh
```

## Success Criteria

- Non-trivial code tasks get at most one CodeGraph nudge per session.
- Any observed CodeGraph tool call silences future nudges in the same session.
- Plan discussion, diagnostic questions, small tasks, pure git, and pure prose remain silent.
- `post-bash-latest.json` includes broad-command metadata without blocking execution.
- `.ai/hooks` and `assets/hooks` remain mirrored.
- `ROUTES`, global adapter command shape, and trust hash surface remain unchanged.
- Codex non-SessionStart stdout protocol remains safe.

## Rollback

Rollback is file-only: revert the four hook script pairs and associated tests, then delete ignored `.claude/.codegraph-state/` if desired. No route, adapter, MCP, or external runtime state should need rollback.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Execute captured plan: CodeGraph structural-first discovery nudge + Bash scope signals
