import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpServerInstructions } from './instructions';
import {
  buildMultiRepositoryToolDefinitions,
  callMultiRepositoryTool,
  createMcpToolContext,
  type McpServerOptions,
} from './multi-repository';

export type { McpServerOptions } from './multi-repository';
export { buildMultiRepositoryToolDefinitions, callMultiRepositoryTool, createMcpToolContext } from './multi-repository';

export function createRepoHarnessMcpServer(opts: McpServerOptions): Server {
  const ctx = createMcpToolContext(opts);
  const server = new Server(
    { name: 'repo-harness-mcp', version: '1.4.0' },
    {
      capabilities: { tools: {} },
      instructions: mcpServerInstructions(ctx.policy.profile),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildMultiRepositoryToolDefinitions(ctx),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return callMultiRepositoryTool(ctx, name, args);
  });

  return server;
}
