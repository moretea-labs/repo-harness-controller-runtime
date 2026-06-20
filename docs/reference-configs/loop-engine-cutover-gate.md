# Loop Engine Cutover Gate

This gate is the row 7 guardrail for replacing the TypeScript prompt-intent
classifier with the natural-language decision table. It does not perform the
cutover; it decides whether cutover is allowed.

## G2 Rule

Cutover is eligible only when both are true:

- Row 3 second G1 evidence is `go`.
- A shadow divergence report reaches G2: at least 100 prompts or 14 days of
  shadow coverage, zero critical route divergence, and phase-probe timing at or
  below baseline.

When the shadow report is missing or no-go, the TypeScript classifier remains
the runtime authority. `src/cli/hook/prompt-intents.ts` and
`src/cli/hook/prompt-guard-decision.ts` must not be deleted before G2 passes.

## Command

```bash
bun scripts/loop-engine-cutover-gate.ts --repo . --json --out .ai/harness/runs/loop-engine-07-cutover-gate.json
```

The report uses `protocol: "loop-engine-cutover-gate/v1"` and records:

- `g1.status`
- `shadow.status`
- `classifier_guardrail.present`
- `cutover.allowed`
- `cutover.reason`

## Current Sprint Meaning

For this sprint state, row 3 is `go` but no shadow divergence report exists.
Therefore the expected row 7 report is blocked with
`missing_shadow_divergence_report`, and the runtime TypeScript classifier stays
authoritative.
