# Session-Aware Execution and Authorization

> Status: **Runtime Authority**

## Scope

Controller MCP execution is bound to a durable Session Context and Work Handle. A
Work Handle is the execution binding for an existing WorkContract; it is not a
second task lifecycle. The binding records repository, checkout/worktree, branch,
Goal, principal, controller instance, and the captured permission revision.

## Execution path

```text
MCP transport
  -> Session Context
     -> Work Handle + WorkContract
        -> cheap/full validation
           -> unified authorization decision
              -> repository command or structured Git operation
                 -> bounded result / resultRef + timing audit
```

Ordinary read, test, build, lint, format, local edit, and repository Git
operations inside the active worktree are automatically allowed when Full Access
is active. Request mode uses a GoalDelegation captured by `work_prepare` for the
same session, repository, work, Goal, and permission revision. This removes
per-command interruptions without creating a parallel policy engine.

## Authorization boundary

The unified decision is one of:

- `allow`, with source `policy`, `full_access`, `goal_delegation`,
  `gpt_risk_delegate`, or `user_confirmation`;
- `user_confirmation_required`, with a durable `approvalRequestId`, exact
  consequences, and a continuation that can be retried from the conversation;
- `deny`, for example secret and credential access.

Full Access does not authorize repository escape, secret access, destructive
loss of existing user work, force push, remote publication, deployment, or
other external side effects. A Goal delegation has the same hard boundaries.

## Invalidation

Delegation and approval state are invalid when any of these change: repository,
work handle, Goal, principal/session, controlled worktree, command parameters,
risk class, or permission revision. Controller instance changes explicitly
invalidate persisted sessions so an old process cannot continue with stale
authority.

## Natural-language approval

The Controller persists approval requests under repository-scoped Controller
Home storage. `approval_resolve` records a confirmation from the current
conversation; GUI approval is an optional projection, not the only continuation
path. A resolved request may be retried only with the same identity, permission
revision, and command parameters. Any incomplete approval response is an
internal error: user-facing responses must contain a request id and continuation.

## Compatibility and evidence

Legacy stateless repository tools remain available. They use the same command
classifier and authorization result, while composite execution tools provide
session/work validation, idempotent finalization, bounded result references, and
MCP timing records. Result references are Controller Home scoped to session,
principal, repository, and optional work handle.
