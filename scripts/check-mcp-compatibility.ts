import { CONTROLLER_TOOL_SURFACE, controllerToolSurfaceFingerprint } from '../src/cli/controller/runtime-config';
import { runtimePolicy } from '../src/cli/mcp/multi-repository';
import { controllerExpectedToolNames } from '../src/cli/mcp/tools';
import { accessToolDefinitions } from '../src/cli/mcp/access-tools';
import { runtimeToolDefinitions } from '../src/runtime/gateway/mcp/runtime-tools';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
} from '../src/cli/mcp/toolset';

const EXPECTED_COMPATIBILITY_FINGERPRINT = '75fc20396887283e';
const EXPECTED_COMPATIBILITY_TOOL_COUNT = 116;
const EXPECTED_DEFAULT_TOOL_COUNT = DEFAULT_CONTROLLER_TOOL_NAMES.length;
const EXPECTED_ADVANCED_TOOL_COUNT = ADVANCED_CONTROLLER_TOOL_NAMES.length;

const policy = runtimePolicy(process.cwd(), {
  profile: 'controller',
  enableDevRunner: true,
  devRunnerAgents: 'codex,claude',
});
const runtimeNames = runtimeToolDefinitions.map((tool) => tool.name);
const accessNames = accessToolDefinitions.map((tool) => tool.name);
const compatibilityNames = controllerExpectedToolNames(policy)
  .filter((name) => !runtimeNames.includes(name));
const compatibilityFingerprint = controllerToolSurfaceFingerprint(compatibilityNames);
const duplicateCompatibility = compatibilityNames.filter((name, index) => compatibilityNames.indexOf(name) !== index);
const collisions = [...runtimeNames, ...accessNames]
  .filter((name) => compatibilityNames.includes(name));
const accessRuntimeCollisions = accessNames.filter((name) => runtimeNames.includes(name));
const defaultNames: string[] = [...DEFAULT_CONTROLLER_TOOL_NAMES];
const advancedNames: string[] = [...ADVANCED_CONTROLLER_TOOL_NAMES];
const fullNames = [...compatibilityNames, ...runtimeNames, ...accessNames];
const defaultFingerprint = controllerToolSurfaceFingerprint(defaultNames);
const advancedFingerprint = controllerToolSurfaceFingerprint(advancedNames);
const fullFingerprint = controllerToolSurfaceFingerprint(fullNames);

const failures: string[] = [];
if (compatibilityNames.length !== EXPECTED_COMPATIBILITY_TOOL_COUNT) {
  failures.push(`legacy Controller tool count changed: expected ${EXPECTED_COMPATIBILITY_TOOL_COUNT}, got ${compatibilityNames.length}`);
}
if (compatibilityFingerprint !== EXPECTED_COMPATIBILITY_FINGERPRINT) {
  failures.push(`legacy Controller fingerprint changed: expected ${EXPECTED_COMPATIBILITY_FINGERPRINT}, got ${compatibilityFingerprint}`);
}
if (duplicateCompatibility.length) failures.push(`legacy duplicate names: ${[...new Set(duplicateCompatibility)].join(', ')}`);
if (collisions.length) failures.push(`runtime/access tools collide with legacy tools: ${collisions.join(', ')}`);
if (accessRuntimeCollisions.length) failures.push(`access tools collide with runtime tools: ${accessRuntimeCollisions.join(', ')}`);
if (defaultNames.length !== EXPECTED_DEFAULT_TOOL_COUNT) {
  failures.push(`default core Controller tool count changed: expected ${EXPECTED_DEFAULT_TOOL_COUNT}, got ${defaultNames.length}`);
}
if (advancedNames.length !== EXPECTED_ADVANCED_TOOL_COUNT) {
  failures.push(`advanced Controller tool count changed: expected ${EXPECTED_ADVANCED_TOOL_COUNT}, got ${advancedNames.length}`);
}
if (defaultNames.length > 12) {
  failures.push(`default core tools/list is no longer minimal: ${defaultNames.length} tools`);
}
const missingDefault = defaultNames.filter((name) => !advancedNames.includes(name));
if (missingDefault.length) failures.push(`default tools missing from advanced surface: ${missingDefault.join(', ')}`);
const missingAdvanced = advancedNames.filter((name) => !fullNames.includes(name));
if (missingAdvanced.length) failures.push(`advanced tools missing from full surface: ${missingAdvanced.join(', ')}`);
for (const name of ['rh_status', 'rh_inbox', 'rh_context', 'rh_work']) {
  if (!defaultNames.includes(name)) failures.push(`default surface missing facade tool: ${name}`);
}

if (failures.length) {
  console.error('[mcp-compatibility] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({
  status: 'ok',
  toolSurface: CONTROLLER_TOOL_SURFACE,
  compatibilityToolCount: compatibilityNames.length,
  compatibilityFingerprint,
  addedRuntimeControlToolCount: runtimeNames.length,
  addedAccessToolCount: accessNames.length,
  defaultToolCount: defaultNames.length,
  defaultFingerprint,
  advancedToolCount: advancedNames.length,
  advancedFingerprint,
  fullToolCount: fullNames.length,
  fullFingerprint,
}, null, 2));
