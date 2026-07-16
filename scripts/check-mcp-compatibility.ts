import { CONTROLLER_TOOL_SURFACE, controllerToolSurfaceFingerprint } from '../src/cli/controller/runtime-config';
import { runtimePolicy } from '../src/cli/mcp/multi-repository';
import { buildMcpToolDefinitions } from '../src/cli/mcp/tools';
import { accessToolDefinitions } from '../src/cli/mcp/access-tools';
import { repositoryToolDefinitions } from '../src/cli/mcp/repository-tools';
import { runtimeToolDefinitions } from '../src/runtime/gateway/mcp/runtime-tools';
import { executionToolDefinitions } from '../src/runtime/gateway/mcp/execution-tools';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  STABLE_CONTROLLER_TOOL_NAMES,
} from '../src/cli/mcp/toolset';

// Versioned v8 stable surface. Update deliberately when the exported contract changes.
const EXPECTED_STABLE_TOOL_COUNT = 129;
const MAX_STABLE_TOOL_COUNT = 129;

const policy = runtimePolicy(process.cwd(), {
  profile: 'controller',
  enableDevRunner: true,
  devRunnerAgents: 'codex,claude',
});

const sourceGroups = {
  runtime: runtimeToolDefinitions.map((tool) => tool.name),
  execution: executionToolDefinitions.map((tool) => tool.name),
  access: accessToolDefinitions.map((tool) => tool.name),
  repository: repositoryToolDefinitions.map((tool) => tool.name),
  legacyCompatibility: buildMcpToolDefinitions(policy).map((tool) => tool.name),
};
const fullNames = [...new Set(Object.values(sourceGroups).flat())];
const stableNames: string[] = [...STABLE_CONTROLLER_TOOL_NAMES];
const defaultNames: string[] = [...DEFAULT_CONTROLLER_TOOL_NAMES];
const advancedNames: string[] = [...ADVANCED_CONTROLLER_TOOL_NAMES];
const preferredNames: string[] = [...PREFERRED_FACADE_TOOL_NAMES];
const stableFingerprint = controllerToolSurfaceFingerprint(stableNames);
const fullFingerprint = controllerToolSurfaceFingerprint(fullNames);
const duplicateStable = stableNames.filter((name, index) => stableNames.indexOf(name) !== index);
const missingStable = stableNames.filter((name) => !fullNames.includes(name));
const sourceCollisions = Object.entries(sourceGroups).flatMap(([group, names], groupIndex, entries) =>
  names.filter((name) => entries.slice(0, groupIndex).some(([, earlier]) => earlier.includes(name)))
    .map((name) => `${group}:${name}`));

const failures: string[] = [];
if (stableNames.length !== EXPECTED_STABLE_TOOL_COUNT) {
  failures.push(`stable Controller tool count changed: expected ${EXPECTED_STABLE_TOOL_COUNT}, got ${stableNames.length}`);
}
if (stableNames.length > MAX_STABLE_TOOL_COUNT) {
  failures.push(`stable Controller tools/list exceeds the schema budget: ${stableNames.length} > ${MAX_STABLE_TOOL_COUNT}`);
}
if (duplicateStable.length) failures.push(`stable duplicate names: ${[...new Set(duplicateStable)].join(', ')}`);
if (missingStable.length) failures.push(`stable tools missing from registered definitions: ${missingStable.join(', ')}`);
if (defaultNames.join('\n') !== stableNames.join('\n')) {
  failures.push('default/core surface must alias the stable Controller surface');
}
if (advancedNames.join('\n') !== stableNames.join('\n')) {
  failures.push('advanced surface must alias the stable Controller surface');
}
for (const name of ['rh_access', 'rh_status', 'rh_inbox', 'rh_context', 'rh_work']) {
  if (!preferredNames.includes(name)) failures.push(`preferred facade surface missing: ${name}`);
  if (!stableNames.includes(name)) failures.push(`stable surface missing facade tool: ${name}`);
}
if (fullNames.length < stableNames.length) {
  failures.push(`full compatibility surface is smaller than stable surface: ${fullNames.length} < ${stableNames.length}`);
}

if (failures.length) {
  console.error('[mcp-compatibility] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  status: 'ok',
  toolSurface: CONTROLLER_TOOL_SURFACE,
  stableToolCount: stableNames.length,
  stableFingerprint,
  fullCompatibilityToolCount: fullNames.length,
  fullCompatibilityFingerprint: fullFingerprint,
  sourceToolCounts: Object.fromEntries(Object.entries(sourceGroups).map(([name, tools]) => [name, tools.length])),
  sourceCollisions: [...new Set(sourceCollisions)].sort(),
  accessModeChangesSchema: false,
}, null, 2));
