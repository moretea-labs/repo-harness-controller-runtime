import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { buildMcpToolDefinitions, callMcpTool, type McpToolContext } from '../../src/cli/mcp/tools';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): McpToolContext {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-direct-agent-'));
  roots.push(root);
  mkdirSync(join(root, '.ai/harness'), { recursive: true });
  mkdirSync(join(root, '.repo-harness'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  return { repoRoot: root, policy: getMcpPolicy('controller', { repoRoot: root }) };
}

function value(result: Awaited<ReturnType<typeof callMcpTool>>): Record<string, any> {
  return JSON.parse(result.content[0]!.text);
}

describe('direct local agent entrypoint', () => {
  test('publishes quick_agent_session as a first-class Codex/Claude tool', () => {
    const definitions = buildMcpToolDefinitions(fixture().policy);
    const quick = definitions.find((tool) => tool.name === 'quick_agent_session');
    expect(quick).toBeTruthy();
    expect(JSON.stringify(quick?.inputSchema)).toContain('objective');
    expect(JSON.stringify(quick?.inputSchema)).not.toContain('issue_id');
  });

  test('dispatch_task returns actionable input errors instead of issue not found for empty ids', async () => {
    const result = value(await callMcpTool(fixture(), 'dispatch_task', { agent: 'codex' }));
    expect(result.error.code).toBe('ISSUE_ID_REQUIRED');
    expect(result.error.message).toContain('quick_agent_session');
    expect(result.error.message).not.toContain('issue not found');
  });
});
