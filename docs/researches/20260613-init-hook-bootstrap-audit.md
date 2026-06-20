# Research Note: Init Hook Bootstrap Audit

> **Date**: 2026-06-13
> **Status**: Implementation support
> **Source**: `src/cli/commands/init-hook.ts`, `src/cli/commands/doctor.ts`, `scripts/check-agent-tooling.sh`

## Judgment

`repo-harness init-hook` should be a read-only Agent bootstrap audit, not a
runtime hook and not an installer. The command is useful when an Agent needs one
bounded readiness report before touching user-level hook adapters, global
working rules, CLI versions, or external tooling.

## Boundary

- It may run existing status, doctor, security, global-rule presence, tooling,
  and legacy adapter checks.
- It may emit `agent_actions` with a reason, risk, optional command, target
  files, and verification command.
- It must not write user-owned markdown, install packages, mutate host hook
  configs, or change repo-local workflow files.
- Version checks stay opt-in through `--check-updates` because they call npm and
  can imply global runtime updates.

## Verification Surface

- `bun test tests/cli/init-hook.test.ts tests/cli/doctor.test.ts tests/cli/init.test.ts`
- `repo-harness init-hook --target codex --json`
- `bash scripts/check-task-sync.sh`
