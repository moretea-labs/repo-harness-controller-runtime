---
name: repo-harness-chatgpt-bridge
description: Use when setting up or operating the repo-harness ChatGPT Controller, GitHub Issue Launcher, local Agent Runs, or GitHub Copilot cloud sessions.
---

# repo-harness-chatgpt-bridge

You are operating inside a repo-harness adopted repository.

## Primary model

Treat ChatGPT as the project controller. Repository-backed Issue/Task/Run state is authoritative; chat memory is not.

Use this chain for new work:

```text
understand implementation
  -> create/update Issue
  -> inspect launch readiness
  -> optionally publish to GitHub Issues/Project
  -> launch narrow Tasks
  -> review local diff or GitHub pull request
  -> record Verification Gate evidence
  -> accept or request changes
```

The legacy PRD -> checklist Sprint -> Codex Goal flow remains available for large product work and compatibility, but it is not the default execution path for every task.

## First reads

1. `docs/repo-harness-chatgpt-mcp-setup.md`
2. `docs/repo-harness-chatgpt-controller.md`
3. `docs/repo-harness-github-issue-launcher.md` when GitHub is involved
4. `repo-harness mcp doctor --repo .`
5. `repo-harness controller board --repo .`

Do not rely on prior chat history when durable state exists.

## Controller responsibilities

1. Inspect current code, documents, Git state, Issues, Tasks, and Runs before planning.
2. Keep each Task narrow, dependency-aware, path-scoped, and independently reviewable.
3. Run `inspect_issue_readiness` or `prepare_issue_launch` before launch.
4. Use local `codex`/`claude` Runs for local-only tooling and `github-copilot` for work that should be visible in GitHub Agents and a draft PR.
5. Use `append_task`, `split_task`, `supersede_task`, and `set_task_dependencies` when execution changes the plan.
6. Review every completed Run. Agent success is not acceptance evidence.
7. Record named check results and criterion-level evidence with `verify_task` before `accept_task`.
8. Never automatically merge, push, close a remote Issue, or bypass repository protections.

## Setup commands

```bash
repo-harness mcp setup chatgpt --repo .
repo-harness mcp setup codex --repo . --scope project
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude --tunnel quick
```

GitHub integration check:

```bash
repo-harness controller github-status --repo .
```

Execution visibility:

```bash
repo-harness controller board --repo .
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log
```

## Safety boundaries

- Do not expose arbitrary shell input through MCP.
- Do not reveal or commit OAuth passphrases, bearer tokens, tunnel tokens, cookies, or credentials.
- Do not weaken immutable secret, credential, Git-internal, lockfile, or protected CI denies to make a Task pass.
- Local Agent workers must not commit, merge, or push automatically.
- GitHub Copilot cloud sessions may create draft pull requests only when explicitly launched; repo-harness never merges them automatically.
- Local isolated Runs must be reviewed and integrated before verification.
- A Task cannot be accepted until the Verification Gate passes.

## Compatibility handoff

For an existing `.ai/harness/handoff/codex-goal.md`, preserve the referenced PRD and checklist Sprint, execute one task card at a time, run focused checks, and leave exact handoff evidence. Do not convert an active Controller Issue back into one large Goal unless the user explicitly requests the legacy workflow.

## Troubleshooting

- Missing Controller tools: restart the MCP server and rescan or recreate the ChatGPT Connector.
- Only PRD/Sprint tools are visible: ChatGPT has an old Planner tool snapshot.
- Local Run looks hidden: use `repo-harness controller watch <RUN-ID> --log`.
- GitHub Session does not start: run `repo-harness controller github-status --repo .`, update/authenticate `gh`, and confirm Copilot coding-agent access.
- Task cannot launch: inspect the readiness blockers rather than bypassing them.
- Task cannot be accepted: integrate local work when required and record passing `verify_task` evidence.
