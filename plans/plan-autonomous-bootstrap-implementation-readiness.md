---
title: "Autonomous Bootstrap Implementation Readiness"
kind: "plan"
created_at: "2026-07-06T14:21:52.000Z"
source: "repo-harness-mcp"
---
# Autonomous Bootstrap Implementation Readiness

## Ready inputs

- PRD: `plans/prds/autonomous-local-repo-bootstrap-ios-loops.prd.md`
- Sprint: `plans/sprints/autonomous-bootstrap-ios-loop.sprint.md`
- Codex goal: `.ai/harness/handoff/codex-goal.md`
- Evidence: `plans/plan-tinymoments17-pulse-onboarding-evidence.md`
- DeepSeek notes: `plans/plan-deepseek-capability-notes.md`

## Priority order

1. Implement local source diagnosis.
2. Implement structured local project bootstrap.
3. Implement TinyMoments 1.7 stale registration replacement path.
4. Harden active schedule dispatch from daemon side.
5. Add staged iOS review status.
6. Wire prepare-only backup model fallback.

## User intent

The user wants repo-harness to keep working without stopping for repeated confirmation. Use structured authorization and policy once, then let daemon-owned safe loops proceed within configured budgets and stop conditions. Escalate only destructive, sensitive, or ambiguous cases.

## Known constraints

- Do not bypass platform safety checks.
- Do not mutate external project directories through arbitrary shell commands.
- Add first-class structured actions instead.
- DeepSeek is enabled but not configured; fallback must be prepare-only until configured.
