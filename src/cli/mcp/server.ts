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
import { callAccessTool } from './access-tools';
import { callRepositoryTool } from './repository-tools';
import { callRuntimeTool } from '../../runtime/gateway/mcp/runtime-tools';
import { injectDurableCommandFields, routeDurableMcpCall } from '../../runtime/gateway/mcp/router';
import {
  controllerExposureSnapshot,
  isControllerToolExposed,
} from './toolset';

export type { McpServerOptions } from './multi-repository';
export { buildMultiRepositoryToolDefinitions, callMultiRepositoryTool } from './multi-repository';

type ServerToolContext = McpToolContext | MultiRepositoryMcpToolContext;

function isMultiRepositoryContext(ctx: ServerToolContext): ctx is MultiRepositoryMcpToolContext {
  return 'controllerHome' in ctx;
}

export function createMcpToolContext(
  opts: McpServerOptions & { profile?: "controller" },
): MultiRepositoryMcpToolContext;
export function createMcpToolContext(opts: McpServerOptions): ServerToolContext;
export function createMcpToolContext(opts: McpServerOptions): ServerToolContext {
  const profile = opts.profile ?? 'controller';
  if (profile !== 'controller') return createLegacyMcpToolContext(opts);
  const repo = opts.repo?.trim() === '.' ? undefined : opts.repo;
  return createMultiRepositoryToolContext({ ...opts, repo });
}

export function createRepoHarnessMcpServerFromContext(ctx: ServerToolContext): Server {
  const server = new Server(
    { name: 'repo-harness-mcp', version: '1.4.0' },
    { capabilities: { tools: {} }, instructions: mcpServerInstructions(ctx.policy.profile) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: isMultiRepositoryContext(ctx)
      ? controllerExposureSnapshot(ctx).definitions.map(injectDurableCommandFields)
      : buildMcpToolDefinitions(ctx.policy, { enableChatgptBrowser: ctx.enableChatgptBrowser === true }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (isMultiRepositoryContext(ctx)) {
      if (!isControllerToolExposed(ctx, name)) {
        const value = {
          error: {
            code: 'UNKNOWN_TOOL',
            message: `${name} is not registered by this repo-harness build. Tool availability is independent of Request vs Full Access.`,
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: true };
      }
      const accessResult = callAccessTool(ctx, name, args);
      if (accessResult) return accessResult;
      const runtimeResult = await callRuntimeTool(ctx, name, args);
      if (runtimeResult) return runtimeResult;
      const durableResult = await routeDurableMcpCall(ctx, name, args);
      if (durableResult) return durableResult;
      const repositoryResult = await callRepositoryTool(ctx.controllerHome, name, args);
      if (repositoryResult) return repositoryResult;
      return callMultiRepositoryTool(ctx, name, args);
    }
    return callMcpTool(ctx, name, args);
  });
  return server;
}

export function createRepoHarnessMcpServer(opts: McpServerOptions): Server {
  return createRepoHarnessMcpServerFromContext(createMcpToolContext(opts));
}
