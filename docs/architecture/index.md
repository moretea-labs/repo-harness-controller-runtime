# Architecture Index

> Controller Runtime architecture entry point.

## Runtime Authority

**`docs/architecture/current/` is the only Runtime Authority for the current and target repo-harness Controller Runtime architecture.**

Start here:

- [Current architecture map and reading order](current/README.md)
- [Architecture governance contract](current/governance.md)

When current implementation, a historical V5–V8 design document, a research note, and a document under `current/` disagree, the following precedence applies:

1. executable code and persisted schemas describe **Current Implementation** facts;
2. `docs/architecture/current/` defines the approved **Target Architecture** and mandatory **Migration Rules**;
3. accepted ADRs may amend the target architecture until their conclusions are merged into `current/`;
4. versioned design documents, snapshots, plans, research reports, and diagrams are historical or exploratory evidence only.

A target rule is not evidence that the implementation already satisfies it. Every current architecture document must distinguish:

- **Current Implementation** — behavior verified in code, tests, or persisted schemas;
- **Target Architecture** — the approved end state that future work must converge toward;
- **Migration Rule** — constraints that apply while moving from the current implementation to the target.

## Current Controller Runtime Scope

repo-harness is a repository engineering control plane. It includes:

- MCP and local UI entry points;
- a multi-repository registry and per-repository runtime storage;
- Issue, Task, Job, Run, Direct Edit, Verification, and evidence lifecycles;
- optional Codex, Claude, and GitHub Copilot execution;
- workspace and worktree isolation, integration, checks, recovery, and governance;
- future schedule-driven bounded occurrences and cross-repository orchestration.

It is not the product runtime of the repositories it manages. It must not replace repository-owned build, test, deployment, or release systems as the final authority.

## Architecture Document Classes

| Class | Location | Authority |
| --- | --- | --- |
| Current architecture | `docs/architecture/current/` | Runtime Authority |
| Architecture decisions | `docs/architecture/decisions/` | Binding until merged or superseded |
| Pending drift requests | `docs/architecture/requests/` | Proposed change only |
| Architecture snapshots | `docs/architecture/snapshots/` | Historical evidence |
| Versioned V5–V8 documents | `docs/repo-harness-*.md` | Historical Design / Not Runtime Authority |
| Research reports | `docs/researches/` | Hypothesis and supporting evidence |
| Plans and task records | `plans/`, `tasks/` | Execution intent and progress, not architecture authority |
| Diagrams | `docs/architecture/diagrams/` | Explanatory projection; semantic Markdown source wins |

## Current Architecture Set

The current set is introduced incrementally under governance Issue `ISS-20260625-BBFD4B`. The completed baseline will contain:

- `README.md` — map, status labels, and reading order;
- `governance.md` — authority, ownership, ADR, and drift rules;
- `system-overview.md` — system boundary and process topology;
- `personal-assistant-plugin-baseline.md` — concrete assistant/plugin/provider boundary, threat model, capability matrix, and migration baseline;
- `architecture-invariants.md` — rules implementations must not violate;
- `entity-model.md` — Issue, Task, Job, Run, Edit Session, Verification, Schedule, Occurrence, Claim, and Lease semantics;
- `job-and-run-lifecycle.md` — durable execution and retry state machines;
- `dispatch-and-agent-strategy.md` — Direct Edit, Quick Agent, durable Task, and role selection;
- `scheduler-and-resource-claims.md` — repository actors, resource claims, leases, and conflict behavior;
- `multi-repository-execution.md` — quotas, fairness, failure isolation, and portfolio workflows;
- `automation-and-schedule-engine.md` — bounded occurrences, budgets, backoff, deduplication, and stop conditions;
- `failure-recovery.md` — process boundaries, orphan handling, reconciliation, and fencing;
- `verification-and-release-gates.md` — exact-revision evidence, integration gates, release freeze, and human authorization;
- `implementation-status.md` — verified implementation coverage and explicit migration gaps;
- `migration-roadmap.md` — evidence-driven implementation convergence order.

Until a listed document is created, the rule must be recorded in an accepted Issue/ADR and must not be inferred from a historical version document.

## Architecture Change Flow

1. Identify whether the proposed change alters a boundary, entity semantic, lifecycle, resource rule, safety invariant, or public execution contract.
2. Record the change as an architecture request or ADR before implementation when the answer is yes.
3. Update the affected `current/` documents in the same change or explicitly record the temporary drift and its owner.
4. Update tests and architecture checks that enforce the changed rule.
5. Mark superseded version documents as historical; never silently rewrite them into current truth.
6. Close the request only after the current architecture and executable behavior no longer contradict each other, or the difference is explicitly labeled as a migration gap.

See [Architecture governance contract](current/governance.md) for the full rule.

## Existing Domain Documentation

The following domain pages describe the earlier repo-local workflow-harness architecture. They remain useful implementation history but are not the current Controller Runtime authority:

- [Public Surface](domains/public-surface.md)
- [Workflow Engine](domains/workflow-engine.md)
- [Runtime Harness](domains/runtime-harness.md)
- [Verification](domains/verification.md)
- [Transactional Adoption Planner](transactional-adoption-planner.md)
- [Global Hook Runtime](global-hook-runtime.md)

## Pending Architecture Requests

<!-- BEGIN ARCHITECTURE PENDING REQUESTS -->
- (none)
<!-- END ARCHITECTURE PENDING REQUESTS -->

## Review Backlog

- Continue converging P0 runtime behavior with the gaps recorded in `current/implementation-status.md`.
- Add link validation and exact-revision release-manifest checks to the final release gate.
- Keep diagrams as projections of the Markdown semantic source; a diagram must not introduce architecture rules absent from `current/`.
