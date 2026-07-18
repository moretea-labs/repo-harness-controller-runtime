# Task Review: fix-mcp-session-lifecycle

> **Status**: Passed
> **Plan**: plans/plan-20260718-1452-fix-mcp-session-lifecycle.md
> **Contract**: tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md
> **Notes File**: tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-07-18 16:18
> **Recommendation**: pass

## Human Review Card

- Verdict: pass for source integration; production rollout remains a separate operator action.
- Change type: code-change
- Intended files changed: MCP HTTP transport/session registry, Stable Supervisor ingress/runtime, focused tests, architecture/operations/task contracts.
- Actual files changed: matches intended scope; no `_ops` or live-runtime state changed.
- Commands passed: focused 35-test suite, `bunx tsc --noEmit`, deploy SQL order, architecture sync, task sync, strict workflow, project-state inspection, migration dry-run, capability resolver.
- External acceptance: unavailable; Claude Opus ran read-only but failed its structured-output contract after five retries.
- Residual risks: the currently running production release is unchanged until an explicit rollout.
- Reviewer action required: inspect the staged aggregate diff and approve rollout separately.
- Rollback: discard this isolated worktree/branch before integration, or retain the previous immutable Supervisor release after deployment.

## Mode Evidence

- Selected route: implementation-first, focused capability verification, then full local multi-lens review.
- P1/P2/P3 evidence: atomic admission, unsafe identity supersession, shared-bearer quota, and overlapping ingress recovery findings were fixed and retested.
- Root cause or plan evidence: live runtime showed 64/64 retained SSE sessions, zero active POSTs, rejected initialize, and falsely healthy readiness.

## Verification Evidence

- Waza `/check` run: unavailable in this checkout; root-equivalent required commands were run directly.
- Commands run:
  - `bun test tests/unit/fix-mcp-session-lifecycle.test.ts tests/cli/mcp-http.test.ts tests/runtime/stable-supervisor-hardening.test.ts tests/runtime/stable-supervisor-integration.test.ts` (35 pass)
  - `bunx tsc --noEmit`
  - all root required non-suite checks from `AGENTS.md`
- Manual checks: verified one global registry across all three routes, registry-owned initialize reservations, explicit-only supersession, shared-bearer global capacity, separate ingress PID, and serialized monitor ticks.
- Supporting artifacts: ADR and capability module documents linked by the plan.
- Implementation notes reviewed: yes.
- Run snapshot: source worktree only; no live deployment performed.

## External Acceptance Advice

> **External Acceptance**: unavailable
> **External Reviewer**: Claude Opus (read-only cross-model adversarial route)
> **External Source**: local Claude Code CLI
> **External Started**: 2026-07-18 15:26 +0800
> **External Completed**: 2026-07-18 15:32 +0800

- P1 blockers: none remaining after local review fixes and focused retest.
- P2 advisories: production monitoring and rollback validation remain rollout responsibilities.
- Acceptance checklist: deploy immutable release, verify `/health` and `/ready`, watch session utilization/close reasons/oldest POST age, roll back on repeated recovery or active-work interruption.

## Behavior Diff Notes

- Session capacity is globally owned across `/mcp`, `/mcp-grok`, and `/mcp-bearer`.
- Initialize admission is atomic; active initialization and POST work cannot be reclaimed.
- Only an explicitly supplied, authorized prior session may be superseded.
- Stream-only state is bounded by DELETE, lease/lifetime expiry, or oldest-safe eviction.
- Stable ingress runs in a separate child process and monitor recovery is serialized.

## Residual Risks / Follow-ups

- Source completion does not repair the live process until the new release is deployed.
- The full repository suite reported 1691 pass plus two baseline failures: one duplicate contradictory completion-orchestrator test and one full-suite-only 5-second local-bridge timeout that passes alone. Neither file is changed by this task.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | Root failure path covered; rollout not yet performed. |
| Product depth | 9/10 | Fix addresses lifecycle, readiness, capacity, and process isolation together. |
| Design quality | 9/10 | One ownership model and explicit control/data-plane boundaries. |
| Code quality | 9/10 | Review findings applied; focused tests and type checks pass. |

## Failing Items

- No task-scope failing item remains.

## Retest Steps

- Re-run the focused 35-test command and `bunx tsc --noEmit`.
- After rollout, repeat a reconnect storm and confirm session count remains bounded while `/ready` truthfully reports saturation/recovery.

## Summary

- Recommend integrating the source change. Production deployment requires a separate explicit operation and monitoring window.
