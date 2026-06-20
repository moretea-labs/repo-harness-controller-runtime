# Hooks Configuration Guide

Use this guide for hook configuration details and legacy migration context.

## Project Hook Source of Truth

- Repo-local `tasks/` files are the primary cross-agent contract.
- Repo-local `plans/` files are the plan catalog. `.ai/harness/active-plan` selects the active plan, with `.claude/.active-plan` as a legacy fallback during transition.
- Shared hook product source: `assets/hooks/`.
- Active hook runtime resolves central-first through `repo-harness-hook`; `.ai/hooks/` carries a full vendored runtime only when the repo pins `"hook_source": "repo"`.
- User-level Claude adapter: `~/.claude/settings.json`.
- User-level Codex adapter: `~/.codex/hooks.json`.
- Repo-local `.claude/settings.json` and `.codex/hooks.json` are legacy project-level adapters and should be retired during migration.
- Personal overrides only: `.claude/settings.local.json` (optional).
- Claude and Codex adapters dispatch into `repo-harness-hook` or the compatibility `repo-harness hook` route.
- Codex requires the user-level hook config to be trusted in Codex Settings before it runs.

Use hooks as advisory accelerators and deterministic guards, not as the only source of workflow enforcement.

## Hook Presets

### A) Balanced Shared Guardrails (recommended)
- Runtime profile: Plan-only (recommended), configurable to Permissionless/Standard.
- `PreToolUse (Edit|Write)`: worktree guard (warn by default, opt-in hard block), pre-edit guard (TDD/BDD + asset-layer reminders).
- `PostToolUse (Edit|Write)`: post-edit guard (doc drift + task handoff summary).
- `PostToolUse (Bash)`: post-bash advisory reminders.
- `PostToolUse (all tools)`: `post-tool-observer.sh` structured JSONL trace + lightweight advisories.
- `UserPromptSubmit`: prompt guard (plan sync + TDD/BDD reminders).
- `Stop`: finalize-handoff summary refresh.
- Automatic checkpoint commits are disabled in the shared default.

### B) Balanced + Release Guard
- Same as A, plus `changelog-guard.sh` for repos that want release reminders.

### C) Balanced + Advisory Extras
- Same as A, plus optional advisory hooks like `anti-simplification.sh` when teams explicitly want more reminders beyond the default trace and bash observers.

### D) Minimal
- `UserPromptSubmit` only.

### E) No Hooks
- Skip project-level hook config.

### F) Custom
- Define explicit matcher + command sets.

## Hook Files to Copy

| Asset File | Target Path |
|---|---|
| `assets/hooks/lib/` | `.ai/hooks/lib/` |
| generated fallback README | `.ai/hooks/README.md` |
| `assets/hooks/*.sh` | `.ai/hooks/*.sh` only when `"hook_source": "repo"` is pinned |

Bundled hook assets include:
- `assets/hooks/tdd-guard-hook.sh`
- `assets/hooks/pre-code-change.sh`
- `assets/hooks/anti-simplification.sh`
- `assets/hooks/post-bash.sh`
- `assets/hooks/changelog-guard.sh`
- `assets/hooks/session-start-context.sh`
- `assets/hooks/finalize-handoff.sh`
- `assets/hooks/worktree-guard.sh`
- `assets/hooks/atomic-pending.sh`
- `assets/hooks/atomic-commit.sh`
- `assets/hooks/trace-event.sh`

Retired hooks:

- `autoresearch-advisory.sh` is retired. It must not exist in `.ai/hooks`, be
  referenced by default adapter templates, or be installed into user-level
  Codex/Claude hook configs. Run autoresearch explicitly when evidence is
  needed.

Generated `.claude/hooks/` shims are legacy artifacts. Current migration removes
known generated shims and preserves only user-authored `.claude/hooks/custom-*.sh`
files.

## Customization Notes

- Non-monorepo projects can remove package-related doc drift triggers.
- Non-Expo projects can remove Metro config drift checks.
- Non-Turborepo projects can remove `turbo.json` drift checks.
- Keep durable shared policy in `CLAUDE.md`, repo-local workflow files, and reference configs rather than hidden runtime caches.
- Use `tasks/lessons.md` for repeated corrections and `docs/researches/*.md` for deep findings instead of hook-managed auto-memory.

## Failure Logging

- Blocking hooks emit structured JSON with: `guard`, `action`, `reason`, `fix`, `failure_class`, `run_id`.
- Failure classes are intentionally limited to:
  - `missing_artifact`
  - `state_violation`
  - `contract_failure`
  - `quality_gate`
- Hook failures append JSONL records to `.ai/harness/failures/latest.jsonl`.
- Use `bash scripts/summarize-failures.sh` to aggregate the latest failure log, or `--run-id <id>` to inspect a single run.
