import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpServerInstructions } from './instructions';
import { buildMcpToolDefinitions, callMcpTool, type McpToolContext } from './tools';
import { createLegacyMcpToolContext } from './legacy-context';
import {
  buildMultiRepositoryToolDefinitions,
  callMultiRepositoryTool,
  createMcpToolContext as createMultiRepositoryToolContext,
  type McpServerOptions,
  type MultiRepositoryMcpToolContext,
} from './multi-repository';
import { callRepositoryTool, repositoryToolDefinitions } from './repository-tools';

export type { McpServerOptions } from './multi-repository';
export { buildMultiRepositoryToolDefinitions, callMultiRepositoryTool } from './multi-repository';

type ServerToolContext = McpToolContext | MultiRepositoryMcpToolContext;

function isMultiRepositoryContext(ctx: ServerToolContext): ctx is MultiRepositoryMcpToolContext {
  return 'controllerHome' in ctx;
}

export function createMcpToolContext(opts: McpServerOptions): ServerToolContext {
  const profile = opts.profile ?? 'controller';
  if (profile !== 'controller') return createLegacyMcpToolContext(opts);
  const repo = opts.repo?.trim() === '.' ? undefined : opts.repo;
  return createMultiRepositoryToolContext({ ...opts, repo });
}

export function createRepoHarnessMcpServer(opts: McpServerOptions): Server {
  const ctx = createMcpToolContext(opts);
  const server = new Server(
    { name: 'repo-harness-mcp', version: '1.4.0' },
    { capabilities: { tools: {} }, instructions: mcpServerInstructions(ctx.policy.profile) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: isMultiRepositoryContext(ctx)
      ? repositoryToolDefinitions.concat(buildMultiRepositoryToolDefinitions(ctx))
      : buildMcpToolDefinitions(ctx.policy, { enableChatgptBrowser: ctx.enableChatgptBrowser === true }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (isMultiRepositoryContext(ctx)) {
      const repositoryResult = callRepositoryTool(ctx.controllerHome, name, args);
      if (repositoryResult) return repositoryResult;
      return callMultiRepositoryTool(ctx, name, args);
    }
    return callMcpTool(ctx, name, args);
  });
  return server;
}
