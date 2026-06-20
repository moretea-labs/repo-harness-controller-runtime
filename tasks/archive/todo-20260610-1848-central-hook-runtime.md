> **Archived**: 2026-06-10 18:48
> **Related Plan**: plans/archive/plan-20260610-1822-central-hook-runtime.md
> **Outcome**: Completed
> **Source Plan**: (none)
> **Parent Run ID**: run-20260610-1848

# Deferred Goal Ledger

> **Status**: Backlog
> **Updated**: 2026-06-10 18:22
> **Scope**: Medium/long-term goals deferred from active plan execution

Current plan tasks live in the active plan's `## Task Breakdown`.
Do not duplicate that execution checklist here. Record only work intentionally deferred beyond this slice, with the tradeoff and revisit trigger.

## Deferred Goals

| Goal | Why Deferred | Tradeoff | Revisit Trigger |
|------|--------------|----------|-----------------|
| Stop vendoring `.ai/hooks` into downstream repos at init/migrate (central runtime made vendored copies inert defaults) | Central-first resolution just landed; let it soak before removing the fallback surface | Vendored copies keep working offline/pre-bundle but can confuse "I edited .ai/hooks and nothing changed" | After central runtime has run incident-free across the fleet for a few weeks, or when the next scaffold-surface change touches init/migrate |
