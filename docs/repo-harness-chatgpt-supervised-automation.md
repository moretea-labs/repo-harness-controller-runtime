# ChatGPT-Supervised Automation

## Purpose

ChatGPT-Supervised Automation lets a repository project continue across disconnected ChatGPT sessions without handing the entire project loop to Codex.

- **ChatGPT** owns goal interpretation, review, scope changes, retry guidance, and final readiness decisions.
- **repo-harness** owns durable Campaign state, scheduling, concurrency, leases, retries, recovery, and evidence.
- **Codex and other executors** retain broad implementation and interactive-validation capabilities. Each Campaign defaults to its own long-lived feature worktree, and Agent tasks use temporary child worktrees that integrate only into that Campaign branch; existing safety and release gates remain authoritative.

The loop stops at `ready_for_human_acceptance`. It never merges `main`, publishes, deploys, or records final completion without an explicit human acceptance call.

## Entity model

A `Campaign` contains:

- an immutable workspace binding (checkout, branch, and base revision);

- immutable identity and idempotency keys;
- revisioned goals with a SHA-256 `goalHash`;
- a dependency DAG of executable tasks;
- budgets for parallelism, execution Jobs, reviews, retries, and packet size;
- persisted Checkpoints and Supervisor decisions;
- the next durable reconciliation timestamp.

A `Checkpoint` is a non-blocking review boundary. Waiting for ChatGPT is represented by persisted state; no worker, workspace lease, or scheduler lock is held.

## Lifecycle

```text
create_campaign
  -> active
  -> dispatch bounded ready tasks
  -> reconcile Job / Run results
  -> waiting_for_supervisor
  -> submit_campaign_review
  -> active | paused | ready_for_human_acceptance
  -> accept_campaign
  -> completed
```

A failed task opens a failure Checkpoint after its automatic retry budget is exhausted. Only dependent tasks become blocked; unrelated ready tasks continue until the Campaign concurrency budget is full.

## Concurrency and deadlock rules

1. There is no global Campaign execution lock.
2. Each Campaign mutation uses a short per-Campaign lock.
3. A Campaign lock is never retained while an executor, browser, model, or human is running.
4. Execution Jobs use the existing resource-claim and fencing-token system.
5. Campaign creation defaults to a managed feature worktree. Agent operations force `isolate: true`, so their temporary worktrees integrate into the Campaign checkout rather than the production checkout.
6. Duplicate scheduler delivery is suppressed by deterministic request IDs.
7. Retry delay is persisted with bounded exponential backoff and deterministic jitter.
8. Pull-mode Supervisor waiting is event-driven and does not generate periodic write traffic.

## MCP tools

- `create_campaign`
- `list_campaigns`
- `get_campaign`
- `add_campaign_task`
- `pause_campaign`
- `resume_campaign`
- `cancel_campaign`
- `get_campaign_review_packet`
- `submit_campaign_review`
- `reconcile_campaign`
- `accept_campaign`

`create_campaign` accepts existing MCP operations as tasks. Campaign-control operations cannot recursively invoke Campaign-control operations.

### Example task

```json
{
  "task_id": "T1",
  "title": "Implement the feature",
  "operation": "dispatch_task",
  "arguments": {
    "issue_id": "ISS-123",
    "task_id": "T1",
    "agent": "codex"
  },
  "depends_on": [],
  "review_required": true,
  "executor": {
    "enable_dev_runner": true,
    "enable_chatgpt_browser": true,
    "allowed_agents": ["codex"]
  }
}
```

The runtime overwrites `isolate` to `true` for Agent operations. It does not impose a narrow file allowlist unless the underlying Task already defines one.


## Workspace isolation

By default, `create_campaign` creates a deterministic long-lived branch and worktree:

```text
campaign/<title>-<request-hash>
.ai/harness/worktrees/campaign-<request-hash>
```

The source checkout remains active and unchanged. The Campaign stores its `checkoutId`, branch, path, and base revision. Every child ExecutionJob carries that checkout identity, and the Worker resolves the recorded checkout instead of falling back to the repository's active checkout. Agent tasks may still create short-lived task worktrees, but automatic integration targets the Campaign worktree.

To explicitly run a Campaign in the selected checkout, pass:

```json
{ "workspace": { "mode": "current" } }
```

This opt-out is intended for controlled maintenance only. Human acceptance does not merge the Campaign branch into `main` and does not remove the worktree; merge and cleanup remain separate authorized operations.

## Supervisor modes

### Pull mode

The default. ChatGPT or another client reads an open packet using `get_campaign_review_packet`, then submits a nonce-bound decision. No polling Job is created.

### Operation mode

A configured safe MCP operation is triggered for an open Checkpoint. Trigger Jobs are bounded, retried with cooldown, and never hold Campaign locks. A successful trigger that does not submit a decision before the configured response timeout is retried and eventually pauses the Campaign for human attention. Recursive Campaign-control operations are rejected.

### Workspace Agent mode

`workspace_agent` mode triggers a published ChatGPT Workspace Agent through a dedicated ExecutionJob target. It does not add or alter legacy MCP tools.

```json
{
  "mode": "workspace_agent",
  "workspace_agent_id": "agtch_your_published_agent",
  "conversation_key": "repo-harness-project-a",
  "max_trigger_attempts": 3,
  "decision_timeout_ms": 300000
}
```

Set the access token only in the Controller process environment:

```bash
export OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN="..."
```

The token is never copied into Campaign records, Job arguments, prompts, evidence, or logs. The trigger Job sends only the stable agent id, a bounded instruction, a stable conversation key, and an attempt-specific idempotency key. ChatGPT then reads the packet with `get_campaign_review_packet` and writes the durable decision with `submit_campaign_review`.

Each HTTP retry of the same trigger Job keeps the same idempotency key. A later Campaign trigger attempt uses a new key so a missing decision can be retried without creating duplicates during transport retries. Trigger Jobs claim no repository or worktree resource and therefore cannot serialize unrelated implementation work.

## Review decisions

Supported actions:

- `accept`
- `request_changes`
- `retry`
- `skip`
- `pause`
- `resume`
- `approve_final`
- `revise_goal`
- `escalate`

A review is accepted only when the checkpoint nonce and goal revision match. Request IDs are idempotent; conflicting reuse is rejected. A goal revision supersedes open packets from the old goal and reopens bounded packets with a new `goalHash`.

For an Agent retry, Supervisor guidance is appended to the retried Run prompt. The executor remains free to choose the implementation approach and relevant files, subject to existing safety, budget, and lifecycle controls.

## Recovery

After restart, Campaign records and indexes are read from the repository Controller storage. Reconciliation then:

- reconnects persisted Execution Jobs;
- follows nested Agent Runs to terminal state;
- marks missing or orphaned work as a bounded failure;
- releases work by relying on the existing Job/lease reconciler;
- resumes only from durable task or Checkpoint boundaries.

A ChatGPT conversation is not part of Campaign truth. Any later session can read the Campaign and continue from the current Checkpoint.

## Validation

Run:

```bash
bun test tests/runtime/chatgpt-supervised-campaign.test.ts
bun run check:type
bun run smoke:supervised-automation
bun run check:controller-v8
```
