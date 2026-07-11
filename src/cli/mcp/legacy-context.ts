import { resolve } from 'path';
import { getMcpPolicy, parseMcpProfile } from './policy';
import type { McpToolContext } from './tools';
import type { McpServerOptions } from './multi-repository';

export function createLegacyMcpToolContext(opts: McpServerOptions): McpToolContext {
  const repoRoot = resolve(opts.repo?.trim() || '.');
  return {
    repoRoot,
    policy: getMcpPolicy(parseMcpProfile(opts.profile ?? 'planner'), { repoRoot }),
    enableChatgptBrowser: opts.enableChatgptBrowser === true,
    sessionId: opts.sessionId,
    principalId: opts.principalId,
    controllerInstanceId: opts.controllerInstanceId,
  };
}
