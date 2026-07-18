# Stable Runtime Supervisor

> Capability: `stable-runtime-supervisor`
> Runtime Authority: `docs/architecture/current/stable-external-runtime-supervisor.md`

## Responsibility

`src/runtime/supervisor/` owns immutable lifecycle authority, durable restart/rollout operations, identity-fenced Gateway and Daemon management, Rescue MCP, readiness evaluation, and the isolated stable-ingress child.

## Process Boundary

```text
OS service manager
  -> Supervisor lifecycle parent
       -> control + Rescue MCP
       -> Controller Daemon
       -> Gateway Host
       -> ingress child (public loopback data plane)
```

The ingress child owns long-lived proxy sockets and reads active-slot authority on each request. It cannot mutate Supervisor operations. It exits on parent disconnect or parent PID loss. The parent observes child liveness and recreates it with bounded startup verification.

## Recovery Rule

Structured Gateway readiness can mark the runtime degraded without authorizing a restart. The parent restarts only after liveness failure or an explicit `recoveryRecommended` signal produced after protected POST work exceeds its bounded stall threshold.

## Verification

```text
bun test tests/runtime/stable-supervisor-hardening.test.ts tests/runtime/stable-supervisor-integration.test.ts
```
