import { loadMcpLocalConfig, loadMcpServiceLocalConfig } from './auth';
import { getMcpPolicy, parseMcpProfile } from './policy';
import { buildMcpToolDefinitions, callMcpTool, type CallToolResult, type McpToolContext, type McpToolDefinition } from './tools';
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS, normalizeAgentTimeoutMs } from '../controller/runtime-config';
import type { McpAgentRunnerName, McpToolset } from './types';
import { ensureRepoPreferredControllerHome } from '../repositories/controller-home';
import { bindRepositoryEntities } from '../repositories/entity-migration';
import { withControllerLockAsync } from '../repositories/locks';
import { registerRepository, repositorySummary, resolveRepositorySelection } from '../repositories/registry';
import { ensureRepositoryRuntimeStorage, type RepositoryRuntimeStorageReport } from '../repositories/runtime-storage';
import type { RepositoryRecord } from '../repositories/types';

export interface McpServerOptions {
  repo?: string;
  controllerHome?: string;
  profile?: string;
  enableChatgptBrowser?: boolean;
  enableDevRunner?: boolean;
  devRunnerAgents?: string;
  devRunnerTimeoutMs?: number;
  devRunnerMaxTimeoutMs?: number;
  toolset?: McpToolset | string;
}

export interface MultiRepositoryMcpToolContext extends McpToolContext {
  controllerHome: string;
  explicitRepository?: RepositoryRecord;
  toolset: McpToolset;
  toolsetLocked: boolean;
}

type ToolResult = CallToolResult;

const EXECUTION_STORAGE_TOOLS = new Set([
  'dispatch_task',
  'launch_issue',
  'dispatch_ready_tasks',
  'retry_task_run',
  'integrate_task_run',
  'begin_edit_session',
  'apply_edit_operations',
  'create_edit_savepoint',
  'rollback_edit_session',
  'finalize_edit_session',
  'verify_edit_session',
  'submit_local_bridge_job',
  'execute_local_bridge_job',
]);

const REPOSITORY_LOCKED_TOOLS = new Set([
  ...EXECUTION_STORAGE_TOOLS,
  'create_issue',
  'update_issue',
  'plan_issue',
  'append_task',
  'split_task',
  'supersede_task',
  'set_task_dependencies',
  'update_task',
  'record_task_verification',
  'accept_verified_task',
  'publish_issue_to_github',
  'refresh_github_issue',
  'close_github_issue',
  'configure_github_plugin',
]);


export function parseMcpToolset(value: unknown, profile: string): McpToolset {
  if (profile !== 'controller') return 'full';
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return 'core';
  if (normalized === 'core' || normalized === 'advanced' || normalized === 'full') return normalized;
  throw new Error(`invalid MCP toolset "${String(value)}" (expected: core, advanced, or full)`);
}

function parseBooleanSetting(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseAgentList(value: unknown): McpAgentRunnerName[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return Array.from(new Set(raw
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry): entry is McpAgentRunnerName => entry === 'codex' || entry === 'claude')));
}

export function runtimePolicy(repoRoot: string, opts: McpServerOptions) {
  const profile = parseMcpProfile(opts.profile ?? 'controller');
  const config = profile === 'controller' && opts.controllerHome
    ? loadMcpServiceLocalConfig(opts.controllerHome, repoRoot)
    : loadMcpLocalConfig(repoRoot);
  const envDevRunner = parseBooleanSetting(process.env.REPO_HARNESS_MCP_DEV_RUNNER);
  const configuredDevRunner = envDevRunner ?? config?.devMode?.agentRunner === true;
  const devAgentRunner = opts.enableDevRunner === true || configuredDevRunner;
  const allowedAgents = parseAgentList(
    opts.devRunnerAgents ?? process.env.REPO_HARNESS_MCP_DEV_RUNNER_AGENTS ?? config?.devMode?.allowedAgents,
  );
  const runnerMaxTimeoutMs = normalizeAgentTimeoutMs(
    opts.devRunnerMaxTimeoutMs ?? process.env.REPO_HARNESS_MCP_DEV_RUNNER_MAX_TIMEOUT_MS ?? config?.devMode?.maxTimeoutMs,
    { defaultMs: MAX_AGENT_TIMEOUT_MS, maxMs: MAX_AGENT_TIMEOUT_MS, label: 'dev runner max timeout' },
  );
  const runnerTimeoutMs = normalizeAgentTimeoutMs(
    opts.devRunnerTimeoutMs ?? process.env.REPO_HARNESS_MCP_DEV_RUNNER_TIMEOUT_MS ?? config?.devMode?.timeoutMs,
    { defaultMs: DEFAULT_AGENT_TIMEOUT_MS, maxMs: runnerMaxTimeoutMs, label: 'dev runner timeout' },
  );
  return getMcpPolicy(profile, {
    devAgentRunner,
    allowedAgents,
    runnerTimeoutMs,
    runnerMaxTimeoutMs,
    repoRoot,
  });
}

function injectRepositoryContext(tool: McpToolDefinition): McpToolDefinition {
  const schema = tool.inputSchema as {
    type?: unknown;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  if (schema.type !== 'object') return tool;
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        repo_id: {
          type: 'string',
          description: 'Stable repoId. Required when more than one repository is enabled.',
        },
        checkout_id: {
          type: 'string',
          description: 'Checkout identity for repositories with multiple local clones.',
        },
        ...(schema.properties ?? {}),
      },
    },
  };
}

export function buildMultiRepositoryToolDefinitions(
  ctx: MultiRepositoryMcpToolContext,
): McpToolDefinition[] {
  return buildMcpToolDefinitions(ctx.policy, {
    enableChatgptBrowser: ctx.enableChatgptBrowser === true,
  }).map(injectRepositoryContext);
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes(':') ? message.slice(0, message.indexOf(':')) : 'TOOL_FAILED';
  const value = { error: { code, message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
}

function withRepositoryEnvelope(
  result: ToolResult,
  repository: RepositoryRecord,
  runtimeStorage: RepositoryRuntimeStorageReport,
): ToolResult {
  const summary = repositorySummary(repository);
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    const structuredContent = {
      ...(result.structuredContent as Record<string, unknown>),
      repoId: repository.repoId,
      repository: summary,
      runtimeStorage,
    };
    return {
      ...result,
      structuredContent,
      content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    };
  }
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: JSON.stringify({ repoId: repository.repoId, repository: summary, runtimeStorage }, null, 2) },
    ],
  };
}

export function repositoryScopedToolArgs(
  name: string,
  input: Record<string, unknown>,
  repository: RepositoryRecord,
): Record<string, unknown> {
  const args = { ...input };
  delete args.repo_id;
  delete args.checkout_id;

  const github = repository.github;
  const githubRepo = github ? `${github.owner}/${github.repo}` : undefined;
  if (githubRepo && ['github_status', 'publish_issue_to_github'].includes(name) && args.repo === undefined) {
    args.repo = githubRepo;
  }
  if (githubRepo && ['dispatch_task', 'launch_issue', 'dispatch_ready_tasks'].includes(name) && args.github_repo === undefined) {
    args.github_repo = githubRepo;
  }
  if (repository.defaultBranch
    && ['dispatch_task', 'launch_issue', 'dispatch_ready_tasks'].includes(name)
    && args.base_ref === undefined) {
    args.base_ref = repository.defaultBranch;
  }
  if (name === 'publish_issue_to_github' && github) {
    if (args.labels === undefined && github.labels?.length) args.labels = [...github.labels];
    if (args.project_owner === undefined && github.projectOwner) args.project_owner = github.projectOwner;
    if (args.project_number === undefined && github.projectNumber !== undefined) args.project_number = github.projectNumber;
  }
  return args;
}

export function createMcpToolContext(opts: McpServerOptions): MultiRepositoryMcpToolContext {
  const controllerHome = ensureRepoPreferredControllerHome(opts.repo, opts.controllerHome);
  const explicitRepository = opts.repo?.trim()
    ? registerRepository({ path: opts.repo, controllerHome })
    : undefined;
  const policyRoot = explicitRepository?.canonicalRoot ?? controllerHome;
  const policy = runtimePolicy(policyRoot, { ...opts, controllerHome });
  const config = policy.profile === 'controller'
    ? loadMcpServiceLocalConfig(controllerHome, explicitRepository?.canonicalRoot)
    : loadMcpLocalConfig(policyRoot);
  const toolsetOverride = opts.toolset ?? process.env.REPO_HARNESS_MCP_TOOLSET;
  const toolset = parseMcpToolset(
    toolsetOverride ?? config?.toolset,
    policy.profile,
  );
  return {
    controllerHome,
    explicitRepository,
    repoRoot: policyRoot,
    policy,
    toolset,
    toolsetLocked: toolsetOverride !== undefined,
    enableChatgptBrowser: opts.enableChatgptBrowser === true,
  };
}

export async function callMultiRepositoryTool(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  try {
    const repository = resolveRepositorySelection({
      repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
      checkoutId: typeof args.checkout_id === 'string' ? args.checkout_id : undefined,
      explicitPath: ctx.explicitRepository?.canonicalRoot,
      controllerHome: ctx.controllerHome,
      allowSoleRepository: true,
    });
    const scopedArgs = repositoryScopedToolArgs(name, args, repository);
    const runtimeStorage = ensureRepositoryRuntimeStorage(repository, ctx.controllerHome);
    if (EXECUTION_STORAGE_TOOLS.has(name) && !runtimeStorage.readyForExecution) {
      throw new Error(`RUNTIME_STORAGE_NOT_READY: ${runtimeStorage.warnings.join('; ')}`);
    }

    bindRepositoryEntities(repository);
    const scopedContext: McpToolContext = {
      repoRoot: repository.canonicalRoot,
      policy: runtimePolicy(repository.canonicalRoot, {
        profile: ctx.policy.profile,
        enableChatgptBrowser: ctx.enableChatgptBrowser,
        enableDevRunner: ctx.policy.execution.agentRunner,
        devRunnerAgents: ctx.policy.execution.allowedAgents.join(','),
        devRunnerTimeoutMs: ctx.policy.execution.runnerTimeoutMs,
        devRunnerMaxTimeoutMs: ctx.policy.execution.runnerMaxTimeoutMs,
      }),
      enableChatgptBrowser: ctx.enableChatgptBrowser,
    };
    const invoke = async () => await callMcpTool(scopedContext, name, scopedArgs) as ToolResult;
    const result = REPOSITORY_LOCKED_TOOLS.has(name)
      ? await withControllerLockAsync(
        ctx.controllerHome,
        { scope: 'repository', repoId: repository.repoId },
        `mcp:${name}`,
        invoke,
        60_000,
      )
      : await invoke();
    bindRepositoryEntities(repository);
    return withRepositoryEnvelope(result, repository, runtimeStorage);
  } catch (error) {
    return errorResult(error);
  }
}
