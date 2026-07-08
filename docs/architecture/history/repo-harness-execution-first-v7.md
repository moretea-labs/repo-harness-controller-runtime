# Controller V7: Execution First, Risk Adaptive, Task Local

> **Historical Design — Not Runtime Authority**
>
> This document records the V7 execution-first design and remains available for migration history and audit. It may describe behavior that is still implemented, superseded, or not yet migrated.
>
> Current Controller Runtime architecture: [docs/architecture/current/README.md](../current/README.md).

Controller V7 treats repo-harness as a local capability bridge rather than a workflow authority. ChatGPT or another capable operator owns execution decisions; repo-harness supplies bounded filesystem access, persistent Runs, checks, evidence, local approvals, and recovery metadata.

## Principles

1. **Task-local launch decisions.** A Task is evaluated from its own effective state, dependencies, path scope, risk, approvals, and active Runs. Unrelated Tasks, another active Issue, or the current focus cannot block it.
2. **Execution before ceremony.** Missing named checks, Issue summaries, or Issue-level acceptance criteria are warnings unless a real safety boundary requires them.
3. **Risk-adaptive completion.** Read-only and low-risk Tasks skip irrelevant Diff, check, and human-acceptance gates. Medium-risk Tasks run declared checks when present. High-risk and destructive Tasks retain evidence and approval requirements.
4. **Evidence is authoritative.** A real failed check, failed Run, path-policy violation, active-Run conflict, or missing required high-risk evidence blocks continuation. Static readiness fields do not override runtime evidence.
5. **Automatic continuation.** A successful Run continues into applicable checks, verification, auto-completion, or explicit acceptance without requiring a manual status nudge.
6. **Ephemeral Quick Agent sessions.** Quick Agent work is excluded from the durable Issue board by default and cleans up temporary Issue metadata after terminal failure, cancellation, or success. Run evidence remains durable.
7. **Focus is presentation only.** Multiple active Issues are supported. `currentIssueId` helps the UI orient the user; it is not a global execution lock.

## Task execution classes

| Class | Default approval | Launch | Completion |
| --- | --- | --- | --- |
| Read-only | automatic | No scope or named checks required | Successful Run/evidence may auto-complete; no Diff or human gate |
| Low-risk change | automatic | Scope recommended; missing checks warn | Declared checks run when present; auto-complete after applicable evidence |
| Medium-risk change | automatic or confirmation for sensitive paths | Task-local dependencies and conflict checks | Declared checks and acceptance evidence are applied only when declared |
| High-risk change | explicit confirmation | Explicit allowed paths and no active conflict | Verification evidence plus reviewed Diff/integrated revision; human acceptance |
| Destructive change | manual-only | Explicit scope and localhost approval | Strong evidence, reviewed Diff/integration, and human acceptance |

Sensitive paths include deployment, CI workflows, database migrations, security, billing, and dependency lockfiles. Destructive intent includes irreversible Git history changes, destructive database operations, and high-risk production data mutations.

## Launch algorithm

`inspect_task_readiness`, `dispatch_task`, `launch_issue`, and `dispatch_ready_tasks` use the same Task-local decision:

1. Resolve the Task's effective lifecycle from durable Task state plus the latest linked Run.
2. Reject terminal/inactive Tasks, duplicate active Runs, or an unacknowledged failed/cancelled Run that requires explicit retry.
3. Resolve only that Task's dependencies. Superseded dependencies delegate immediately to replacement Tasks.
4. Classify risk from declared risk, intent, and paths.
5. Require only the approval and scope appropriate for that risk.
6. At dispatch, reject actual overlapping write scopes with active Runs. Read-only and non-overlapping Tasks remain executable across Issues.

Issue readiness is now an aggregate view. It is `ready` when at least one Task can start immediately and `queueable` when at least one Task can enter the approval bridge. `blockers` contains only true Issue-global faults; Task-specific reasons live in `taskBlockers`. A blocked sibling Task therefore cannot make an independent Task appear blocked.

The default Issue creation mode is `open`. `focus_only` remains a presentation preference for older clients, not an execution or creation lock. The Local Controller's global launch action submits non-conflicting queueable Tasks across every active Issue rather than only the current focus.

## Completion and verification

Named checks are completion evidence, not a universal startup prerequisite. After a successful Run:

- isolated local work must first integrate;
- applicable named checks execute and persist artifacts;
- controller Run evidence and accepted reported command evidence enter `TaskVerification`;
- read-only, low-risk, and eligible medium-risk Tasks auto-complete when their applicable evidence passes;
- high-risk or destructive Tasks stop at `verified` for human acceptance;
- any real check failure moves the Task to `changes_requested`.

`verify_task.reported_commands` accepts bounded argv, exit status, output tails, cwd, and artifact references. Paths are validated with the same MCP read policy used by repository reads.

## Run and Job lifecycle

- `queued` Runs receive a startup deadline. A worker that never starts becomes terminal `unknown` with `finishedAt` and explicit retry semantics.
- A Local Job is not marked finished when a Run is merely dispatched.
- Reading/listing Local Jobs reconciles linked Run status and sets `finishedAt` only at a terminal state.
- Successful Runs automatically continue verification and completion.
- Historical Runs remain evidence and cannot resurrect terminal Tasks.
- Every Run snapshots its execution class and allowed path scope. Readiness previews and actual dispatch use the same overlap predicate, preventing preview/launch contradictions.
- Terminal reconciliation is idempotent and latest-Run-only: successful orphan/cloud Runs continue completion, while failed/cancelled/unknown Runs block with explicit retry semantics.

## Repository access and context control

- Globstar patterns such as `**/*.ts` match both root and nested files.
- Targeted include globs may traverse convenience-excluded directories, while the MCP path policy remains authoritative.
- Search reports policy-denied, binary, oversized, and truncated files explicitly.
- `project_snapshot` is compact and bounded: summaries, limited ready work, limited Run metadata, marker previews, hashes, and truncation flags replace large embedded logs.
- Run logs default to bounded tails and are capped at 1 MiB.
- Connector clients and keepalive detect drift using the same tool-surface name, schema version, surface version, and fingerprint exposed by `/health`, MCP capabilities, runtime state, and the Local Controller snapshot.

## Preserved safety boundaries

V7 deliberately retains hard blocks for:

- sensitive or out-of-scope paths;
- path traversal and repository escape;
- overlapping active write scopes;
- destructive or irreversible Git operations;
- remote publication and cloud mutation without explicit intent;
- real named-check failures;
- destructive production/data changes without manual approval;
- high-risk completion without reviewed Diff/integration and acceptance evidence.

Everything else should be warning-level guidance or task-local evidence, not a project-wide execution lock.
