# Autonomous Goal Loop

## Purpose

repo-harness owns durable local goal execution. Models are workers, reviewers, planners, or handoff recipients. Policy, audit, state, approval gates, verification, and finalization remain inside repo-harness.

**Important feasibility rule:** repo-harness does **not** automatically call the current ChatGPT chat session. ChatGPT UI is a handoff-only supervisor, not a local invokable executor.

## GoalContract vs Issue/Task

| Layer | Owns |
| --- | --- |
| **GoalContract** | Objective-level loop state, provider routing, retry budget, handoff packets, verification evidence |
| **Issue / Task** | Work items, task ledger, runs |

A GoalContract may link to `issueId` / `taskIds`, but the daemon advances goals independently of ChatGPT manually triggering every step.

## Status machine

```
created → planning → ready → dispatching → running → verifying → finalized
                                              ↓
                                          repairing → dispatching
                                              ↓
                                    waiting_for_user | handoff_ready | failed | stopped
```

Each daemon tick performs **at most one** bounded transition per active goal.

## Invokable providers vs handoff-only supervisors

### Invokable (direct dispatch when healthy)

| providerId | kind | Notes |
| --- | --- | --- |
| `direct_edit` | direct_edit | Deterministic small edits applied by harness |
| `codex_cli` | local_cli | Agent CLI: **may edit files and run commands**; policy/verify still harness-owned |
| `grok_cli` | local_cli | Local Grok Build TUI; may edit files/run commands; no live-API flag |
| `claude_cli` | local_cli | Agent CLI: may edit files and run commands |
| `github_copilot_cloud` | cloud_agent | Cloud agent may mutate worktree; external publish needs approval |
| `grok_api` | remote_api | Proposal-only remote API; repo-harness applies patches (+ live mode) |
| `deepseek_api` | remote_api | Proposal-only when DeepSeek key configured |
| `openai_api` | remote_api | Proposal-only when OpenAI key configured |

**Agent CLI vs remote API**

- **local_cli / cloud_agent**: `mayMutateFiles=true`, `mayRunCommands=true`, `requiresApplyByRepoHarness=false` — agents are not artificially blocked from writing source.
- **remote_api**: proposals only; harness applies and verifies.
- External side effects (push, publish, email, etc.) still require approval for all providers.


### Handoff-only supervisors

| providerId | kind | Notes |
| --- | --- | --- |
| `chatgpt_handoff` | handoff_only | Current ChatGPT conversation; **never** `directDispatch: true` |

## Provider health

`provider_health` / `provider_config_status` return **redacted** status only:

- configured / auth present / reachable
- `missing_auth` for missing keys (e.g. Grok without `XAI_API_KEY`)
- `directDispatchAllowed` / `handoffOnly`
- never raw tokens, headers, or private keys

## Executor routing (summary)

- Deterministic small edit → `direct_edit`
- Normal implementation → `codex_cli` if ready
- Repair after Codex / source failure → `grok_api` or `claude_cli` if ready
- Architecture planning → invokable planner if configured, else ChatGPT handoff packet
- iOS / browser → local tooling executes; models plan/analyze only
- Missing auth / destructive / external write → `waiting_for_user`
- No invokable provider → `handoff_ready` + continuation packet

## Grok API configuration

```bash
export XAI_API_KEY=...          # or REPO_HARNESS_XAI_API_KEY
# Live network calls remain gated:
export REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1
```

When Grok is healthy:

1. Router may select `grok_api` for direct dispatch
2. Structured output is required: `summary`, patch/instructions, `changed_files`, `verification_commands`, `risk_notes`
3. **repo-harness** applies patches and runs checks
4. Unsafe output is rejected

Without the live flag, tests and offline ticks use mock structured proposals.

## ChatGPT handoff limitation

ChatGPT is represented as:

```json
{
  "providerId": "chatgpt_handoff",
  "kind": "handoff_only",
  "status": "handoff_only",
  "directDispatch": false
}
```

When ChatGPT (or any UI-only session) is needed, repo-harness writes a durable **handoff packet** with objective, state, blockers, next safe actions, and suggested tool calls—not a fake local invoke of the chat UI.

## Policy gates

No provider bypasses repo-harness gates. Explicit approval is required for:

- destructive file changes
- external writes (email, App Store Connect, browser form submit, push, release/publish)
- broad refactors over threshold
- secret/config sensitive paths (`blocked_by_policy`)

Approval states: `approval_not_required` | `normal_authorization_required` | `strong_confirmation_required` | `blocked_by_policy`.

## MCP / actions

| Action | Role |
| --- | --- |
| `goal_create` / `goal_list` / `goal_get` | Persistence |
| `goal_start` / `goal_continue` / `goal_tick_once` | Loop control |
| `goal_stop` / `goal_finalize` / `goal_status` | Lifecycle / UI |
| `goal_handoff_packet_create` / `goal_handoff_packet_get` | Continuation packets |
| `provider_list` / `provider_health` / `provider_config_status` | Registry |
| `executor_route_preview` / `executor_dispatch` | Routing + gated dispatch |
| `repair_plan` / `repair_continue` | Self-healing integration |

`executor_dispatch` is policy-gated and does not expose raw shell execution.

## Daemon ownership

`GlobalScheduler.tick()` periodically calls `tickGoalLoopsForController` so active GoalContracts advance without ChatGPT driving every step.

## Examples

### Autonomous code repair

1. `goal_create` with acceptance criteria and checks  
2. Daemon ticks: `created → planning → ready → dispatching → running → verifying`  
3. On test failure → `repairing` → re-dispatch to repair provider  
4. Passing evidence → `finalized`

### Codex failure → Grok repair

1. Implementation selected `codex_cli`  
2. Failure class `source_defect` / provider failure  
3. Router prefers `grok_api` when configured and healthy  
4. Grok returns structured proposal; harness applies + verifies  

### ChatGPT handoff packet

1. All invokable providers unavailable  
2. Status → `handoff_ready`  
3. Packet includes objective, blockers, next safe actions, recommended provider `chatgpt_handoff`  

### Provider unavailable fallback

1. `missing_auth` on Grok reports `MISSING_XAI_API_KEY` (not opaque failure)  
2. Router falls through to other invokable providers or handoff  

### Final verification and clean closeout

1. `goal_finalize` requires verification evidence when policy says so  
2. Terminal status `finalized` or `failed` / `stopped`  

## Related docs

- `docs/repo-harness-runtime-self-healing-loop.md` — observe / maintenance / model repair layers  
- `docs/repo-harness-chatgpt-controller.md` — ChatGPT control plane facade  
- Stage-2 workloop: WorkContract + `rh_work` (task-scoped); GoalContract sits above that layer  
