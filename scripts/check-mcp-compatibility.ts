import { CONTROLLER_TOOL_SURFACE, controllerToolSurfaceFingerprint } from '../src/cli/controller/runtime-config';
import { runtimePolicy } from '../src/cli/mcp/multi-repository';
import { controllerExpectedToolNames } from '../src/cli/mcp/tools';
import { runtimeToolDefinitions } from '../src/runtime/gateway/mcp/runtime-tools';
import { CORE_CONTROLLER_TOOL_NAMES } from '../src/cli/mcp/toolset';

const EXPECTED_COMPATIBILITY_FINGERPRINT = '2f4977857957118e';
const EXPECTED_COMPATIBILITY_TOOL_COUNT = 97;

const policy = runtimePolicy(process.cwd(), {
  profile: 'controller',
  enableDevRunner: true,
  devRunnerAgents: 'codex,claude',
});
const compatibilityNames = controllerExpectedToolNames(policy);
const compatibilityFingerprint = controllerToolSurfaceFingerprint(compatibilityNames);
const runtimeNames = runtimeToolDefinitions.map((tool) => tool.name);
const duplicateCompatibility = compatibilityNames.filter((name, index) => compatibilityNames.indexOf(name) !== index);
const collisions = runtimeNames.filter((name) => compatibilityNames.includes(name));
const coreNames = [...CORE_CONTROLLER_TOOL_NAMES];
const fullNames = [...compatibilityNames, ...runtimeNames];
const coreFingerprint = controllerToolSurfaceFingerprint(coreNames);
const fullFingerprint = controllerToolSurfaceFingerprint(fullNames);

const failures: string[] = [];
if (compatibilityNames.length !== EXPECTED_COMPATIBILITY_TOOL_COUNT) {
  failures.push(`legacy Controller tool count changed: expected ${EXPECTED_COMPATIBILITY_TOOL_COUNT}, got ${compatibilityNames.length}`);
}
if (compatibilityFingerprint !== EXPECTED_COMPATIBILITY_FINGERPRINT) {
  failures.push(`legacy Controller fingerprint changed: expected ${EXPECTED_COMPATIBILITY_FINGERPRINT}, got ${compatibilityFingerprint}`);
}
if (duplicateCompatibility.length) failures.push(`legacy duplicate names: ${[...new Set(duplicateCompatibility)].join(', ')}`);
if (collisions.length) failures.push(`runtime-control tools collide with legacy tools: ${collisions.join(', ')}`);
if (coreNames.length !== 43) failures.push(`core Controller tool count changed: expected 43, got ${coreNames.length}`);
const missingCore = coreNames.filter((name) => !fullNames.includes(name));
if (missingCore.length) failures.push(`core tools missing from full surface: ${missingCore.join(', ')}`);

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
  coreToolCount: coreNames.length,
  coreFingerprint,
  fullToolCount: fullNames.length,
  fullFingerprint,
}, null, 2));
