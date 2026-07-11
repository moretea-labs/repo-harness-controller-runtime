import { describe, expect, test } from 'bun:test';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  STABLE_CONTROLLER_TOOL_NAMES,
  classifyControllerToolExposure,
  controllerExposureSnapshot,
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
    controllerHome: process.cwd(),
    policy: getMcpPolicy('controller'),
    toolset,
    enableChatgptBrowser: false,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

describe('MCP tool exposure profiles', () => {
  test('stable connector surface stays unique and below the schema budget', () => {
    expect(new Set(STABLE_CONTROLLER_TOOL_NAMES).size).toBe(STABLE_CONTROLLER_TOOL_NAMES.length);
    expect(STABLE_CONTROLLER_TOOL_NAMES.length).toBeLessThanOrEqual(128);
    expect(STABLE_CONTROLLER_TOOL_NAMES.length).toBeGreaterThanOrEqual(100);
  });

  test('preferred facade remains compact while every profile exposes the stable full schema', () => {
    expect([...PREFERRED_FACADE_TOOL_NAMES]).toEqual([
      'rh_access',
      'rh_status',
      'rh_inbox',
      'rh_context',
      'rh_work',
    ]);
    for (const name of PREFERRED_FACADE_TOOL_NAMES) {
      expect(DEFAULT_CONTROLLER_TOOL_NAMES).toContain(name);
      expect(classifyControllerToolExposure(name)).toBe('facade');
    }

    const profiles = (['core', 'advanced', 'full'] as const).map((toolset) =>
      exposedControllerToolDefinitions(stubCtx(toolset)).map((tool) => tool.name),
    );
    expect(profiles[0]).toEqual(profiles[1]);
    expect(profiles[2].length).toBeGreaterThan(profiles[1].length);
    for (const names of profiles) {
      for (const required of [
        'rh_access',
        'repository_access_get',
        'repository_safe_patch_apply',
        'repository_command_execute',
        'repository_git_status',
        'create_campaign',
        'dispatch_task',
        'ios_simulator_screenshot',
      ]) expect(names).toContain(required);
    }
  });

  test('exposure snapshot is the single truthful source for expected and actual tools', () => {
    const snapshot = controllerExposureSnapshot(stubCtx('core'));
    expect(snapshot.ready).toBe(true);
    expect(snapshot.schemaStableAcrossAccessModes).toBe(true);
    expect(snapshot.expectedToolNames).toEqual(snapshot.actualToolNames);
    expect(snapshot.missingToolNames).toEqual([]);
    expect(snapshot.unexpectedToolNames).toEqual([]);
    expect(snapshot.duplicateToolNames).toEqual([]);
    expect(snapshot.actualToolNames.slice(0, PREFERRED_FACADE_TOOL_NAMES.length))
      .toEqual([...PREFERRED_FACADE_TOOL_NAMES]);
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('legacy profile labels never hide tools', () => {
    expect(ADVANCED_CONTROLLER_TOOL_NAMES).toEqual(DEFAULT_CONTROLLER_TOOL_NAMES);
    expect(controllerToolNamesForToolset('core')).toEqual(ADVANCED_CONTROLLER_TOOL_NAMES);
    expect(controllerToolNamesForToolset('advanced')).toEqual(ADVANCED_CONTROLLER_TOOL_NAMES);
    expect(controllerToolNamesForToolset('full')).toBeNull();
    for (const toolset of ['core', 'advanced', 'full'] as const) {
      expect(isControllerToolExposed(stubCtx(toolset), 'repository_safe_patch_apply')).toBe(true);
      expect(isControllerToolExposed(stubCtx(toolset), 'dispatch_task')).toBe(true);
      expect(isControllerToolExposed(stubCtx(toolset), 'quick_agent_session')).toBe(true);
    }
    expect(classifyControllerToolExposure('create_campaign')).toBe('advanced');
  });

  test('parseMcpToolset accepts legacy labels and defaults controller to advanced', () => {
    expect(parseMcpToolset(undefined, 'controller')).toBe('advanced');
    expect(parseMcpToolset('core', 'controller')).toBe('core');
    expect(parseMcpToolset('advanced', 'controller')).toBe('advanced');
    expect(parseMcpToolset('full', 'controller')).toBe('full');
    expect(parseMcpToolset('CORE', 'controller')).toBe('core');
    expect(() => parseMcpToolset('legacy', 'controller')).toThrow(/invalid MCP toolset/);
    expect(parseMcpToolset('core', 'planner')).toBe('full');
    expect(normalizeMcpToolset('advanced')).toBe('advanced');
    expect(normalizeMcpToolset('nope')).toBe('advanced');
  });
});
