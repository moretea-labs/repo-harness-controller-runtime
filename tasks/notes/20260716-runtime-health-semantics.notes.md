# Runtime health semantics — implementation decisions

- Health classification stays pure and in `src/runtime/health/evaluator.ts`; callers only collect observations.
- Projection freshness follows dirty/source revision state and a bounded grace period. Cache age remains a refresh optimization, not a readiness failure.
- Local Controller endpoint/surface/generation evidence outranks stale persisted process flags. `running` is retained only as a compatibility field.
- Current attention and history are read models over existing Jobs and handoffs. Resolved attention is retained in history; no incident store was added.
- Ownership is embedded in Agent Run, Execution Job, and runtime slot records. Unknown legacy ownership is protected. Cleanup remains bounded and failure-isolated with a 50-removal automatic default.
- Blue/green authority and runtime-source drift rules were preserved. Slot identity ownership is additive and does not alter cutover or rollback behavior.
- Legacy branches, artifacts, edit sessions, and unproven temp resources remain conservative/retained; enabling broader collection would require their existing lifecycle authorities to provide proof of eligibility.
