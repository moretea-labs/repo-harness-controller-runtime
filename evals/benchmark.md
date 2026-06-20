# Skill Benchmark Report

Latest iteration: `iteration-20260614-202417`

Workspace root: `/Users/ancienttwo/Projects/repo-harness-workspace`

Generated: 2026-06-14T12:41:02.964Z

## Quality Metrics

| Metric | Value |
| --- | ---: |
| full_test_count | 4 |
| dry_run_count | 0 |
| dry_run_ratio | 0.0% |
| grader_pass_rate | 56.3% (9/16) |
| effectiveness_authority | authoritative |

Effectiveness evidence is authoritative for this benchmark run.

## Command Matrix

| Agent | Profile | Command |
| --- | --- | --- |
| claude | with_skill | `claude -p --output-format text --no-session-persistence --permission-mode bypassPermissions --add-dir /Users/ancienttwo/Projects/agentic-dev 'Check whether this repo-harness harness is ready to merge. Run the workflow gates, inspector, task sync, and migration dry-run and give me the release readiness verdict.'` |
| claude | without_skill | `claude -p --output-format text --no-session-persistence --permission-mode bypassPermissions --disable-slash-commands 'Check whether this repo-harness harness is ready to merge. Run the workflow gates, inspector, task sync, and migration dry-run and give me the release readiness verdict.'` |
| codex | with_skill | `codex exec -C /Users/ancienttwo/Projects/repo-harness-workspace/iteration-20260614-202417/codex/with_skill/route-workflow-check --dangerously-bypass-approvals-and-sandbox -o /Users/ancienttwo/Projects/repo-harness-workspace/iteration-20260614-202417/codex/with_skill/route-workflow-check/final-response.md --add-dir /Users/ancienttwo/Projects/agentic-dev 'Check whether this repo-harness harness is ready to merge. Run the workflow gates, inspector, task sync, and migration dry-run and give me the release readiness verdict.'` |
| codex | without_skill | `codex exec -C /Users/ancienttwo/Projects/repo-harness-workspace/iteration-20260614-202417/codex/without_skill/route-workflow-check --dangerously-bypass-approvals-and-sandbox -o /Users/ancienttwo/Projects/repo-harness-workspace/iteration-20260614-202417/codex/without_skill/route-workflow-check/final-response.md 'Check whether this repo-harness harness is ready to merge. Run the workflow gates, inspector, task sync, and migration dry-run and give me the release readiness verdict.'` |

## claude / with_skill

| Eval | Status | Exit / Graders | Duration | Changed Files | Raw Artifacts |
| --- | --- | --- | ---: | ---: | --- |
| route-workflow-check | failed | 1 / graders fail (3) | 27807ms | 0 | [workspace](../repo-harness-workspace/iteration-20260614-202417/claude/with_skill/route-workflow-check) |

### route-workflow-check

- Eval: `12`
- Workspace: [../repo-harness-workspace/iteration-20260614-202417/claude/with_skill/route-workflow-check](../repo-harness-workspace/iteration-20260614-202417/claude/with_skill/route-workflow-check)
- Changed files: none
- Diff summary: no diff captured
- Agent status: failed (exit 1)
- Graders: failed (1/4 passed)
- Final response excerpt: (no final response captured)
- Expectations:
  - Uses check as a verification entrypoint, not a mutating repair.
  - Includes inspector and migration dry-run in the evidence set.
  - Gives a readiness verdict grounded in command output.
- Grader results:
  - PASS files_exist: files_exist: final-response.md
  - FAIL files_contain: files_contain: final-response.md !~ repo-harness-check
  - FAIL files_contain: files_contain: final-response.md !~ check-task-sync
  - FAIL files_contain: files_contain: final-response.md !~ migrate-project-template.*dry-run

## claude / without_skill

| Eval | Status | Exit / Graders | Duration | Changed Files | Raw Artifacts |
| --- | --- | --- | ---: | ---: | --- |
| route-workflow-check | failed | 0 / graders fail (3) | 547291ms | 0 | [workspace](../repo-harness-workspace/iteration-20260614-202417/claude/without_skill/route-workflow-check) |

### route-workflow-check

- Eval: `12`
- Workspace: [../repo-harness-workspace/iteration-20260614-202417/claude/without_skill/route-workflow-check](../repo-harness-workspace/iteration-20260614-202417/claude/without_skill/route-workflow-check)
- Changed files: none
- Diff summary: no diff captured
- Agent status: success (exit 0)
- Graders: failed (1/4 passed)
- Final response excerpt: ## 发布就绪裁定：🔴 不可合并 —— 而且你点名的四道闸门在这个仓库里根本不存在 先说最关键的一点：你让我跑的 workflow gates / inspector / task sync / migration dry-run，**没有一个有对应的实现可以运行**。我没有伪造执行结果。这个仓库就叫 `audit-drift-fixture`(见 `package.json` name),它本身就是一份"声明的流程"和"实际的代码…
- Expectations:
  - Uses check as a verification entrypoint, not a mutating repair.
  - Includes inspector and migration dry-run in the evidence set.
  - Gives a readiness verdict grounded in command output.
- Grader results:
  - PASS files_exist: files_exist: final-response.md
  - FAIL files_contain: files_contain: final-response.md !~ repo-harness-check
  - FAIL files_contain: files_contain: final-response.md !~ check-task-sync
  - FAIL files_contain: files_contain: final-response.md !~ migrate-project-template.*dry-run

## codex / with_skill

| Eval | Status | Exit / Graders | Duration | Changed Files | Raw Artifacts |
| --- | --- | --- | ---: | ---: | --- |
| route-workflow-check | success | 0 / graders pass | 162800ms | 0 | [workspace](../repo-harness-workspace/iteration-20260614-202417/codex/with_skill/route-workflow-check) |

### route-workflow-check

- Eval: `12`
- Workspace: [../repo-harness-workspace/iteration-20260614-202417/codex/with_skill/route-workflow-check](../repo-harness-workspace/iteration-20260614-202417/codex/with_skill/route-workflow-check)
- Changed files: none
- Diff summary: no diff captured
- Agent status: success (exit 0)
- Graders: passed (4/4 passed)
- Final response excerpt: **结论：不 ready to merge。** P1 map：这个 fixture 不是完整 installed harness。repo 本体只有 `package.json`、`.claude/settings.json`、`docs/PROGRESS.md`、`tasks/todo.md`；没有 `.ai/harness/`、root `scripts/`、`tasks/todos.md`、`docs/spec.md`、`de…
- Expectations:
  - Uses check as a verification entrypoint, not a mutating repair.
  - Includes inspector and migration dry-run in the evidence set.
  - Gives a readiness verdict grounded in command output.
- Grader results:
  - PASS files_exist: files_exist: final-response.md
  - PASS files_contain: files_contain: final-response.md =~ repo-harness-check
  - PASS files_contain: files_contain: final-response.md =~ check-task-sync
  - PASS files_contain: files_contain: final-response.md =~ migrate-project-template.*dry-run

## codex / without_skill

| Eval | Status | Exit / Graders | Duration | Changed Files | Raw Artifacts |
| --- | --- | --- | ---: | ---: | --- |
| route-workflow-check | failed | 0 / graders fail (1) | 266447ms | 0 | [workspace](../repo-harness-workspace/iteration-20260614-202417/codex/without_skill/route-workflow-check) |

### route-workflow-check

- Eval: `12`
- Workspace: [../repo-harness-workspace/iteration-20260614-202417/codex/without_skill/route-workflow-check](../repo-harness-workspace/iteration-20260614-202417/codex/without_skill/route-workflow-check)
- Changed files: none
- Diff summary: no diff captured
- Agent status: success (exit 0)
- Graders: failed (3/4 passed)
- Final response excerpt: **结论：不 ready to merge。** **P1 Map** 当前 repo 是未完成的 harness fixture：只有 6 个 tracked files：`.claude/settings.json`、`AGENTS.md`、`CLAUDE.md`、`docs/PROGRESS.md`、`package.json`、`tasks/todo.md`。没有 `.ai/harness/workflow-contract.…
- Expectations:
  - Uses check as a verification entrypoint, not a mutating repair.
  - Includes inspector and migration dry-run in the evidence set.
  - Gives a readiness verdict grounded in command output.
- Grader results:
  - PASS files_exist: files_exist: final-response.md
  - FAIL files_contain: files_contain: final-response.md !~ repo-harness-check
  - PASS files_contain: files_contain: final-response.md =~ check-task-sync
  - PASS files_contain: files_contain: final-response.md =~ migrate-project-template.*dry-run
