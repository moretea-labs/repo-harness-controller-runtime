# repo-harness V8 — ChatGPT-Controlled Execution Bridge

> **Historical Design — Not Runtime Authority**
>
> This document records the V8 ChatGPT-controlled execution-bridge design and remains available for migration history and audit. It may describe behavior that is still implemented, superseded, or not yet migrated.
>
> Current Controller Runtime architecture: [docs/architecture/current/README.md](../current/README.md).

## Positioning

V8 defines repo-harness as a repository execution bridge for an upstream controller such as ChatGPT.

ChatGPT owns:

- repository understanding and problem analysis;
- architecture and implementation decisions;
- the choice between Direct Edit and optional Agent execution;
- review of diffs, checks, and completion evidence;
- follow-up corrections and final acceptance.

repo-harness owns deterministic execution capabilities:

- repository search and bounded reads;
- transactional file editing and localized diffs;
- named checks and evidence storage;
- Git/worktree and optional GitHub integration;
- optional Codex, Claude, or GitHub Copilot execution;
- Issue, Task, Run, and Activity persistence.

repo-harness does not decide that every change must become an Issue, does not force Agent execution, and does not bind a Task permanently to one Agent.

## Execution modes

### Direct Edit — default

Use Direct Edit when the implementation is understood and ChatGPT can control the changes precisely.

A V8 edit session is a multi-revision transaction:

```text
begin_edit_session
  -> apply_patch (revision 1)
  -> create_edit_savepoint
  -> apply_patch (revision 2)
  -> apply_patch (revision 3)
  -> inspect aggregate diff
  -> run checks when useful
  -> apply another correction revision if needed
  -> finalize_edit_session
```

A session may contain multiple patch batches. Each batch:

- creates a numbered revision;
- keeps before/after SHA-256 evidence;
- writes a revision-local patch;
- updates one aggregate localized patch;
- remains appendable until finalization or full rollback.

Supported operations:

- `create`
- `write`
- `replace`
- `insert_before`
- `insert_after`
- `prepend`
- `append`
- `delete`

Practical defaults are 100 changed files and 50,000 cumulative changed lines. Callers may raise the explicit session limit up to 1,000 files and 500,000 changed lines. One patch batch may contain up to 500 operations, so very large changes can be transferred as multiple smaller tool calls instead of one oversized request.

Savepoints and rollback:

- `create_edit_savepoint` records the current revision under a name;
- `rollback_edit_session(to_revision)` reverts later revisions;
- `rollback_edit_session(savepoint)` returns to a named savepoint;
- a rollback to revision zero restores the complete baseline.

Checks do not close the session. A failed check moves the session to `check_failed`; ChatGPT can append another revision and run the check again.

### Optional Agent execution

Use an Agent when the objective is clear but implementation requires broad exploration, many files, repeated compile/test/fix loops, or substantial autonomous code generation.

The Task stores the implementation contract:

- objective;
- allowed and forbidden paths;
- checks;
- acceptance criteria;
- risk metadata;
- dependencies.

It does not store a mandatory executor. `recommendedAgent` is an optional compatibility hint. The runtime caller selects:

- `codex`
- `claude`
- `github-copilot`

The same Task may use different execution modes over time, for example:

```text
ChatGPT analysis
  -> Claude implementation Run
  -> ChatGPT review
  -> Direct Edit correction revision
  -> focused check
```

## Risk and authorization

V8 removes ordinary local approval ceremony.

- `readonly`, `low`, `medium`, and `high` are execution and verification metadata.
- Medium/high local work does not produce `RISK_CONFIRMATION_REQUIRED`.
- `approve_risk` is removed from the public dispatch surface.
- Local Job Tickets do not enter a confirmation queue.
- A configured `manual-only` preference cannot convert ordinary local work into a pending approval.

An explicitly destructive or irreversible operation remains a real boundary. It must carry `approve_destructive` in the same request. This is a direct authorization parameter, not a separate approval workflow or visual queue.

## Controller information architecture

The V8 Local Controller has four top-level destinations:

1. **Overview** — current Issue, child Tasks, active executions, and attention items.
2. **Work** — hierarchical Issue list. Opening an Issue shows its Tasks, changes, and activity.
3. **Activity** — unified Agent Runs, Direct Edit sessions, checks, Git, and worklog events.
4. **Settings** — Agent availability, connector state, checks, GitHub integration, and advanced diagnostics.

The user-facing hierarchy is:

```text
Issue
  -> Task
      -> Execution
          -> Direct Edit revisions
          -> Agent Run
          -> Check Run
```

Edit sessions, verification records, Jobs, and worklog events remain technical execution evidence; they are not separate first-level workflow concepts.

## MCP surface

- tool surface: `controller-chatgpt-bridge-v8`
- schema version: `10`
- tool surface version: `8`
- default ChatGPT server name: `repo-harness-controller-v8`

New or materially changed capabilities include:

- `multiRevisionDirectEdits`
- `editSavepoints`
- `partialEditRollback`
- `runtimeAgentSelection`
- `taskAgentBinding: false`
- `localApprovalQueue: false`
- `localRiskApprovalGate: false`
- `hierarchicalControllerUI`

## Migration from V7

Stored V7 edit states are normalized on read:

- `applied` -> `dirty`
- `verified` -> `checked`
- `verification_failed` -> `check_failed`

Existing Task `recommendedAgent` values remain valid as hints, but new Tasks no longer default to Codex. Existing legacy pending Jobs may still be read and cancelled, while new V8 Jobs do not enter an approval queue.
