import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { isIP } from 'net';
import { dirname, join, relative } from 'path';
import {
  ensureMcpBearerToken,
  ensureMcpOAuthPassphrase,
  loadMcpLocalConfig,
  loadMcpRuntimeState,
  mcpOAuthPath,
  mcpRuntimeStatePath,
  mcpTokenPath,
} from './auth';
import { resolveMcpRepoRoot } from './repo';
import { CONTROLLER_TOOL_SURFACE, DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS } from '../controller/runtime-config';

export interface McpSetupResult {
  status: 'ok';
  repoRoot: string;
  changed: string[];
  lines: string[];
}

const REQUIRED_CODEX_TOOLS = [
  'harness_status',
  'read_workflow_file',
  'latest_handoff',
  'latest_checks',
  'prepare_codex_goal_from_sprint',
  'write_codex_goal',
  'run_workflow_check',
];

const CHATGPT_MCP_ENDPOINT_PLACEHOLDER = '<https-tunnel-url>/mcp';
const CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER = '<named-tunnel-host>';
const DEFAULT_CHATGPT_MCP_SERVER_NAME = 'repo-harness-controller-v2';
const LEGACY_DEFAULT_SERVER_NAMES = new Set(['repo-harness', 'repo-harness-controller-v1']);
const ENDPOINT_ERROR = 'expected a public HTTPS URL exactly ending in /mcp with no username, password, query, or fragment';
const SERVER_NAME_ERROR = 'expected a ChatGPT MCP server name using 1-80 letters, numbers, spaces, dots, underscores, or hyphens';

function writeFileIfChanged(path: string, content: string, changed: string[]): void {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  changed.push(path);
}

function ensureGitignoreEntries(repoRoot: string, entries: string[], changed: string[]): void {
  const path = join(repoRoot, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = current.split(/\r?\n/);
  let next = current.trimEnd();
  for (const entry of entries) {
    if (lines.includes(entry)) continue;
    next += `${next.length > 0 ? '\n' : ''}${entry}`;
  }
  next += '\n';
  writeFileIfChanged(path, next, changed);
}

function isPrivateOrLocalIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 192 && b === 0 ||
    a === 198 && (b === 18 || b === 19) ||
    a >= 224;
}

function isPrivateOrLocalIPv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb');
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  const ipCandidate = normalized.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(ipCandidate);
  if (ipVersion === 4) return isPrivateOrLocalIPv4(ipCandidate);
  if (ipVersion === 6) return isPrivateOrLocalIPv6(ipCandidate);
  return false;
}

function normalizePublicMcpEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  const trimmed = endpoint.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (_error) {
    throw new Error(`invalid --endpoint "${endpoint}" (${ENDPOINT_ERROR})`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.pathname !== '/mcp' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    isPrivateOrLocalHost(parsed.hostname)
  ) {
    throw new Error(`invalid --endpoint "${endpoint}" (${ENDPOINT_ERROR})`);
  }
  return parsed.toString();
}

function normalizeChatgptMcpServerName(value: string | undefined): string {
  const trimmed = (value ?? DEFAULT_CHATGPT_MCP_SERVER_NAME).trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 80 ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(trimmed) ||
    / {2,}/.test(trimmed)
  ) {
    throw new Error(`invalid --server-name "${value ?? ''}" (${SERVER_NAME_ERROR})`);
  }
  return trimmed;
}

export function chatgptGuideMarkdown(endpoint = CHATGPT_MCP_ENDPOINT_PLACEHOLDER): string {
  return `# repo-harness ChatGPT Controller Setup

## Purpose

The \`controller\` profile makes ChatGPT the project control plane. ChatGPT can inspect code and documents, maintain durable Issues and dependency-aware Tasks, apply bounded direct edits, publish Issues to GitHub Projects, dispatch short local Codex/Claude runs or visible GitHub Copilot cloud sessions, and review the resulting state. Repository files remain the source of truth; chat history is not required for recovery.

## Prerequisites

- A repo-harness adopted repository.
- Bun and the \`repo-harness\` CLI on PATH.
- Codex and/or Claude CLI installed for delegated local execution.
- GitHub CLI \`gh\` authenticated when GitHub Issues, Projects, or Copilot cloud sessions are used.
- ChatGPT workspace access to Developer Mode and custom MCP Connectors.
- A public HTTPS \`/mcp\` endpoint for ChatGPT.

For a shared editable installation, keep the repo-harness checkout at a stable path such as \`~/DevProjects/repo-harness\`, run \`bun install\`, and reinstall the CLI after pulling updates.

## One-time setup

\`\`\`bash
repo-harness mcp setup chatgpt --repo .
repo-harness mcp keepalive --repo . --profile controller --enable-dev-runner --dev-runner-agents codex,claude --tunnel quick
\`\`\`

The \`controller\` profile starts a localhost-only visual controller at \`http://127.0.0.1:8766/\` by default. It is separate from the public MCP tunnel. Use it to launch ready Tasks, create small Codex/Claude sessions, approve local Jobs, inspect live logs, and run named checks. Add \`--open-local-ui\` to open it automatically, or \`--no-local-ui\` to disable it.

Health check:

\`\`\`bash
curl http://127.0.0.1:8765/health
repo-harness mcp doctor --repo .
\`\`\`

The generated ignored file \`.repo-harness/mcp.local.json\` stores the default \`controller\` profile, allowed local agents, timeout, endpoint, and \`chatgpt.serverName\`. OAuth credentials stay in \`.repo-harness/mcp.oauth.json\`; the bearer fallback stays in ignored token files.

Repository-specific MCP access rules may be added in \`.repo-harness/mcp.policy.json\`. Repository policy can narrow access, but immutable secret, credential, Git-internal, and build-output denies remain enforced.

## Stable endpoint

Use this Connector URL:

\`\`\`text
${endpoint}
\`\`\`

Quick tunnels are useful for one-off smoke tests, but their URL may change. For routine use, prefer a named tunnel:

\`\`\`bash
cloudflared tunnel login
cloudflared tunnel create repo-harness-mcp
cloudflared tunnel route dns repo-harness-mcp ${CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER}
repo-harness mcp keepalive --repo . --profile controller --enable-dev-runner --dev-runner-agents codex,claude --tunnel named --cloudflare-tunnel-name repo-harness-mcp --public-endpoint https://${CHATGPT_NAMED_TUNNEL_HOST_PLACEHOLDER}/mcp
\`\`\`

Regenerate this guide with the stable endpoint:

\`\`\`bash
repo-harness mcp setup chatgpt --repo . --endpoint <https-url>/mcp
\`\`\`

The real endpoint stays in ignored local config; the tracked guide stays placeholder-only. The OAuth discovery endpoint includes \`oauth-protected-resource\` metadata.

## Create the ChatGPT Connector

1. Open ChatGPT Settings and enable Developer Mode.
2. Create a custom Connector using the server name from \`.repo-harness/mcp.local.json\` under \`chatgpt.serverName\`.
3. Paste the public HTTPS URL ending in \`/mcp\`.
4. Configure Connector authentication as OAuth. A bearer token remains available only as a local fallback for non-ChatGPT clients; start such a client with \`--auth bearer\` when required.
5. Scan tools and authorize with the passphrase from \`.repo-harness/mcp.oauth.json\`.
6. Keep write confirmations enabled.
7. Re-scan tools after updating repo-harness tool schemas.

## Verify the loaded tool surface

Call \`controller_capabilities\` from ChatGPT. It should report \`${CONTROLLER_TOOL_SURFACE}\` and list the Issue Launcher, GitHub session, Run inspection, bounded edit, and Verification Gate tools. If only legacy planning tools are visible, refresh or recreate the Connector so ChatGPT reloads the MCP tool schema.

## Daily workflow

Start a new ChatGPT conversation with:

\`\`\`text
Use repo-harness as the project controller. Read project_snapshot, current Issues, active Runs, and relevant code before deciding the next action. Keep work in small dependency-aware Tasks. Do not dispatch one large Issue as one agent run.
\`\`\`

Typical requests:

\`\`\`text
Analyze this requirement and the current implementation. Create or update an Issue and split it into executable Tasks. Do not execute yet.
\`\`\`

\`\`\`text
Inspect readiness for this Issue, publish it to GitHub when collaboration is useful, and launch at most two independent Tasks. Review every local diff or GitHub pull request and record verification evidence before accepting it.
\`\`\`

\`\`\`text
Read the project board and failed Runs. Retry only the smallest failed Task, or re-plan the Issue when the original split is wrong.
\`\`\`

\`\`\`text
This is a small local fix. Open a bounded edit session, modify only the named files, inspect the Git diff, run focused checks, and finalize or rollback the edit.
\`\`\`

## Persistent model

\`\`\`text
Issue
  -> Task T1
       -> Run 1
       -> Run 2 (retry)
  -> Task T2
  -> Task T3
\`\`\`

- Issues and Tasks are stored under \`tasks/issues/\` as JSON plus readable Markdown.
- Agent jobs, logs, edit backups, and worktrees are stored under ignored \`.ai/harness/\` runtime directories.
- A completed isolated agent Run moves its Task to review. ChatGPT must inspect it with \`get_task_diff\`, integrate it with \`integrate_task_run\`, record named-check and criterion evidence through \`verify_task\`, then explicitly accept it or request changes.
- Dependency completion unlocks later Tasks automatically.
- Any new ChatGPT conversation can recover state through \`project_snapshot\` and \`get_project_board\`.

## Capability boundaries

- \`observe\`: inspect repository state, search code, and read bounded file ranges.
- \`manage\`: create Issues, dynamically split Tasks, inspect launch readiness, publish to GitHub Issues/Projects, update status, and maintain project documents.
- \`edit\`: use a bounded edit session with allowed paths, SHA preconditions, change limits, backups, and rollback.
- \`execute\`: dispatch a ready Task to an allowed local agent in an isolated worktree or to a visible GitHub Copilot cloud session.
- Protected operations such as secrets, Git internals, package lockfiles, CI workflow changes, commits, merges, and pushes are not default controller actions.

The legacy planner/orchestrator handoff remains available for compatibility. When explicitly enabled, \`run_agent_goal\` reads only \`.ai/harness/handoff/codex-goal.md\`; new work should prefer \`dispatch_task\` and persistent Task Runs.

## Dev Mode Agent Runner

Local Agent execution is opt-in. GitHub cloud sessions use authenticated \`gh\` and do not require the local dev runner:

\`\`\`bash
repo-harness mcp serve --repo . --transport http --host 127.0.0.1 --port 8765 --profile controller --enable-dev-runner --dev-runner-agents codex,claude
\`\`\`

The runner defaults to 60 minutes per local Task and supports explicit values up to 12 hours. Requested values are validated and persisted unchanged; an invalid value fails instead of silently falling back to 120 seconds.

The runner:

- accepts only configured \`codex\` or \`claude\` agents;
- creates one persistent Run per Task;
- normally creates an isolated Git worktree;
- records prompt, process metadata, streaming stdout/stderr, structured events, and result under \`.ai/harness/jobs/\`;
- never exposes arbitrary shell input through MCP;
- does not commit, merge, or push automatically.

Watch local or GitHub execution from a terminal:

\`\`\`bash
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log
\`\`\`

The \`--log\` view streams local Codex/Claude output while the process is running and polls GitHub cloud-session logs when available.

Use \`repo-harness mcp keepalive\` when the local server and tunnel should be supervised together.

## Local Codex MCP

Configure Codex to read repo-harness state:

\`\`\`bash
repo-harness mcp setup codex --repo . --scope project
\`\`\`

The executor profile remains read-oriented. Controller-dispatched Codex work is scoped by the generated Task prompt and worktree.

## Security

- Keep OAuth passphrases, bearer tokens, tunnel tokens, \`~/.codex/auth.json\`, and other credentials out of chat and Git.
- Keep the MCP server bound to loopback; expose it only through the authenticated tunnel.
- Do not remove immutable hard-deny patterns in order to make a Task pass.
- Review every completed local diff or GitHub pull request and record passing Verification Gate evidence before accepting a Task.
- Use the smallest allowed path set and focused checks for direct edits.

## Troubleshooting

- ChatGPT cannot connect: verify the HTTPS tunnel ends in \`/mcp\` and local \`/health\` responds.
- ChatGPT auth loops: retry authorization and inspect \`.repo-harness/mcp.oauth.json\`; do not paste the passphrase into chat.
- Tool scan misses tools: open the local visual controller and compare its runtime fingerprint with \`${CONTROLLER_TOOL_SURFACE}\`; restart keepalive, then rescan or recreate the versioned Connector.
- Codex cannot see the MCP server: rerun \`repo-harness mcp setup codex --repo . --scope project\`.
- A quick tunnel URL changed: update the Connector URL or switch to a named tunnel.
- A Task is blocked: inspect \`get_task_run\`, shrink or re-plan the Task, then retry that Task rather than redispatching the full Issue.
`;
}

export function runMcpSetupChatgpt(opts: { repo?: string; host?: string; port?: string; endpoint?: string; serverName?: string }): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const changed: string[] = [];
  const existingConfig = loadMcpLocalConfig(repoRoot);
  const host = opts.host ?? existingConfig?.server?.host ?? '127.0.0.1';
  const port = opts.port ?? String(existingConfig?.server?.port ?? 8765);
  const existingServerName = existingConfig?.chatgpt?.serverName;
  const migratedServerName = existingServerName && !LEGACY_DEFAULT_SERVER_NAMES.has(existingServerName)
    ? existingServerName
    : undefined;
  const serverName = normalizeChatgptMcpServerName(opts.serverName ?? migratedServerName);
  const endpoint = normalizePublicMcpEndpoint(opts.endpoint ?? existingConfig?.chatgpt?.endpoint);
  const configPath = join(repoRoot, '.repo-harness', 'mcp.local.json');
  const guidePath = join(repoRoot, 'docs', 'repo-harness-chatgpt-mcp-setup.md');
  const token = ensureMcpBearerToken(repoRoot);
  const oauth = ensureMcpOAuthPassphrase(repoRoot);
  if (token.changed) changed.push(token.path);
  if (oauth.changed) changed.push(oauth.path);
  const config = {
    version: 1,
    repo: repoRoot,
    server: { ...existingConfig?.server, host, port: Number(port), transport: existingConfig?.server?.transport ?? 'http' },
    auth: existingConfig?.auth ?? { mode: 'oauth', oauthFile: '.repo-harness/mcp.oauth.json', tokenFile: '.repo-harness/mcp.tokens.json' },
    chatgpt: {
      ...existingConfig?.chatgpt,
      serverName,
      ...(endpoint ? { endpoint } : {}),
    },
    profile: existingConfig?.profile ?? 'controller',
    localController: existingConfig?.localController ?? {
      enabled: true,
      host: '127.0.0.1',
      port: 8766,
      autoOpen: false,
    },
    devMode: {
      ...existingConfig?.devMode,
      agentRunner: existingConfig?.devMode?.agentRunner ?? true,
      allowedAgents: existingConfig?.devMode?.allowedAgents ?? ['codex'],
      timeoutMs: !existingConfig?.devMode?.timeoutMs || existingConfig.devMode.timeoutMs === 120_000
        ? DEFAULT_AGENT_TIMEOUT_MS
        : existingConfig.devMode.timeoutMs,
      maxTimeoutMs: existingConfig?.devMode?.maxTimeoutMs ?? MAX_AGENT_TIMEOUT_MS,
    },
  };
  writeFileIfChanged(configPath, `${JSON.stringify(config, null, 2)}\n`, changed);
  writeFileIfChanged(guidePath, chatgptGuideMarkdown(), changed);
  ensureGitignoreEntries(repoRoot, [
    '.repo-harness/mcp.local.json',
    '.repo-harness/mcp.tokens.json',
    '.repo-harness/mcp.oauth.json',
    '.repo-harness/mcp.oauth-tokens.json',
    '.repo-harness/mcp.runtime.json',
    '.ai/harness/mcp/audit.log',
    '.ai/harness/local-jobs/',
  ], changed);

  return {
    status: 'ok',
    repoRoot,
    changed,
    lines: [
      `[repo-harness mcp] Repo: ${repoRoot}`,
      '[repo-harness mcp] Profile: controller',
      `[repo-harness mcp] ChatGPT MCP server name: ${serverName}`,
      `[repo-harness mcp] Local endpoint: http://${host}:${port}/mcp`,
      `[repo-harness mcp] Local Controller: http://${config.localController.host}:${config.localController.port}/`,
      `[repo-harness mcp] Local agent timeout: ${config.devMode.timeoutMs}ms (max ${config.devMode.maxTimeoutMs}ms)`,
      endpoint
        ? `[repo-harness mcp] ChatGPT endpoint: ${endpoint}`
        : '[repo-harness mcp] ChatGPT endpoint: requires stable HTTPS tunnel',
      `[repo-harness mcp] Auth: OAuth passphrase (${relative(repoRoot, oauth.path)})`,
      `[repo-harness mcp] Bearer fallback token: ${relative(repoRoot, token.path)}`,
      `[repo-harness mcp] Config: ${relative(repoRoot, configPath)}`,
      `[repo-harness mcp] Guide: ${relative(repoRoot, guidePath)} (generic; endpoint stays in ignored local config)`,
      `[repo-harness mcp] Runtime state: ${relative(repoRoot, mcpRuntimeStatePath(repoRoot))}`,
      `Next: repo-harness mcp keepalive --repo . --host ${host} --port ${port} --profile controller --enable-dev-runner --dev-runner-agents codex --tunnel quick`,
    ],
  };
}

const CODEX_MCP_BLOCK = `[mcp_servers.repo_harness]
command = "repo-harness"
args = [
  "mcp",
  "serve",
  "--repo",
  ".",
  "--transport",
  "stdio",
  "--profile",
  "executor"
]
enabled_tools = [
  "harness_status",
  "read_workflow_file",
  "latest_handoff",
  "latest_checks",
  "prepare_codex_goal_from_sprint",
  "write_codex_goal",
  "run_workflow_check"
]
default_tools_approval_mode = "prompt"
`;

export function patchCodexConfigToml(current: string): string {
  const normalized = current.trimEnd();
  const blockPattern = /\n?\[mcp_servers\.repo_harness\][\s\S]*?(?=\n\[|$)/;
  const prefix = normalized.length > 0 ? `${normalized}\n\n` : '';
  if (!blockPattern.test(normalized)) return `${prefix}${CODEX_MCP_BLOCK}`;
  return `${normalized.replace(blockPattern, `\n${CODEX_MCP_BLOCK}`.trimEnd())}\n`;
}

export function runMcpSetupCodex(opts: { repo?: string; scope?: string; dryRun?: boolean }): McpSetupResult {
  if ((opts.scope ?? 'project') !== 'project') {
    throw new Error('repo-harness mcp setup codex currently supports --scope project only');
  }
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const configPath = join(repoRoot, '.codex', 'config.toml');
  const changed: string[] = [];
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const next = patchCodexConfigToml(current);
  if (opts.dryRun === true) {
    return {
      status: 'ok',
      repoRoot,
      changed: [],
      lines: [`[repo-harness mcp] Dry run: would patch ${relative(repoRoot, configPath)}`, next],
    };
  }
  if (existsSync(configPath) && current !== next) {
    const backupPath = `${configPath}.bak`;
    writeFileIfChanged(backupPath, current, changed);
  }
  writeFileIfChanged(configPath, next, changed);
  return {
    status: 'ok',
    repoRoot,
    changed,
    lines: [
      `[repo-harness mcp] Codex config: ${relative(repoRoot, configPath)}`,
      '[repo-harness mcp] Server: repo_harness',
      '[repo-harness mcp] Transport: stdio',
    ],
  };
}

const SKILL_MD = `---
name: repo-harness-chatgpt-bridge
description: Operate repo-harness with ChatGPT as controller, durable Issues and Tasks, GitHub Issue Launcher support, bounded direct edits, and local or GitHub cloud Task Runs.
---

# repo-harness-chatgpt-bridge

Use this Skill inside a repo-harness adopted repository.

## Operating model

- ChatGPT is the controller: inspect state, analyze code, maintain documents, plan Issues and Tasks, review Runs, and decide the next action.
- Codex or Claude is a scoped local worker; GitHub Copilot coding agent is the visible cloud worker for Tasks launched through GitHub.
- Repository files are durable truth. Do not rely on chat history when Issue, Task, Run, diff, or check evidence exists.
- A Run finishing successfully moves a Task to review; it does not automatically verify, accept, or merge the work.

## First reads

1. Run \`repo-harness mcp doctor --repo .\`.
2. Read \`project_snapshot\`, \`get_project_board\`, and active Runs.
3. Search and read only the relevant repository code.
4. Read the related Issue and supporting PRD/Plan when they exist.

## Task sizing

- Small local fix: bounded edit session -> diff -> focused check -> finalize or rollback.
- Medium work: Issue -> small dependency-aware Tasks -> one Run per Task -> controller review.
- Large product work: PRD/Plan -> one or more Issues -> Task DAG -> staged integration review.
- Never dispatch an entire large Issue as one agent prompt.

## Execution rules

1. Dispatch only ready Tasks.
2. Run at most a small number of path-independent Tasks concurrently.
3. Keep every Run inside the Task's allowed paths and acceptance criteria.
4. Inspect local logs and worktree diff or the GitHub session and pull request.
5. For an isolated local Run, call \`integrate_task_run\` before verification.
6. Record named check and acceptance evidence with \`verify_task\` before \`accept_task\`.
7. Request changes or split the Task when the result is too broad or incomplete.
8. Do not commit, merge, push, publish, or modify protected configuration without explicit user authority.
9. Use the user's language for status reports unless repo-local instructions require otherwise.

## Compatibility workflow

PRD -> checklist Sprint -> Codex Goal remains available for existing repositories. New controller work should prefer durable Issue -> Task -> Run state and use the legacy goal handoff only when it is already the repository's chosen workflow.

## Safety

- Never expose arbitrary shell arguments through MCP.
- Never read or write secrets, credentials, Git internals, generated build output, or ignored authentication state.
- Use SHA preconditions and bounded change limits for direct edits.
- Keep local agent execution opt-in, timeout-bounded, audited, and restricted to configured agents. GitHub publication and cloud sessions are explicit open-world actions.
`;

const SKILL_WORKFLOW_MD = `# Controller Workflow

## Recover state

Read \`project_snapshot\`, \`get_project_board\`, and \`list_task_runs\`. Repository state, not the previous chat, determines the next action.

## Analyze and plan

Search the repository before creating work. Create one Issue for the user-visible objective, split implementation into Tasks with dependencies, allowed paths, checks, and acceptance criteria, then inspect readiness. Publish to GitHub Issues/Projects only when collaboration or cloud execution is useful.

## Execute

Use \`launch_issue\` after readiness review, \`dispatch_task\` for one ready Task, or \`dispatch_ready_tasks\` for a small path-independent batch. Local Runs normally use isolated worktrees; \`github-copilot\` Tasks create visible cloud sessions and draft pull requests.

## Review

Use \`get_task_run\`, \`get_task_run_events\`, and \`get_task_run_log\`; inspect the local diff or GitHub pull request, run focused checks, and call \`verify_task\`. Accept only after the Verification Gate passes. Otherwise request changes, retry the smallest Task, or re-plan the Issue.

## Direct edit

For a small fix, use \`begin_edit_session\`, \`apply_patch\`, \`get_git_diff\`, \`run_check\`, then \`finalize_edit_session\` or \`rollback_edit_session\`.

## Legacy planning chain

When a repository still requires the older handoff, preserve idea -> PRD -> checklist Sprint -> Codex Goal. Do not mix that large goal handoff with controller Task Runs for the same implementation slice.
`;

export function runMcpInstallSkill(opts: { repo?: string; overwrite?: boolean; dryRun?: boolean }): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const changed: string[] = [];
  const skillRoot = join(repoRoot, '.agents', 'skills', 'repo-harness-chatgpt-bridge');
  const skillPath = join(skillRoot, 'SKILL.md');
  if (existsSync(skillPath) && opts.overwrite !== true) {
    return {
      status: 'ok',
      repoRoot,
      changed,
      lines: [`[repo-harness mcp] Skill already exists: ${relative(repoRoot, skillPath)}`, '[repo-harness mcp] Use --overwrite to replace it.'],
    };
  }
  if (opts.dryRun === true) {
    return {
      status: 'ok',
      repoRoot,
      changed,
      lines: [`[repo-harness mcp] Dry run: would install ${relative(repoRoot, skillRoot)}`],
    };
  }
  writeFileIfChanged(join(skillRoot, 'SKILL.md'), SKILL_MD, changed);
  writeFileIfChanged(join(skillRoot, 'references', 'workflow.md'), SKILL_WORKFLOW_MD, changed);
  writeFileIfChanged(join(skillRoot, 'references', 'chatgpt-connector-manual.md'), chatgptGuideMarkdown(), changed);
  return {
    status: 'ok',
    repoRoot,
    changed,
    lines: [`[repo-harness mcp] Skill installed: ${relative(repoRoot, skillRoot)}`],
  };
}

export function runMcpPrintGuide(opts: { repo?: string; endpoint?: string; write?: boolean }): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const changed: string[] = [];
  const endpoint = normalizePublicMcpEndpoint(opts.endpoint);
  const content = chatgptGuideMarkdown(opts.write === true ? undefined : endpoint);
  if (opts.write === true) {
    writeFileIfChanged(join(repoRoot, 'docs', 'repo-harness-chatgpt-mcp-setup.md'), chatgptGuideMarkdown(), changed);
  }
  return {
    status: 'ok',
    repoRoot,
    changed,
    lines: [
      content.trimEnd(),
      ...(opts.write === true && endpoint ? ['', `[repo-harness mcp] ChatGPT endpoint for this session: ${endpoint}`] : []),
    ],
  };
}

export function runMcpDoctor(opts: { repo?: string; json?: boolean }): McpSetupResult {
  const repoRoot = resolveMcpRepoRoot(opts.repo ?? '.');
  const localConfig = loadMcpLocalConfig(repoRoot);
  const runtimeState = loadMcpRuntimeState(repoRoot);
  const configuredServerName = localConfig?.chatgpt?.serverName;
  const host = localConfig?.server?.host ?? '127.0.0.1';
  const port = localConfig?.server?.port ?? 8765;
  const authMode = localConfig?.auth?.mode ?? 'missing';
  const codexConfigPath = join(repoRoot, '.codex', 'config.toml');
  const codexConfig = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, 'utf-8') : '';
  const codexHasServer = codexConfig.includes('[mcp_servers.repo_harness]');
  const missingTools = REQUIRED_CODEX_TOOLS.filter((tool) => !codexConfig.includes(`"${tool}"`));
  const codexCommand = Bun.which('codex');
  const report = {
    status: existsSync(join(repoRoot, '.ai', 'harness', 'policy.json')) ? 'ready_local' : 'not_adopted',
    repo: repoRoot,
    mcp: {
      localConfig: existsSync(join(repoRoot, '.repo-harness', 'mcp.local.json')),
      guide: existsSync(join(repoRoot, 'docs', 'repo-harness-chatgpt-mcp-setup.md')),
      authConfigured: (authMode === 'oauth' && existsSync(mcpOAuthPath(repoRoot))) ||
        (authMode === 'bearer' && existsSync(mcpTokenPath(repoRoot))),
      localController: {
        enabled: localConfig?.localController?.enabled ?? true,
        host: localConfig?.localController?.host ?? '127.0.0.1',
        port: localConfig?.localController?.port ?? 8766,
        autoOpen: localConfig?.localController?.autoOpen ?? false,
      },
      devMode: {
        agentRunner: localConfig?.devMode?.agentRunner === true,
        allowedAgents: localConfig?.devMode?.allowedAgents ?? ['codex'],
        timeoutMs: localConfig?.devMode?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        maxTimeoutMs: localConfig?.devMode?.maxTimeoutMs ?? MAX_AGENT_TIMEOUT_MS,
      },
    },
    codex: {
      cliAvailable: codexCommand !== null,
      configured: codexHasServer && missingTools.length === 0,
      configPath: '.codex/config.toml',
      hasServer: codexHasServer,
      missingTools,
      fix: 'repo-harness mcp setup codex --repo . --scope project',
    },
    chatgpt: {
      ...(configuredServerName ? { serverName: configuredServerName } : {}),
      serverNameConfigured: Boolean(configuredServerName),
      defaultServerName: DEFAULT_CHATGPT_MCP_SERVER_NAME,
      expectedToolSurface: CONTROLLER_TOOL_SURFACE,
      localEndpoint: `http://${host}:${port}/mcp`,
      localController: `http://${localConfig?.localController?.host ?? '127.0.0.1'}:${localConfig?.localController?.port ?? 8766}/`,
      publicEndpoint: localConfig?.chatgpt?.endpoint,
      authMode,
      manualStepsRequired: true,
      setup: 'repo-harness mcp setup chatgpt --repo .',
    },
    runtime: runtimeState ? {
      status: runtimeState.status,
      tunnelMode: runtimeState.tunnelMode,
      localHealthy: runtimeState.server.healthy,
      localPid: runtimeState.server.pid,
      localRestartCount: runtimeState.server.restartCount,
      publicEndpoint: runtimeState.tunnel?.publicEndpoint,
      publicHealthy: runtimeState.tunnel?.healthy,
      tunnelPid: runtimeState.tunnel?.pid,
      tunnelRestartCount: runtimeState.tunnel?.restartCount,
      connectorNeedsReconnect: runtimeState.tunnel?.connectorNeedsReconnect === true,
      updatedAt: runtimeState.updatedAt,
    } : null,
  };
  return {
    status: 'ok',
    repoRoot,
    changed: [],
    lines: opts.json === true ? [JSON.stringify(report, null, 2)] : [
      `[repo-harness mcp] Repo: ${repoRoot}`,
      `[repo-harness mcp] Status: ${report.status}`,
      `[repo-harness mcp] ChatGPT MCP server name: ${
        configuredServerName ?? `missing (run setup; default is ${DEFAULT_CHATGPT_MCP_SERVER_NAME})`
      }`,
      `[repo-harness mcp] ChatGPT guide: ${report.mcp.guide ? 'present' : 'missing'}`,
      `[repo-harness mcp] Local Controller: ${report.mcp.localController.enabled ? report.chatgpt.localController : 'disabled'}`,
      `[repo-harness mcp] ChatGPT auth: ${report.mcp.authConfigured ? `${authMode} present` : 'missing'}`,
      `[repo-harness mcp] Runtime: ${
        report.runtime
          ? `${report.runtime.status} (local=${report.runtime.localHealthy ? 'ok' : 'down'}${
            report.runtime.tunnelMode !== 'none'
              ? `, public=${report.runtime.publicHealthy ? 'ok' : 'down'} via ${report.runtime.tunnelMode}`
              : ''
          })`
          : 'not running'
      }`,
      ...(
        report.runtime?.connectorNeedsReconnect === true
          ? ['[repo-harness mcp] Runtime note: public quick tunnel URL changed; update the ChatGPT connector or switch to a named tunnel']
          : []
      ),
      `[repo-harness mcp] Dev runner: ${report.mcp.devMode.agentRunner ? `enabled (${report.mcp.devMode.allowedAgents.join(',')})` : 'disabled'}`,
      `[repo-harness mcp] Codex config: ${report.codex.configured ? 'present' : 'missing'}`,
      `[repo-harness mcp] Codex CLI: ${report.codex.cliAvailable ? 'present' : 'missing'}`,
      `[repo-harness mcp] Next ChatGPT setup: ${report.chatgpt.setup}`,
    ],
  };
}
