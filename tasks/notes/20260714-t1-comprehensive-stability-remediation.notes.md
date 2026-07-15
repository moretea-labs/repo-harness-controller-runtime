# T1 comprehensive stability remediation

## Decisions

- Keep controller check cache content-addressed and backward compatible; expose optional `cacheHit`, validated revision, original execution time, and failure class metadata instead of changing cache keys.
- Treat a named check that runs and returns a normal nonzero status as an acceptance failure. Reserve infrastructure failure for timeout, spawn/runtime, signal, stale, or corrupt-state conditions, while preserving the original message through Local Job, Execution Job, and operation summaries.
- Keep `controller_context` on the materialized projection path and remove its exact name from the legacy direct-hot-read registry; `controller_context_pack` remains a separate compatibility tool.
- Bound `rh_context` summary arrays and omit the large capability payload by default. Detail/raw responses retain their compatibility-oriented expanded shape.
- Report connector freshness as local-registry verification unless an explicit external callability probe is supplied; an `UNKNOWN_TOOL` probe is represented as a connector mismatch.
- Treat absent ignored `.ai` runtime/bootstrap state as a remediation message in the task-workflow check, while retaining strict failures for tracked source/document contract defects.

## Verification

Focused regression suites cover check provenance/classification, operation summaries, bounded context payloads, connector diagnostics, router hot paths, projection recovery, and managed worktree cleanup. Final required checks are recorded in the task handoff after the end-of-run full test.
