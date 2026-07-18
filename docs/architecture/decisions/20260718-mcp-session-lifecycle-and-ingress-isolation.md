# ADR: MCP Session Lifecycle and Stable Ingress Isolation

> Status: **Accepted**
> Date: 2026-07-18
> Owner: `plans/plan-20260718-1452-fix-mcp-session-lifecycle.md`

## Context

The production MCP runtime reached `64/64` retained sessions with `64` active SSE streams and no active POST work. New initialize requests returned `503 session_capacity` while `/health` and `/ready` still reported success. The transport used three independent session maps, did not register the SDK-supported DELETE method, and refused to reclaim any session with an open GET. The Stable Supervisor therefore had neither an accurate global capacity signal nor a safe recovery trigger. Its stable ingress proxy also ran in the same event loop as lifecycle control.

This is an architecture defect rather than an isolated timeout: transport connectivity was treated as execution ownership, liveness was conflated with admission readiness, and long-lived data-plane connections shared the lifecycle owner's event loop.

## Decision

1. `/mcp`, `/mcp-grok`, and `/mcp-bearer` MUST share one global session registry and one global capacity limit. Route and authenticated principal remain part of session lookup authorization.
2. Every session MUST record route, principal, client identity, creation time, last activity, stream-open time, POST-open time, active GET/POST counts, and close reason.
3. DELETE MUST be supported on all three MCP paths and MUST close the SDK transport and release registry ownership.
4. SSE is a replaceable transport lease, not execution ownership. A session with no active POST MAY be superseded, lease-expired, lifetime-expired, or evicted under capacity pressure. A session with an active POST MUST NOT be evicted by session-capacity management.
5. Initialize admission MUST use an atomic registry-owned reservation covering global and meaningful per-principal capacity. Only an explicitly named, route- and principal-matching prior session may be superseded; client metadata and User-Agent are not a unique agent identity. Shared static-bearer clients use the global pool rather than an artificial per-principal bucket.
6. `/health` remains event-loop liveness and observability. `/ready` MUST incorporate session admission capacity and return 503 when no new session can be accepted safely. Metrics MUST expose utilization, available capacity, evictable/protected sessions, oldest stream/POST age, and close-reason counters.
7. The Supervisor MUST consume structured readiness. Temporary not-ready states do not restart the Gateway. A restart is eligible only for loss of liveness or an explicit bounded-recovery recommendation after protected work exceeds its stall limit.
8. Stable ingress MUST run in a supervised child process from the immutable Supervisor bundle. The child reads active-slot authority for every request, owns the public loopback binding, and exits if its parent lifecycle owner disappears. The Supervisor control server and recovery decisions remain in the parent process.

## Alternatives

- Increase the 64-session limit: rejected because leaked SSE streams would consume any larger finite pool.
- Periodically restart the Gateway: rejected because it destroys healthy sessions and hides false readiness.
- Never reclaim open GET streams: rejected because a disconnected or half-open client can retain capacity forever.
- Evict all old sessions regardless of POST activity: rejected because it can terminate accepted work still executing.
- Keep ingress in the Supervisor event loop: rejected because data-plane connection count must not determine control-plane responsiveness.

## Consequences

- Long-lived clients may observe deliberate SSE rotation and must reconnect using the normal MCP initialize flow.
- Session capacity becomes self-healing for stream-only leaks; genuine active-work saturation becomes visible without immediate destructive recovery.
- The Supervisor bundle has two runtime modes: lifecycle parent and isolated ingress child. No additional release artifact or service-manager unit is required.
- Deploying this decision requires installing the new immutable Supervisor release and restarting through the existing durable rollout path. Source completion does not alter the currently running `_ops` runtime.

## Migration

The new registry accepts no persisted migration because transport sessions are intentionally in-memory. Existing sessions are replaced on rollout. The stable tunnel continues to target the same local port. The previous immutable Supervisor release remains the rollback surface.

## Verification

- `bun test tests/unit/fix-mcp-session-lifecycle.test.ts tests/cli/mcp-http.test.ts`
- `bun test tests/runtime/stable-supervisor-hardening.test.ts tests/runtime/stable-supervisor-integration.test.ts`
- `bunx tsc --noEmit`
- Root required checks from `AGENTS.md`

The regression suite includes 500 real HTTP initialize/SSE-disconnect cycles, concurrent initialize admission, cross-route global capacity, stream-only eviction, active-POST protection, DELETE cleanup, readiness recovery classification, and a real isolated ingress child process.

## Amends

- `docs/architecture/current/system-overview.md`
- `docs/architecture/current/architecture-invariants.md`
- `docs/architecture/current/failure-recovery.md`
- `docs/architecture/current/stable-external-runtime-supervisor.md`
- `docs/architecture/current/implementation-status.md`

## Supersedes / Superseded by

- Supersedes the implicit rule that an active SSE GET prevents session expiry.
- Superseded by: none.
