---
id: "ISS-20260720-66E25D"
kind: "feature"
status: "planned"
updated_at: "2026-07-20T21:15:07.000Z"
source: "repo-harness-controller-v8"
---

# Optimize iOS device interaction latency and Thin Harness follow-ups

Continue from the merged iOS Fast Path V1. Reduce end-to-end iOS interaction latency using measured session reuse, tiered evidence and repeatable benchmarks, then close remaining evidence-backed Thin Harness follow-ups.

## Goals

- Implement a bounded short-session execution path that reduces scheduler and process startup overhead.
- Use settle results and exact waits before scoped or full accessibility snapshots.
- Measure cold and warm simulator and optional physical-device latency by segment.
- Reduce remaining measured Thin Harness fixed costs without increasing the stable MCP tool surface.

## Non-goals

- Release installation or remote publishing.
- Unbounded device action inputs.
- Unmeasured architectural rewrites.

## Acceptance Criteria

- [ ] Per-device and per-session serialization, timeout, cancellation and redaction remain enforced.
- [ ] Exact-result iOS workflows avoid full accessibility-tree capture.
- [ ] Benchmarks report p50 and p95 for cold and warm runs without fabricated baselines.
- [ ] Eligible Thin Harness Fast operations still create zero ExecutionJob, LocalJob and Worker.
- [ ] Focused tests, type, runtime architecture and MCP compatibility checks pass.
- [ ] Stable MCP tool budget remains 128.

## GitHub

- Not published.

## Tasks

### T1 — Implement bounded iOS session direct execution

- Status: `ready`
- Objective: Design and implement a short allowlisted interaction-session execution path with ownership, cancellation, timeout, receipt and durable escalation.
- Depends on: none
- Allowed paths: `src/runtime/gateway/**`, `src/runtime/plugins/**`, `src/runtime/execution/**`, `tests/runtime/**`, `tests/cli/**`, `docs/architecture/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T2 — Complete tiered iOS accessibility evidence

- Status: `ready`
- Objective: Add selector or ref reuse, settle diff, exact wait, scoped snapshot and full snapshot fallback tiers with bounded redacted evidence.
- Depends on: none
- Allowed paths: `src/runtime/plugins/ios-agent-device.ts`, `tests/runtime/ios-agent-device-provider.test.ts`, `scripts/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`
- Execution hint: agent / codex

### T3 — Build repeatable iOS latency benchmark

- Status: `planned`
- Objective: Measure controller overhead, process startup, runner round trips, settle, snapshot and artifact costs for cold and warm simulator and optional physical-device runs.
- Depends on: `T2`
- Allowed paths: `scripts/**`, `src/runtime/plugins/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T4 — Close measured Thin Harness follow-ups

- Status: `ready`
- Objective: Measure and reduce patch savepoint and command-policy costs, large-repository read variance, Workbench schema size and Fast/Durable adapter duplication.
- Depends on: none
- Allowed paths: `src/runtime/execution/thin-harness/**`, `src/runtime/gateway/**`, `src/cli/mcp/**`, `scripts/benchmark-thin-harness-gateway-ab.ts`, `tests/runtime/thin-harness.test.ts`, `tests/cli/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

## Related Artifacts

- `06f764806499cded38841b1313b04ae45759d5fa`
- `EVD-1784559905279-a7d408c8`
- `EVD-1784560990334-cbe69246`
- `EVD-1784561013476-2d15a634`
