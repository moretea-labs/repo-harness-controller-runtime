#!/usr/bin/env bun
/**
 * Focused smoke: local MCP tool surface + connector freshness semantics.
 * Does not require a live ChatGPT connector session.
 */
import { getMcpPolicy } from '../src/cli/mcp/policy';
import { controllerExpectedToolNames } from '../src/cli/mcp/legacy-tool-service';
import {
  ADVANCED_CONTROLLER_TOOL_NAMES,
  DEFAULT_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  exposedControllerToolDefinitions,
} from '../src/cli/mcp/toolset';
import {
  EXPECTED_FACADE_TOOLS,
  OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS,
  evaluateConnectorFreshness,
} from '../src/cli/local-bridge/connector-freshness';
import type { MultiRepositoryMcpToolContext } from '../src/cli/mcp/multi-repository';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE_FAIL: ${message}`);
}

const policy = getMcpPolicy('controller');
const expected = controllerExpectedToolNames(policy);

assert(
  JSON.stringify([...PREFERRED_FACADE_TOOL_NAMES]) === JSON.stringify([...EXPECTED_FACADE_TOOLS]),
  'preferred facade tools must match EXPECTED_FACADE_TOOLS',
);

for (const name of EXPECTED_FACADE_TOOLS) {
  assert(
    (DEFAULT_CONTROLLER_TOOL_NAMES as readonly string[]).includes(name),
    `default exposure missing ${name}`,
  );
  assert(expected.includes(name), `expectedTools missing ${name}`);
}

for (const name of OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS) {
  assert(
    (ADVANCED_CONTROLLER_TOOL_NAMES as readonly string[]).includes(name),
    `interactive tool ${name} missing from ADVANCED_CONTROLLER_TOOL_NAMES`,
  );
  assert(
    (DEFAULT_CONTROLLER_TOOL_NAMES as readonly string[]).includes(name),
    `interactive tool ${name} missing from the stable default tools/list`,
  );
}

const coreCtx = {
  policy,
  toolset: 'core' as const,
  enableChatgptBrowser: false,
  audit: () => undefined,
} as unknown as MultiRepositoryMcpToolContext;
const advancedCtx = { ...coreCtx, toolset: 'advanced' as const };

const coreExposed = exposedControllerToolDefinitions(coreCtx).map((tool) => tool.name);
const advancedExposed = exposedControllerToolDefinitions(advancedCtx).map((tool) => tool.name);
for (const name of EXPECTED_FACADE_TOOLS) {
  assert(coreExposed.includes(name), `exposed core tools missing ${name}`);
}
assert(coreExposed.includes('repository_list'), 'default surface missing repository_list');
assert(coreExposed.includes('repository_bootstrap_local_project'), 'default surface missing bootstrap tool');
assert(coreExposed.length <= 132, `stable tools/list exceeds schema budget: ${coreExposed.length}`);
assert(JSON.stringify(coreExposed) === JSON.stringify(advancedExposed), 'core and advanced labels must expose the same stable schema');
for (const name of OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS) {
  assert(coreExposed.includes(name), `stable default surface missing interactive ${name}`);
  assert(advancedExposed.includes(name), `advanced alias missing interactive ${name}`);
}

const unable = evaluateConnectorFreshness({ localToolNames: expected });
assert(unable.status === 'unable_to_verify_chatgpt_snapshot', `expected unable_to_verify, got ${unable.status}`);
assert(!unable.bannerWarning, 'must not banner-warn when ChatGPT snapshot is unobserved');

const missingSnap = evaluateConnectorFreshness({
  localToolNames: expected,
  connectorToolNames: ['controller_capabilities'],
});
assert(missingSnap.status === 'chatgpt_snapshot_missing_facade', `expected snapshot missing, got ${missingSnap.status}`);
assert(missingSnap.missingConnectorTools.length === EXPECTED_FACADE_TOOLS.length, 'should list all missing rh_*');

const ok = evaluateConnectorFreshness({
  localToolNames: expected,
  connectorToolNames: [...EXPECTED_FACADE_TOOLS],
});
assert(ok.status === 'local_mcp_updated', `expected local_mcp_updated, got ${ok.status}`);
assert(ok.severity === 'ok', 'severity should be ok when snapshot complete');

const localMissing = evaluateConnectorFreshness({
  localToolNames: ['controller_capabilities'],
});
assert(localMissing.status === 'local_mcp_missing_facade', `expected local missing, got ${localMissing.status}`);

console.log(JSON.stringify({
  ok: true,
  expectedFacadeTools: EXPECTED_FACADE_TOOLS,
  preferredTools: PREFERRED_FACADE_TOOL_NAMES,
  defaultToolCount: coreExposed.length,
  advancedToolCount: advancedExposed.length,
  expectedToolsHasFacade: EXPECTED_FACADE_TOOLS.every((name) => expected.includes(name)),
  advancedHasInteractive: OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS.every((name) =>
    (ADVANCED_CONTROLLER_TOOL_NAMES as readonly string[]).includes(name)),
  states: {
    unable: unable.status,
    missingSnap: missingSnap.status,
    ok: ok.status,
    localMissing: localMissing.status,
  },
}, null, 2));
