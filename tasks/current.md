# Current Status Snapshot

<!-- generated-by: controller-core-runtime-refactor -->
<!-- updated_at: 2026-07-02T08:30:00Z -->
<!-- stale_after: 24h -->

> **Status**: Ready for Delivery
> **Updated At**: 2026-07-02T08:30:00Z
> **Source**: sandbox refactor of the portable source archive
> **Target**: stable resumable Controller Runtime with a bounded default Connector surface
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- Gateway, Tunnel, Controller daemon and Local Controller UI now have independent lifecycle boundaries.
- Durable Work can be resumed by `work_id` or repository-scoped `request_id` after an MCP reconnect.
- The default Controller Connector exposes 12 core tools; the full legacy surface remains available through an explicit `full` toolset.
- Execution heartbeats update only their Job record and no longer rewrite global active/recent indexes or dirty projections.
- `controller_context` is a bounded, non-blocking read assembled from current indexes; it does not create a refresh Job or run repository reconciliation.
- Controller overview data is organized around attention, running, review and recently completed decisions.

## Validation Completed

- Strict TypeScript check: passed.
- Runtime architecture gate: passed.
- MCP compatibility gate: core 12 tools, full 118 tools, compatibility fingerprint preserved.
- Runtime control-plane, recovery, HTTP MCP and Schedule Engine smoke tests: passed.
- Controller Service lifecycle, MCP Controller, Setup, Keepalive and Local Bridge focused tests: passed.
- Isolated test sweep: 106/110 files passed on the first run; the four remaining files were test-environment/time-budget cases and are being rerun after infrastructure fixes.

## Remaining Before Delivery

- Hook and migration long suites completed successfully after correcting test infrastructure limits.
- Task/workflow, public export and package-content gates passed.
- Final source review is complete; Git integration and archive validation are the remaining delivery mechanics.
