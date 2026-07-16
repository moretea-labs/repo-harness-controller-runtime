# Plan: Stable External Runtime Supervisor

> **Status**: Approved and executing
> **Source of truth**: `/Users/greyson/.codex/attachments/2f499c15-8e96-4491-9602-79cd65366d06/pasted-text-1.txt`
> **Repository**: `repo-harness-controller-runtime`
> **Branch**: `codex/stable-external-runtime-supervisor`

## Goal

Deliver one controller-scoped Stable External Runtime Supervisor that survives
business-runtime failure and provides durable restart, rollout, rollback, and
Rescue MCP control while preserving the existing runtime-generation,
active-slot, health, KeepAlive, and blue/green authorities.

## Scope

- Stable Supervisor release/install/start/stop/status/logs surfaces.
- Supervisor lock, epoch fencing, process identity, durable state, operations,
  restart budgets, and bounded recovery.
- Stable local control socket, loopback Rescue MCP, and active-slot ingress
  routing without a second active-slot authority.
- Migration of normal lifecycle/restart/rollout/rollback entrypoints and the
  `rh_status`/`rh_work` facade to the Supervisor operation contract.
- macOS launchd and Linux systemd templates, connector/runbook documentation,
  focused tests, static validation, and at least one local runtime smoke path.

## Non-goals

- No arbitrary shell, repository editing, Git write, plugin, secret, or worker
  execution through Rescue MCP.
- No second runtime-generation, active-slot, health, projection, cleanup, or
  business-health authority.
- No deletion of historical Work/Job/Evidence/Attention records.
- No unrelated GUI, Worker, repository, or plugin refactor.
- No remote push or unapproved public restart REST endpoint.

## Ordered delivery slices

1. Map and preserve current lifecycle/restart/slot/health authority.
2. Add stable Supervisor types, paths, state, operation store, identity/fencing,
   restart policy, and focused unit coverage.
3. Add Supervisor process loop, control socket, Rescue MCP, stable ingress, and
   release installation with launchd/systemd templates.
4. Route lifecycle/restart/blue-green/facade operations through the Supervisor
   while keeping the old detached coordinator as an explicit compatibility
   fallback when no Supervisor is installed.
5. Add real/contract acceptance coverage, documentation, required checks, and
   close out the branch through review, merge, and cleanup.

## Acceptance checks

- Supervisor lifecycle tests cover single-instance, stale lock recovery, PID
  reuse, reattach, desired stop, and persisted restart counts.
- Recovery tests prove daemon-only and gateway-only restart ownership, and prove
  the stable Supervisor/Rescue control surface survives complete business
  runtime outage.
- Durable operation tests prove persist-before-stop, request-id idempotency,
  bounded output, continuation after disconnect, and unambiguous completion.
- Blue/green tests prove candidate isolation, atomic ingress cutover, rollback,
  rollback-window retention, and lockout on exhausted recovery budget.
- `bun run check:type`, `bun run check:runtime-architecture`,
  `bun run check:controller-v8`, `bun run check:mcp-compatibility`, focused
  tests, and the repository required checks pass or have exact baseline
  evidence.
- A local install/start/status/control smoke verifies the Supervisor is the
  lifecycle owner and `tools/list` exposes only the fixed Rescue surface.

## Stop condition

Stop only after verified completion and a clean merged `main`, or after three
consecutive turns with the same external blocker and no safe alternative. Do
not claim the end-to-end goal complete if only a state-file prototype or unit
tests exist.
