# GitHub Issue Launcher and Copilot Cloud Sessions

## Product boundary

repo-harness uses two complementary state layers:

- **Local controller state is authoritative for execution:** `tasks/issues/*.issue.json`, Task dependencies, Run IDs, verification evidence, edit sessions, and local worktree integration.
- **GitHub is the collaborative surface:** repository Issues, optional Task sub-issues, GitHub Projects boards, Copilot coding-agent sessions, draft pull requests, comments, and browser-visible logs.

Publishing is explicit. repo-harness does not silently overwrite GitHub Issues, close them, merge pull requests, or treat a remote checkbox as local verification.


## Optional GitHub plugin

GitHub integration is disabled by default. Local Controller files remain authoritative even after the plugin is enabled. Configure it explicitly:

```bash
repo-harness controller github configure --enable \
  --github-repo owner/repository --sync-mode manual --include-tasks
repo-harness controller github status --json
```

The configuration is stored at `.repo-harness/plugins/github.json` and contains no credential. Authentication remains in the local `gh` CLI. `manual` and `checkpoint` are policy labels; both require an explicit publish or refresh action, so no hidden background network write can block local Task progress.

The corresponding MCP tools are `get_github_plugin_status` and `configure_github_plugin`. Existing low-level GitHub tools remain available for compatibility.

## Verify the loaded tool surface

After connecting ChatGPT, call `controller_capabilities`. It should report `controller-execution-first-v7` and list direct-change evidence, Issue Launcher, GitHub session, Run inspection, and Verification Gate tools. If ChatGPT only shows legacy planning tools, refresh or recreate the connector so it reloads the MCP tool schema.

## What “GitHub session” means

A GitHub session in repo-harness is a **GitHub Copilot coding-agent cloud session**, not a hidden local Codex process. The session runs against a GitHub repository and can create a draft pull request. Its progress is visible from GitHub's Agents surface, the session log, and the linked pull request.

Local `codex` and `claude` Runs remain available. They run as detached local worker processes, normally in isolated worktrees. Their progress can be read through MCP or watched from the terminal:

```bash
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log
```

The `--log` view streams local Codex/Claude output while the process is running and polls GitHub cloud-session logs when available.

## Prerequisites

1. Install GitHub CLI `gh`.
2. Authenticate it with an account that can read/write Issues in the target repository:

```bash
gh auth login
```

3. For GitHub Projects, authorize the required scope with `gh auth refresh -s project`, then ensure the account can add items to the selected Project.
4. For Copilot cloud sessions, the account and repository must have GitHub Copilot coding-agent access. The agent-task CLI/API is preview functionality and may require a recent GitHub CLI.
5. Verify the local environment:

```bash
repo-harness controller github status --repo .
```

The equivalent MCP tool is `github_status`.

## Publishing an Issue

ChatGPT should first create and refine the local controller Issue. Then call:

```text
publish_issue_to_github(
  issue_id = "ISS-...",
  repo = "owner/repository",
  include_tasks = true,
  project_owner = "owner-or-org",
  project_number = 3
)
```

This operation:

- creates or updates the parent GitHub Issue;
- optionally creates each active Task as a GitHub sub-issue;
- stores the remote URLs and issue numbers back in local controller state;
- optionally adds the parent and Task Issues to a GitHub Project;
- falls back to body-based parent links when the installed `gh` does not support sub-issue creation;
- does not fail publication only because optional labels are missing.

Use `refresh_github_issue` to read the current remote state. Use `close_github_issue` only after local completion and human review.

## Issue Launcher flow

Before execution, ChatGPT should call:

```text
inspect_issue_readiness
prepare_issue_launch
```

The readiness gate checks:

- Issue summary and Issue-level acceptance criteria;
- active Task presence;
- Task objective, acceptance criteria, path scope, and named checks;
- dependency graph validity;
- high-risk cloud-agent warnings;
- currently launchable Tasks and suggested parallelism.

Execution is blocked when readiness blockers exist. Once ready, use `launch_issue` or `dispatch_task`.

## Choosing an execution provider

Set each Task's `recommendedAgent` to one of:

- `codex`: local Codex CLI worker;
- `claude`: local Claude CLI worker;
- `github-copilot`: GitHub Copilot coding-agent cloud session.

Example Task for a GitHub session:

```json
{
  "title": "Implement notification action routing",
  "objective": "Connect notification actions to the unified DoseService write path.",
  "allowedPaths": ["ios/Domain/**", "ios/Tests/**"],
  "checks": ["ios-domain-tests"],
  "acceptanceCriteria": ["Taken, skipped, and postponed actions use the same write chain."],
  "risk": "medium",
  "recommendedAgent": "github-copilot"
}
```

Launch parameters can specify:

- GitHub repository;
- base branch/ref;
- optional model identifier;
- whether a draft pull request should be created;
- maximum parallel Tasks.

## Watching execution

MCP tools:

- `get_task_run`
- `get_task_run_events`
- `get_task_run_log`
- `list_task_runs`

Local CLI:

```bash
repo-harness controller board --repo .
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log
```

For GitHub cloud Runs, the Run metadata includes the session URL when GitHub returns one and the draft pull-request URL once available. Follow-up steering and cancellation should currently be done from GitHub's Agents UI or pull-request experience. repo-harness does not pretend that all local and cloud agents support the same continuation protocol.

## Dynamic Task management

Execution plans are no longer frozen after the first Run. The controller can:

- `append_task`
- `split_task`
- `supersede_task`
- `set_task_dependencies`

Existing Task IDs remain stable. New Tasks receive the next available `T<n>` identifier. Splitting a Task supersedes the original and rewires downstream dependencies to the replacement Tasks.

## Verification Gate

An Agent's success result is not acceptance evidence.

The normal lifecycle is:

```text
ready -> running -> review -> integrated -> verifying -> verified -> done
```

For local isolated Runs:

1. inspect `get_task_diff`;
2. integrate the reviewed changes with `integrate_task_run`;
3. run named checks;
4. call `verify_task` with check results and acceptance evidence;
5. call `accept_task`.

For GitHub cloud Runs:

1. inspect the cloud session and draft pull request in GitHub;
2. record the actual check results and criterion-level evidence with `verify_task`;
3. call `accept_task` only after review policy is satisfied;
4. merge and close remote artifacts through the normal human-approved GitHub workflow.

`accept_task` rejects Tasks that have not passed the Verification Gate. It also rejects unintegrated local worktree Runs.

## Recommended operating prompt

```text
Use repo-harness as the project controller. Read the current board and relevant implementation, create or update the local Issue, inspect launch readiness, and publish it to the repository GitHub Project. Split it into narrow dependency-aware Tasks. Use GitHub Copilot sessions for Tasks that should be visible in GitHub and local Codex for work that depends on local-only tooling. Launch at most two non-overlapping Tasks. Track every Run, review its diff or pull request, record verification evidence, and do not accept or close anything without passing the Verification Gate.
```
