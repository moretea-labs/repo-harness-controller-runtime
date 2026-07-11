import { describe, expect, test } from 'bun:test';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  classifyControllerToolExposure,
  controllerToolNamesForToolset,
  exposedControllerToolDefinitions,
  isControllerToolExposed,
  normalizeMcpToolset,
} from '../../src/cli/mcp/toolset';
import { parseMcpToolset } from '../../src/cli/mcp/multi-repository';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';

function stubCtx(toolset: 'core' | 'advanced' | 'full'): MultiRepositoryMcpToolContext {
  return {
    repoRoot: process.cwd(),
    policy: getMcpPolicy('controller'),
    toolset,
    enableChatgptBrowser: false,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

describe('MCP tool exposure profiles', () => {
  test('default core tools/list is facade + access controls + repository bootstrap/selection only', () => {
    expect([...DEFAULT_CONTROLLER_TOOL_NAMES]).toEqual([
      'rh_status',
      'rh_inbox',
      'rh_context',
      'rh_work',
      'repository_access_get',
      'repository_access_set',
      'repository_list',
      'repository_get',
      'repository_register',
      'repository_latest_source_diagnose',
      'repository_bootstrap_local_project',
    ]);
    expect(DEFAULT_CONTROLLER_TOOL_NAMES).toHaveLength(11);
    for (const name of PREFERRED_FACADE_TOOL_NAMES) {
      expect(DEFAULT_CONTROLLER_TOOL_NAMES).toContain(name);
      expect(classifyControllerToolExposure(name)).toBe('facade');
    }
    const exposed = exposedControllerToolDefinitions(stubCtx('core')).map((tool) => tool.name).sort();
    expect(exposed).toEqual([...DEFAULT_CONTROLLER_TOOL_NAMES].sort());
    expect(exposed).not.toContain('create_campaign');
    expect(exposed).not.toContain('work_submit');
    expect(exposed).not.toContain('dispatch_task');
    expect(isControllerToolExposed(stubCtx('core'), 'rh_work')).toBe(true);
    expect(isControllerToolExposed(stubCtx('core'), 'create_campaign')).toBe(false);
  });

  test('advanced surface includes former supervised tools; full is compatibility', () => {
    expect(ADVANCED_CONTROLLER_TOOL_NAMES.length).toBeGreaterThan(DEFAULT_CONTROLLER_TOOL_NAMES.length);
    expect(ADVANCED_CONTROLLER_TOOL_NAMES).toContain('create_campaign');
    expect(ADVANCED_CONTROLLER_TOOL_NAMES).toContain('work_submit');
    expect(controllerToolNamesForToolset('advanced')).toEqual(ADVANCED_CONTROLLER_TOOL_NAMES);
    expect(controllerToolNamesForToolset('full')).toBeNull();

    const advanced = exposedControllerToolDefinitions(stubCtx('advanced')).map((tool) => tool.name);
    const full = exposedControllerToolDefinitions(stubCtx('full')).map((tool) => tool.name);
    for (const name of DEFAULT_CONTROLLER_TOOL_NAMES) {
      expect(advanced).toContain(name);
      expect(full).toContain(name);
    }
    expect(advanced).toContain('create_campaign');
    expect(advanced).not.toContain('dispatch_task');
    expect(full).toContain('dispatch_task');
    expect(full.length).toBeGreaterThan(advanced.length);
    expect(isControllerToolExposed(stubCtx('advanced'), 'create_campaign')).toBe(true);
    expect(isControllerToolExposed(stubCtx('advanced'), 'dispatch_task')).toBe(false);
    expect(isControllerToolExposed(stubCtx('full'), 'dispatch_task')).toBe(true);
    expect(classifyControllerToolExposure('create_campaign')).toBe('advanced');
    expect(classifyControllerToolExposure('dispatch_task')).toBe('compatibility');
  });

  test('parseMcpToolset accepts core/advanced/full and defaults to core', () => {
    expect(parseMcpToolset(undefined, 'controller')).toBe('core');
    expect(parseMcpToolset('core', 'controller')).toBe('core');
    expect(parseMcpToolset('advanced', 'controller')).toBe('advanced');
    expect(parseMcpToolset('full', 'controller')).toBe('full');
    expect(parseMcpToolset('CORE', 'controller')).toBe('core');
    expect(() => parseMcpToolset('legacy', 'controller')).toThrow(/invalid MCP toolset/);
    expect(parseMcpToolset('core', 'planner')).toBe('full');
    expect(normalizeMcpToolset('advanced')).toBe('advanced');
    expect(normalizeMcpToolset('nope')).toBe('core');
  });
});
