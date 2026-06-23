import { loadMcpLocalConfig } from './auth';
import { getMcpPolicy, parseMcpProfile } from './policy';
import { buildMcpToolDefinitions, callMcpTool, type McpToolContext, type McpToolDefinition } from './tools';
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS, normalizeAgentTimeoutMs } from '../controller/runtime-config';
import type { McpAgentRunnerName } from './types';
import { ensureControllerHome } from '../repositories/controller-home';
import { bindRepositoryEntities } from '../repositories/entity-migration';
import { registerRepository, repositorySummary, resolveRepositorySelection } from '../repositories/registry';
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
}

export interface MultiRepositoryMcpToolContext extends McpToolContext {
  controllerHome: string;
  explicitRepository?: RepositoryRecord;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
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

function runtimePolicy(repoRoot: string, opts: McpServerOptions) {
  const profile = parseMcpProfile(opts.profile ?? 'controller');
  const config = loadMcpLocalConfig(repoRoot);
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

function withRepositoryEnvelope(result: ToolResult, repository: RepositoryRecord): ToolResult {
  const summary = repositorySummary(repository);
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    const structuredContent = {
      ...(result.structuredContent as Record<string, unknown>),
      repoId: repository.repoId,
      repository: summary,
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
      { type: 'text', text: JSON.stringify({ repoId: repository.repoId, repository: summary }, null, 2) },
    ],
  };
}

export function createMcpToolContext(opts: McpServerOptions): MultiRepositoryMcpToolContext {
  const controllerHome = ensureControllerHome(opts.controllerHome);
  const explicitRepository = opts.repo?.trim()
    ? registerRepository({ path: opts.repo, controllerHome })
    : undefined;
  const policyRoot = explicitRepository?.canonicalRoot ?? controllerHome;
  return {
    controllerHome,
    explicitRepository,
    repoRoot: policyRoot,
    policy: runtimePolicy(policyRoot, opts),
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
    const scopedArgs = { ...args };
    delete scopedArgs.repo_id;
    delete scopedArgs.checkout_id;
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
    const result = await callMcpTool(scopedContext, name, scopedArgs) as ToolResult;
    bindRepositoryEntities(repository);
    return withRepositoryEnvelope(result, repository);
  } catch (error) {
    return errorResult(error);
  }
}
