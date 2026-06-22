import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpServerInstructions } from './instructions';
import {
  buildMultiRepositoryToolDefinitions,
  callMultiRepositoryTool,
  createMcpToolContext as createMultiRepositoryToolContext,
  type McpServerOptions,
} from './multi-repository';
import { callRepositoryTool, repositoryToolDefinitions } from './repository-tools';

export type { McpServerOptions } from './multi-repository';
export { buildMultiRepositoryToolDefinitions, callMultiRepositoryTool } from './multi-repository';

export function createMcpToolContext(opts: McpServerOptions) {
  const profile = opts.profile ?? 'controller';
  const repo = profile === 'controller' && opts.repo?.trim() === '.' ? undefined : opts.repo;
  return createMultiRepositoryToolContext({ ...opts, repo });
}

export function createRepoHarnessMcpServer(opts: McpServerOptions): Server {
  const ctx = createMcpToolContext(opts);
  const server = new Server(
    { name: 'repo-harness-mcp', version: '1.4.0' },
    { capabilities: { tools: {} }, instructions: mcpServerInstructions(ctx.policy.profile) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: repositoryToolDefinitions.concat(buildMultiRepositoryToolDefinitions(ctx)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const repositoryResult = callRepositoryTool(ctx.controllerHome, name, args);
    if (repositoryResult) return repositoryResult;
    return callMultiRepositoryTool(ctx, name, args);
  });
  return server;
}
