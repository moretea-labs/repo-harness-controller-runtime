> **Archived**: 2026-05-30 15:55
> **Related Plan**: plans/archive/plan-20260530-1529-think-users-ancienttwo-agents-skillsthink-skill-md.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260530-1555

# Implementation Notes: think-users-ancienttwo-agents-skillsthink-skill-md

> **Status**: Active
> **Plan**: plans/plan-20260530-1529-think-users-ancienttwo-agents-skillsthink-skill-md.md
> **Contract**: tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md
> **Review**: tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md
> **Last Updated**: 2026-05-30 15:31
> **Lifecycle**: notes

## Design Decisions

- ...

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| ... | ... | ... |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
# Implementation Notes: CodeGraph structural-first discovery nudge + Bash scope signals

## Decisions

- Reuse `trace-event.sh` for CodeGraph usage detection instead of adding a new
  route/script. The trace path already observes every PostToolUse event and
  already resolves `tool_name` and session identity.
- Keep the prompt nudge advisory-only and one-shot per session. The target
  behavior is better agent routing, not enforcement or token accounting.
- Keep Bash scope detection evidence-only. Shell is still a primary execution
  surface for Codex and hook debugging, so this slice must not block commands.

## Deviations

- The generated contract scaffold was narrowed before implementation. The
  default scaffold allowed broad `src/` edits and contained placeholder exit
  criteria; this slice only needs hook files, mirrored assets, and focused tests.

## Tradeoffs

- A broader non-trivial prompt detector can catch more missed CodeGraph starts,
  but risks noise. The one-shot `.nudged` marker bounds that risk.
- Broad Bash classification is intentionally conservative. False negatives are
  acceptable for this first evidence layer; false positives remain low-impact
  because no command is blocked.

## Open Questions

- None blocking. If future evidence shows frequent broad shell exploration after
  a nudge, a stronger advisory or scoped PreToolUse Bash hint can be planned
  separately.
