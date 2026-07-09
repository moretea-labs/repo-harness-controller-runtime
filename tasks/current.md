# Current Status Snapshot

<!-- updated_at: 2026-07-09 -->
<!-- stale_after: 24h -->

> **Status**: Ready for Delivery
> **Updated At**: 2026-07-09
> **Source**: Goal loop provider/executor GUI configuration center
> **Target**: User-controllable LLM providers, local tools, routing, and policy without secret exposure
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- Automation Settings / Model & Tool Providers GUI page in local-bridge console.
- Persistent non-secret config under `controllerHome/global/*.json`.
- ExecutorRouter + provider registry respect enable/disable, priority, live mode, and tool disables.
- ChatGPT remains handoff-only; Grok direct dispatch requires credential + live mode.

## Validation Completed

- `npm run check:type`
- `bun test tests/runtime/provider-config.test.ts`
- `bun test tests/runtime/goal-loop.test.ts`
- `bun test tests/runtime/facade-contracts.test.ts`

## Remaining Before Delivery

- Optional: deeper routing drag-and-drop editor (current shows ordered lists + API updates).
- Live HTTP adapters for remote APIs remain gated.
