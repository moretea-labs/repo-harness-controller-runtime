# Access and Public Surface Architecture Review — 2026-07-11

## Verdict

The Work permission snapshot is directionally correct: Goal Workloop stores `constraints.accessMode` when the WorkContract starts, and later operations continue to use that captured mode. The current product surface is nevertheless blocked by the following architecture gaps.

## Confirmed findings

### P0 — Thin Gateway is not thin at discovery time

`DEFAULT_CONTROLLER_TOOL_NAMES` points to `STABLE_CONTROLLER_TOOL_NAMES`. That set includes repository editing, command execution, Git, Issue/Task, Campaign, plugin, browser, iOS, recovery, and maintenance tools. `core` and `advanced` also resolve to the same set.

Impact:

- ChatGPT and other MCP clients still choose among a large ambiguous tool surface.
- Schema and prompt cost grows with every internal capability.
- Product facade and compatibility APIs are indistinguishable at discovery time.
- There is no real small facade profile for constrained clients.

Required follow-up:

1. Define a real facade/bootstrap public profile.
2. Keep the broad compatibility surface opt-in.
3. Make the `thin` readiness claim depend on the served profile, not only schema consistency.

### P0 — “Start execution” does not establish execution

`rh_work.start` and the Local Controller `/work/start` path route through `routeWorkStart`. Direct Control returns an edit recommendation without applying it. Goal Workloop creates a WorkContract, but repository execution requires a separate delegate or advanced tool. The GUI button is labelled “开始执行”, which promises more than the facade guarantees.

Impact:

- A user can receive a running WorkContract with no executor attached.
- `continue` may only recommend context, verification, or finalization.
- The facade-only path cannot complete an ordinary repository change by itself.

Required follow-up:

1. Add an explicit execution transition to `rh_work` that dispatches the selected editor or worker.
2. Persist dispatch and mutation evidence on the WorkContract.
3. Either make GUI Start atomically create and dispatch, or rename it to “创建任务” and show `created_not_dispatched`.

### P1 — Request approval could be bypassed by omitted caller hints

The policy gate returns `approval_required` for Request-mode workspace writes. The work router previously created a handoff only when the caller also supplied `requiresApproval`, `requiresUserApproval`, destructive, remote, or secret flags. A normal multi-file Request-mode workloop could therefore create a running WorkContract despite the policy decision.

Resolved in this change:

- Every `approval_required` policy decision blocks WorkContract creation.
- The approval handoff preserves the access-mode snapshot for replay.
- A targeted regression test covers callers that omit the approval hint.

### P1 — Access preview returned contradictory toolset data

The preview target hard-coded `effectiveToolset: full`, while the effective controller compatibility label is `advanced`, and the same payload reported `toolsetChanged: false`.

Resolved in this change:

- Preview reports the current effective toolset because Request versus Full Access changes approval policy, not schema/toolset.

### P1 — Verification evidence is not mutation evidence

`hasExecutionEvidence` treats any check record as execution evidence. A WorkContract may therefore pass a check and finalize without recorded edit, worker dispatch, worktree, or changed-file evidence. That may be valid for read-only review work but is insufficient for mutation objectives.

Required follow-up:

1. Classify each WorkContract as read-only or mutating.
2. Require mutation evidence for mutation objectives.
3. Do not infer source execution from a check record alone.

### P1 — Access configuration has two sources of truth

The facade persists both MCP service-level access mode and per-repository policy. Repository execution reads the repository policy, while diagnostics also expose service-level state. These can diverge across repository-only changes or mixed repository policies.

Required follow-up:

1. Make per-repository policy the effective execution source of truth.
2. Treat service-level mode only as an onboarding/default value and name it accordingly.
3. Display mixed repository state explicitly.

## Usage-surface assessment

| Scenario | Current behavior | Assessment |
| --- | --- | --- |
| Read/search repository | Works | Not blocked |
| Small bounded edit in Request | Policy permits it, but facade only recommends an edit | Execution blocked |
| Multi-file local work in Request | Requests approval | Fixed in this change |
| Normal local development in Full Access | Policy permits it; facade still needs a separate executor path | Partially blocked |
| Existing Work after mode switch | Keeps captured access mode | Correct |
| Remote/destructive/secret effects | Remain gated or denied | Correct |
| Client requiring a small MCP schema | No real small default profile | Blocked |
| GUI user clicking “开始执行” | May only create orchestration state | Misleading/blocking |

## Recommended implementation order

1. Make `rh_work.start` atomically dispatch, or return explicit `created_not_dispatched` state.
2. Introduce a real facade/bootstrap profile and move the broad schema behind opt-in compatibility mode.
3. Separate mutation evidence from verification evidence.
4. Consolidate global default and per-repository effective access semantics.
5. Add one end-to-end acceptance path: objective → dispatch → mutation evidence → checks → finalize → commit/merge/cleanup.
