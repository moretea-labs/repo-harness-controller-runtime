# MCP HTTP Transport Lifecycle

> Capability: `mcp-http-transport-lifecycle`
> Runtime Authority: `docs/architecture/current/architecture-invariants.md` and `docs/architecture/current/failure-recovery.md`

## Responsibility

`src/cli/mcp/transports/` owns HTTP authentication handoff, MCP Streamable HTTP session lifecycle, global admission capacity, transport leases, DELETE cleanup, and liveness/readiness metrics. It does not own durable Job execution or Gateway process recovery.

## Invariants

- All public MCP HTTP routes share one registry and one global maximum.
- Route and authenticated principal must match the stored session on GET, POST, and DELETE.
- Active POST work is protected from capacity eviction.
- Stream-only sessions are reclaimable through client DELETE, explicit prior-session replacement, lease expiry, absolute lifetime, or oldest-safe capacity eviction.
- Initialize admission is an atomic registry reservation. Shared static-bearer clients use the global pool; per-principal fairness applies only where authentication provides a meaningful distinct principal.
- Health metrics report actual global counts; readiness reflects whether initialize can be admitted safely.
- Closing transport state never implies that a durably accepted Job is cancelled.

## Verification

```text
bun test tests/unit/fix-mcp-session-lifecycle.test.ts tests/cli/mcp-http.test.ts
```
