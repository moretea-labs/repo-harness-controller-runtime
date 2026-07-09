# ChatGPT Handoff Inbox and MCP Facade Architecture

## Purpose

This design keeps ChatGPT as the strong interactive controller while making repo-harness a safer, smaller, and more useful repository control plane.

The architecture addresses two current bottlenecks:

1. repo-harness can execute work but cannot proactively return pending decisions to the ChatGPT control conversation.
2. ChatGPT sees too many narrow MCP tools, making tool selection harder as new repository and plugin capabilities are added.

The solution is not to make repo-harness a replacement LLM agent. The solution is to expose a small ChatGPT-facing facade, route concrete work through internal capabilities, and record pending decisions in a durable Handoff Inbox.

## Design principles

- ChatGPT remains the strong主控 for ambiguous design, product, architecture, and high-risk decisions.
- repo-harness owns deterministic control-plane work: repository state, worktrees, task lifecycle, evidence, verification, policy, and cleanup.
- Codex or another coding agent may be used as a worker, but repo-harness remains the scheduler, verifier, and policy gate.
- Internal capabilities may grow, but the ChatGPT-facing tool surface should stay small and stable.
- New features should register internal capabilities instead of adding one visible MCP tool per feature.
- All ChatGPT-facing responses should be bounded summaries by default, with explicit detail/ref follow-up.
- Risky operations should return approval requests, not be exposed as separate high-risk tools.

## Capability domains

repo-harness has at least two peer capability domains. They should be modeled in parallel, not nested under each other.

### Repository capabilities

Repository capabilities operate on code, tasks, checks, branches, worktrees, commits, and evidence.

Examples:

- inspect repository status
- create or reuse a worktree
- read task context
- apply bounded edits
- run verification
- summarize diff and evidence
- commit, merge, or cleanup after policy approval

### Plugin capabilities

Plugin capabilities operate on external service integrations or assistant runtime extensions. They are not inherently repository operations, even if their configuration or tests live in the repository.

Examples:

- Gmail plugin actions
- Calendar plugin actions
- browser plugin actions
- GitHub plugin actions
- future assistant/runtime plugins

### Why they should be parallel

Treating plugin capabilities as a subset of repository tools causes tool growth and mixed permissions. A browser preview, a GitHub issue sync, and a repository verification check have different risk shapes. They should all register as internal capabilities with metadata, but ChatGPT should not receive a new top-level tool for each one.

The common abstraction should be:

```text
Capability
  id
  domain: repository | plugin | controller | evidence | maintenance
  operation class: read | write | execute | verify | finalize
  risk: low | medium | high | destructive
  input contract
  result contract
  exposed via facade operation
```

This keeps plugin abilities and repository abilities extensible without growing the public MCP surface.

## ChatGPT-facing facade

The facade is a small set of stable tools. It should hide controller internals such as runId, checkoutId, raw job payloads, leases, fingerprints, and plugin-specific implementation details unless explicitly requested through a detail path.

Recommended first surface:

```text
rh_status   - current controller/repo/task readiness and pending attention
rh_inbox    - list, get, ack, resolve handoff items
rh_context  - task, repo, diff, evidence, recent attempts, context map
rh_work     - start, continue, verify, repair, finalize, stop
```

A later `rh_evidence` can be split out if evidence becomes too large for `rh_context`.

### Facade operation rule

Operations describe generic workflow actions, not business-specific features.

Good operations:

```text
start
continue
verify
repair
finalize
list
get
ack
resolve
```

Bad operations:

```text
fix_durable_job_response
migrate_mcp_runtime_config
repair_browser_preview
sync_gmail_plugin
```

Business meaning belongs in `objective`, `task_id`, `acceptance_criteria`, `runbook_ref`, and evidence summaries.

## Unified facade result

Every ChatGPT-facing facade should return the same outer envelope.

```text
FacadeResult
  status: ok | blocked | failed | approval_required | not_found
  summary: short natural-language summary for ChatGPT
  data: bounded structured data
  evidence_refs: bounded references to detailed evidence
  warnings: policy or validation warnings
  suggested_next_actions: concrete facade calls that are safe next steps
  raw_available: whether a more detailed view exists
```

`suggested_next_actions` is important because it turns repo-harness into a guided workflow. ChatGPT should not have to choose from many tools after every result. The controller should return a small set of next safe actions.

## Handoff Inbox

The Handoff Inbox is the durable bridge from background work back to the ChatGPT主控.

repo-harness should create a handoff when it reaches a state where a strong controller should decide the next step.

Typical triggers:

- verification failed and the repair direction is ambiguous
- work is ready for review or merge approval
- an operation was blocked by policy
- a background task discovered a new candidate issue
- a plugin capability needs configuration or user authorization
- a coding agent completed work but repo-harness cannot safely finalize

### Handoff item contract

```text
HandoffItem
  id
  repo_id
  task_id
  title
  severity: info | needs_review | blocked | failed | ready_to_continue
  status: pending | acknowledged | in_progress | resolved | dismissed | superseded
  reason: why ChatGPT/main controller is needed
  summary: what happened
  current_state: bounded repo/task/work state
  evidence_refs: evidence references, not raw logs by default
  recommended_decision: what ChatGPT should decide
  recommended_prompt: continuation prompt for a new or resumed ChatGPT session
  suggested_next_actions: safe facade calls for the next step
  created_at
  updated_at
```

### Handoff lifecycle

```text
pending -> acknowledged -> in_progress -> resolved
```

Additional terminal states:

```text
dismissed
superseded
expired
```

The inbox should be pull-friendly. ChatGPT or a scheduled checker can call `rh_inbox list`, read the highest-priority pending item, then continue with `rh_context` and `rh_work`.

## Policy gate

Permissions should not be encoded by creating more MCP tools. They should be enforced by a policy gate below the facade.

The gate classifies each requested capability invocation as:

```text
allowed
approval_required
denied
dry_run_only
```

Examples:

- reading bounded task context: allowed
- running a known targeted check: allowed
- creating a worktree for scoped work: allowed or approval-free if low/medium risk
- committing a scoped verified change: allowed when task policy permits
- merging to main: approval_required
- deleting a worktree: approval_required unless it is controller-owned and terminal
- running arbitrary shell from ChatGPT input: denied or approval_required
- reading raw tokens, auth files, or full environment: denied by default

## Avoiding security-prone ChatGPT request shapes

ChatGPT-facing tools should avoid request shapes that look like unconstrained local execution or agent takeover.

Prefer this shape:

```text
rh_work({
  operation: "continue",
  task_id: "T17",
  mode: "supervised",
  constraints: { max_changed_files: 6, allow_merge: false }
})
```

Avoid this shape:

```text
execute_command({ command: "..." })
run_agent({ prompt: "do anything needed" })
```

Execution should be staged:

1. ChatGPT submits a high-level intent through a facade.
2. repo-harness returns a preview, policy classification, and suggested next actions.
3. repo-harness creates a controller-owned worktree or direct-edit session internally.
4. Risky execution requests become approval requests with bounded previews.
5. Raw logs, large stdout/stderr, local paths, and secrets are not returned by default.

This design reduces the chance that ChatGPT triggers safety systems with a broad local-execution request. It also gives repo-harness a stronger audit trail.

## Execution mode selection

The facade should not force every request into the Goal Workloop. repo-harness needs a lightweight router that preserves the existing fast path while upgrading only the work that benefits from recovery, isolation, worker execution, approval, plugin authorization, or background continuation.

### Direct Control

Use Direct Control when ChatGPT is actively supervising a small, clear change.

Typical conditions:

- expected files are three or fewer
- expected changed lines are roughly two hundred or fewer
- scope and paths are clear
- no external plugin side effect is required
- no worker or background recovery is required
- no merge, cleanup, or destructive approval is required

Direct Control may still use bounded primitives such as search, read, direct edit, patch, targeted check, and selected-path commit. It is a fast execution path, not a policy bypass.

### Goal Workloop

Use Goal Workloop when the work has enough complexity to benefit from a durable contract.

Typical conditions:

- multi-step implementation or verification
- controller-owned worktree isolation
- Codex or another worker may be useful
- explicit policy approval may be needed
- a later ChatGPT session may need to resume
- plugin capability or external service state is involved

The Goal Workloop can internally choose direct edit, isolated worktree, worker execution, or handoff, but ChatGPT should not have to select the low-level mechanism in the request shape.

### Handoff-only

Use Handoff-only when repo-harness should not execute yet.

Typical conditions:

- the objective is underspecified
- acceptance criteria are missing
- allowed paths are unclear
- a plugin is missing authorization
- the next step requires product or architecture judgment
- the operation is high risk and lacks approval

Handoff-only creates a pending decision packet for ChatGPT or the user. It should not become a general log sink.

### Routing rule

```text
small + clear + supervised
  -> Direct Control

clear + complex or needs recovery/worker/approval/external effect
  -> Goal Workloop

unclear or unsafe without a decision
  -> Handoff-only
```

This rule prevents process inflation: direct edit remains the default for small supervised work, and Goal Workloop is an escalation path rather than a universal wrapper.

## Work start flow

The expected implementation flow for new work is:

```text
ChatGPT request
  -> rh_status / rh_context to inspect readiness
  -> rh_work start or continue with bounded constraints
  -> policy gate decides allowed / approval_required / denied
  -> repo-harness creates worktree or edit session
  -> internal capability executes work
  -> evidence is captured as bounded references
  -> rh_work returns summary and suggested_next_actions
  -> if blocked or review-needed, Handoff Inbox item is created
```

For low-risk documentation or contract work, repo-harness may use a bounded direct-edit session. For isolated code changes, repo-harness should prefer a controller-owned worktree. ChatGPT should not need to choose the low-level mechanism unless the user explicitly asks.

## Capability registry

New features should be added to the registry, not to the ChatGPT-visible tool list.

Example:

```text
Capability: browser_result_preview
  domain: plugin
  operation_class: evidence
  risk: low
  exposed_via: rh_context.evidence
```

```text
Capability: stale_worktree_cleanup
  domain: maintenance
  operation_class: finalize
  risk: medium
  exposed_via: rh_work.finalize
```

```text
Capability: durable_job_bounded_response_check
  domain: controller
  operation_class: verify
  risk: low
  exposed_via: rh_work.verify
```

This prevents new feature work from expanding ChatGPT's tool menu.

## Implementation stages

### Stage 1: documentation and contracts

- Document Handoff Inbox and MCP facade architecture.
- Define `HandoffItem` and `FacadeResult` contracts.
- Define the first facade operations and result envelopes.
- Document policy and safety rules.

### Stage 2: Handoff Inbox MVP

- Add persistent handoff storage under controller-home repository runtime storage.
- Add create/list/get/ack/resolve operations internally.
- Surface pending handoff count in status.
- Create handoffs from blocked, failed, approval-required, and ready-to-continue states.

### Stage 3: MCP facade MVP

- Add `rh_status`, `rh_inbox`, `rh_context`, and `rh_work` facade tools.
- Route existing controller actions through facade operations.
- Return `FacadeResult` consistently.
- Mark legacy narrow tools as internal/deprecated for ChatGPT use.

### Stage 4: capability routing and policy gate

- Add capability metadata and routing.
- Move plugin and repository operations behind the same registry/policy model.
- Enforce approval_required for merge, cleanup, raw detail, and arbitrary execution.

### Stage 5: worker integration

- Let `rh_work` schedule Codex or another worker only after policy classification.
- Keep Codex as a worker, not the owner of task lifecycle.
- repo-harness remains responsible for verification, evidence, finalization, and handoff.

## Acceptance for this architecture

The design is successful if ChatGPT can operate repo-harness primarily through four stable entry points, if background work can leave a resumable handoff, and if new repository or plugin capabilities can be added internally without growing the public tool list.
