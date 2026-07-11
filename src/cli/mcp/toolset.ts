import { createHash } from 'crypto';
import type { McpToolDefinition } from './tools';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { buildMultiRepositoryToolDefinitions } from './multi-repository';
import { accessToolDefinitions } from './access-tools';
import {
  resolveControllerAccessState,
  type ControllerAccessState,
} from './access-mode';
import { repositoryToolDefinitions } from './repository-tools';
import { runtimeToolDefinitions } from '../../runtime/gateway/mcp/runtime-tools';
import { DEFAULT_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES, STABLE_CONTROLLER_TOOL_NAMES } from './toolset-names';
export { BOOTSTRAP_CONTROLLER_TOOL_NAMES, DEFAULT_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES, STABLE_CONTROLLER_TOOL_NAMES } from './toolset-names';
import type { McpToolset } from './types';

export type ToolExposureClass = 'facade' | 'advanced' | 'internal' | 'compatibility';

/**
 * One authoritative snapshot of the MCP schema actually served to a client.
 * Access mode intentionally does not alter this schema: Request vs Full Access
 * is an execution-policy decision, not a tool-discovery decision.
 */
export interface ControllerExposureSnapshot {
  access: ControllerAccessState;
  toolset: McpToolset;
  definitions: McpToolDefinition[];
  toolNames: string[];
  expectedToolNames: string[];
  actualToolNames: string[];
  missingToolNames: string[];
  unexpectedToolNames: string[];
  duplicateToolNames: string[];
  fingerprint: string;
  schemaStableAcrossAccessModes: true;
  ready: boolean;
}

/**
 * Historical profile name retained for CLI/config compatibility. The stable
 * controller now serves the complete registered schema for core, advanced,
 * and full so a stale access setting can never hide repair/edit tools.
 */

/** Historical names retained for compatibility. Both map to the stable surface. */
export const ADVANCED_CONTROLLER_TOOL_NAMES = STABLE_CONTROLLER_TOOL_NAMES;
export const CORE_CONTROLLER_TOOL_NAMES = STABLE_CONTROLLER_TOOL_NAMES;

const DEFAULT_CONTROLLER_TOOL_SET = new Set<string>(STABLE_CONTROLLER_TOOL_NAMES);

export function normalizeMcpToolset(value: unknown): McpToolset {
  if (value === 'full' || value === 'advanced' || value === 'core') return value;
  return 'advanced';
}

/**
 * null means expose every registered definition. All controller profile labels
 * now resolve to that stable schema; labels remain only for compatibility and
 * diagnostics, not authorization.
 */
export function controllerToolNamesForToolset(
  toolset: McpToolset,
  _ctx?: MultiRepositoryMcpToolContext,
): readonly string[] | null {
  return toolset === 'full' ? null : STABLE_CONTROLLER_TOOL_NAMES;
}

export function resolveControllerAccessStateForContext(
  ctx: MultiRepositoryMcpToolContext,
): ControllerAccessState {
  return resolveControllerAccessState({
    controllerHome: ctx.controllerHome,
    repoRoot: ctx.explicitRepository?.canonicalRoot,
    toolsetOverride: ctx.toolset,
    toolsetLocked: ctx.toolsetLocked ?? false,
  });
}

function uniqueDefinitions(definitions: McpToolDefinition[]): {
  definitions: McpToolDefinition[];
  duplicates: string[];
} {
  const byName = new Map<string, McpToolDefinition>();
  const duplicates = new Set<string>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      duplicates.add(definition.name);
      continue;
    }
    byName.set(definition.name, definition);
  }
  const preferredOrder = new Map<string, number>(
    (PREFERRED_FACADE_TOOL_NAMES as readonly string[]).map((name, index) => [name, index]),
  );
  const orderedDefinitions = [...byName.values()].sort((left, right) => {
    const leftOrder = preferredOrder.get(left.name);
    const rightOrder = preferredOrder.get(right.name);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      return leftOrder - rightOrder;
    }
    return 0;
  });
  return { definitions: orderedDefinitions, duplicates: [...duplicates].sort() };
}

export function allControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  return uniqueDefinitions(
    runtimeToolDefinitions.concat(accessToolDefinitions, repositoryToolDefinitions, buildMultiRepositoryToolDefinitions(ctx)),
  ).definitions;
}

export function controllerExposureSnapshot(ctx: MultiRepositoryMcpToolContext): ControllerExposureSnapshot {
  const rawDefinitions = runtimeToolDefinitions.concat(
    accessToolDefinitions,
    repositoryToolDefinitions,
    buildMultiRepositoryToolDefinitions(ctx),
  );
  const unique = uniqueDefinitions(rawDefinitions);
  const allowed = controllerToolNamesForToolset(ctx.toolset, ctx);
  const expectedToolNames = allowed === null
    ? unique.definitions.map((tool) => tool.name)
    : [...new Set(allowed)];
  const definitionByName = new Map(unique.definitions.map((definition) => [definition.name, definition]));
  const definitions = expectedToolNames
    .map((name) => definitionByName.get(name))
    .filter((definition): definition is McpToolDefinition => Boolean(definition));
  const actualToolNames = definitions.map((tool) => tool.name);
  const actualSet = new Set(actualToolNames);
  const expectedSet = new Set(expectedToolNames);
  const missingToolNames = expectedToolNames.filter((name) => !actualSet.has(name));
  const unexpectedToolNames = actualToolNames.filter((name) => !expectedSet.has(name));
  const fingerprint = createHash('sha256').update(actualToolNames.join('\n')).digest('hex');
  return {
    access: resolveControllerAccessStateForContext(ctx),
    toolset: ctx.toolset,
    definitions,
    toolNames: actualToolNames,
    expectedToolNames,
    actualToolNames,
    missingToolNames,
    unexpectedToolNames,
    duplicateToolNames: unique.duplicates,
    fingerprint,
    schemaStableAcrossAccessModes: true,
    ready: missingToolNames.length === 0 && unexpectedToolNames.length === 0 && unique.duplicates.length === 0,
  };
}

export function controllerExposedToolNames(ctx: MultiRepositoryMcpToolContext): string[] {
  return controllerExposureSnapshot(ctx).actualToolNames;
}

export function classifyControllerToolExposure(toolName: string): ToolExposureClass {
  if ((PREFERRED_FACADE_TOOL_NAMES as readonly string[]).includes(toolName)) return 'facade';
  if (toolName.startsWith('rh_')) return 'facade';
  if (DEFAULT_CONTROLLER_TOOL_SET.has(toolName)) return 'advanced';
  return 'compatibility';
}

export function controllerToolExposureMetadata(toolNames: readonly string[]): {
  preferredTools: string[];
  advancedTools: string[];
  compatibilityTools: string[];
  classification: Record<string, ToolExposureClass>;
} {
  const classification: Record<string, ToolExposureClass> = {};
  for (const name of toolNames) classification[name] = classifyControllerToolExposure(name);
  return {
    preferredTools: toolNames.filter((name) => classification[name] === 'facade'),
    advancedTools: toolNames.filter((name) => classification[name] === 'advanced'),
    compatibilityTools: toolNames.filter((name) => classification[name] === 'compatibility'),
    classification,
  };
}

export function exposedControllerToolDefinitions(ctx: MultiRepositoryMcpToolContext): McpToolDefinition[] {
  return controllerExposureSnapshot(ctx).definitions;
}

export function isControllerToolExposed(ctx: MultiRepositoryMcpToolContext, name: string): boolean {
  return controllerExposureSnapshot(ctx).actualToolNames.includes(name);
}
