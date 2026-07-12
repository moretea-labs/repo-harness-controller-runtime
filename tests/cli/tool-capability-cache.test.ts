import { describe, expect, test } from 'bun:test';
import type { McpToolDefinition } from '../../src/cli/mcp/tools';
import { SessionToolDefinitionCache, controllerCapabilityGroupForTool, groupControllerToolDefinitions } from '../../src/cli/mcp/tool-capability-cache';

const tool = (name: string): McpToolDefinition => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });

describe('controller tool capability grouping', () => {
  test('classifies stable facade and capability families', () => {
    expect(controllerCapabilityGroupForTool('rh_context')).toBe('core');
    expect(controllerCapabilityGroupForTool('repository_get')).toBe('repository');
    expect(controllerCapabilityGroupForTool('repository_git_diff')).toBe('git');
    expect(controllerCapabilityGroupForTool('session_start')).toBe('workflow');
    expect(controllerCapabilityGroupForTool('runtime_maintenance_status')).toBe('runtime');
  });

  test('groups definitions without rebuilding or changing order', () => {
    const definitions = [tool('repository_get'), tool('rh_context'), tool('repository_list')];
    const groups = groupControllerToolDefinitions(definitions);
    expect(groups.find((group) => group.group === 'repository')?.toolNames).toEqual(['repository_get', 'repository_list']);
    expect(groups.find((group) => group.group === 'core')?.definitions[0]).toBe(definitions[1]);
  });
});

describe('SessionToolDefinitionCache', () => {
  test('reuses one resolved toolset within a session', () => {
    const cache = new SessionToolDefinitionCache();
    let builds = 0;
    const first = cache.getOrCreate('session-a', 'core', () => { builds += 1; return [tool('rh_context')]; });
    const second = cache.getOrCreate('session-a', 'core', () => { builds += 1; return [tool('rh_access')]; });
    expect(second).toBe(first);
    expect(builds).toBe(1);
  });

  test('bounds sessions and entries with LRU eviction', () => {
    const cache = new SessionToolDefinitionCache({ maxSessions: 2, maxEntriesPerSession: 1 });
    cache.getOrCreate('a', 'one', () => [tool('rh_context')]);
    cache.getOrCreate('a', 'two', () => [tool('rh_access')]);
    cache.getOrCreate('b', 'one', () => [tool('work_get')]);
    cache.getOrCreate('c', 'one', () => [tool('work_list')]);
    expect(cache.sessionCount).toBe(2);
    let rebuilt = 0;
    cache.getOrCreate('a', 'one', () => { rebuilt += 1; return [tool('rh_context')]; });
    expect(rebuilt).toBe(1);
  });
});
