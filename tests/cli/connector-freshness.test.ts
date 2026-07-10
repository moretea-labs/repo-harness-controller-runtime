import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EXPECTED_FACADE_TOOLS,
  OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS,
  buildLocalConnectorStatus,
  evaluateConnectorFreshness,
} from '../../src/cli/local-bridge/connector-freshness';
import {
  buildCommandCenter,
  buildSystemReadiness,
  evaluateConsoleConnectorFreshness,
  mapRepositoryCard,
} from '../../src/cli/local-bridge/facade-api';
import { controllerExpectedToolNames } from '../../src/cli/mcp/legacy-tool-service';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import {
  CORE_CONTROLLER_TOOL_NAMES,
  PREFERRED_FACADE_TOOL_NAMES,
  exposedControllerToolDefinitions,
} from '../../src/cli/mcp/toolset';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createSchedule } from '../../src/runtime/workflow/schedules/store';
import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
} from '../../src/cli/controller/runtime-config';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-freshness-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-freshness-home-'));
  roots.push(repoRoot, controllerHome);
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'freshness-fixture',
    scripts: { 'check:type': 'node -e "process.exit(0)"' },
  }, null, 2));
  spawnSync('git', ['add', 'package.json'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'Freshness Fixture' });
  return {
    ctx: { controllerHome, repository },
    repository,
    repoRoot,
    controllerHome,
  };
}

describe('connector freshness diagnostics', () => {
  test('expected facade tools and preferredTools stay aligned with core exposure', () => {
    expect(EXPECTED_FACADE_TOOLS).toEqual(['rh_status', 'rh_inbox', 'rh_context', 'rh_work']);
    expect([...PREFERRED_FACADE_TOOL_NAMES]).toEqual([...EXPECTED_FACADE_TOOLS]);
    for (const name of EXPECTED_FACADE_TOOLS) {
      expect(CORE_CONTROLLER_TOOL_NAMES).toContain(name);
    }
    for (const name of OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS) {
      expect(CORE_CONTROLLER_TOOL_NAMES).toContain(name);
    }
    const policy = getMcpPolicy('controller');
    const expected = controllerExpectedToolNames(policy);
    for (const name of EXPECTED_FACADE_TOOLS) {
      expect(expected).toContain(name);
    }
    expect(expected.slice(0, 4)).toEqual([...EXPECTED_FACADE_TOOLS]);
  });

  test('exposed core definitions include rh_* and interactive development tools', () => {
    const { repository, controllerHome, repoRoot } = fixture();
    const policy = getMcpPolicy('controller', { repoRoot });
    const ctx = {
      repoRoot,
      controllerHome,
      policy,
      toolset: 'core' as const,
      enableChatgptBrowser: false,
      explicitRepository: repository,
      audit: () => undefined,
    } as unknown as MultiRepositoryMcpToolContext;
    const exposed = exposedControllerToolDefinitions(ctx).map((tool) => tool.name);
    for (const name of EXPECTED_FACADE_TOOLS) {
      expect(exposed).toContain(name);
    }
    for (const name of OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS) {
      expect(exposed).toContain(name);
    }
  });

  test('unable_to_verify when connector_tool_names missing and local has rh_*', () => {
    const local = [...EXPECTED_FACADE_TOOLS, 'controller_capabilities', 'work_wait'];
    const report = evaluateConnectorFreshness({
      localToolNames: local,
      // no connectorToolNames
    });
    expect(report.status).toBe('unable_to_verify_chatgpt_snapshot');
    expect(report.severity).toBe('info');
    expect(report.missingLocalTools).toEqual([]);
    expect(report.missingConnectorTools).toEqual([]);
    expect(report.bannerWarning).toBeUndefined();
    expect(report.summary).toContain('无法从 GUI 确认');
    expect(report.connectorLabel).toContain('未确认');
    expect(report.sectionDetail).toContain('无法直接确认 ChatGPT');
  });

  test('no false missing-connector warning when only connector snapshot unavailable', () => {
    const expected = controllerExpectedToolNames(getMcpPolicy('controller'));
    const report = buildLocalConnectorStatus({ expectedTools: expected });
    expect(report.status).toBe('unable_to_verify_chatgpt_snapshot');
    expect(report.severity).not.toBe('error');
    expect(report.bannerWarning).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('可能缺少新 facade 工具');
    expect(report.reconnectRecommended).toBe(false);
  });

  test('chatgpt_snapshot_missing_facade when connector_tool_names omit rh_*', () => {
    const report = evaluateConnectorFreshness({
      localToolNames: [...EXPECTED_FACADE_TOOLS, 'work_wait'],
      connectorToolNames: ['controller_capabilities', 'work_get'],
    });
    expect(report.status).toBe('chatgpt_snapshot_missing_facade');
    expect(report.severity).toBe('warning');
    expect(report.missingConnectorTools).toEqual([...EXPECTED_FACADE_TOOLS]);
    expect(report.reconnectRecommended).toBe(true);
    expect(report.restartRecommended).toBe(false);
    expect(report.bannerWarning).toContain('连接器快照缺少');
  });

  test('local_mcp_updated when connector_tool_names contains rh_*', () => {
    const report = evaluateConnectorFreshness({
      localToolNames: [...EXPECTED_FACADE_TOOLS, 'work_wait', 'repository_safe_patch_apply'],
      connectorToolNames: [...EXPECTED_FACADE_TOOLS, 'controller_ready'],
    });
    expect(report.status).toBe('local_mcp_updated');
    expect(report.severity).toBe('ok');
    expect(report.missingConnectorTools).toEqual([]);
    expect(report.summary).toContain('可用');
    expect(report.connectorTone).toBe('green');
  });

  test('local_mcp_missing_facade when local registry omits rh_*', () => {
    const report = evaluateConnectorFreshness({
      localToolNames: ['controller_capabilities', 'work_get'],
    });
    expect(report.status).toBe('local_mcp_missing_facade');
    expect(report.severity).toBe('error');
    expect(report.missingLocalTools).toEqual([...EXPECTED_FACADE_TOOLS]);
    expect(report.restartRecommended).toBe(true);
    expect(report.bannerWarning).toContain('本地 MCP');
  });

  test('stale_fingerprint when runtime process does not match expected surface', () => {
    const local = [...EXPECTED_FACADE_TOOLS];
    const fingerprint = controllerToolSurfaceFingerprint(local);
    const report = evaluateConnectorFreshness({
      localToolNames: local,
      toolSurface: CONTROLLER_TOOL_SURFACE,
      schemaVersion: CONTROLLER_SCHEMA_VERSION,
      toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
      toolSurfaceFingerprint: fingerprint,
      runtime: {
        healthy: true,
        toolSurface: CONTROLLER_TOOL_SURFACE,
        schemaVersion: CONTROLLER_SCHEMA_VERSION,
        toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
        toolSurfaceFingerprint: 'deadbeefdeadbeef',
      },
    });
    expect(report.status).toBe('stale_fingerprint');
    expect(report.severity).toBe('warning');
    expect(report.restartRecommended).toBe(true);
    expect(report.summary).not.toContain('可能缺少新 facade');
  });

  test('console readiness uses info/unconfirmed instead of vague reconnect warning', async () => {
    const { ctx, repository } = fixture();
    const readiness = await buildSystemReadiness(ctx);
    const center = await buildCommandCenter(ctx, [mapRepositoryCard(repository, true)]);
    expect(readiness.connectorFreshness).toBeTruthy();
    expect(['unable_to_verify_chatgpt_snapshot', 'stale_fingerprint', 'local_mcp_updated', 'local_mcp_missing_facade'])
      .toContain(readiness.connectorFreshness!.status);
    // Without a ChatGPT snapshot, never claim "missing facade tools, reconnect MCP" as the banner.
    expect(center.warnings.join(' ')).not.toContain('可能缺少新 facade 工具');
    if (readiness.connectorFreshness!.status === 'unable_to_verify_chatgpt_snapshot') {
      expect(readiness.connectorLabel).toContain('未确认');
      expect(readiness.connectorTone).toBe('blue');
      expect(center.warnings).toEqual([]);
      expect(readiness.connectorFreshness!.howToFix.length).toBeGreaterThan(0);
    }
  });

  test('console connector check with supplied names detects missing snapshot accurately', async () => {
    const { ctx } = fixture();
    const missing = await evaluateConsoleConnectorFreshness(ctx, {
      connectorToolNames: ['controller_capabilities'],
    });
    expect(missing.status).toBe('chatgpt_snapshot_missing_facade');
    expect(missing.missingConnectorTools).toEqual([...EXPECTED_FACADE_TOOLS]);

    const ok = await evaluateConsoleConnectorFreshness(ctx, {
      connectorToolNames: [...EXPECTED_FACADE_TOOLS],
    });
    expect(ok.status).toBe('local_mcp_updated');
    expect(ok.severity).toBe('ok');
  });

  test('console readiness distinguishes shadow schedules from live autonomous execution', async () => {
    const { ctx, repository } = fixture();
    createSchedule(ctx.controllerHome, {
      requestId: 'shadow-readiness-test',
      repoId: repository.repoId,
      name: 'Shadow readiness probe',
      enabled: true,
      trigger: { type: 'interval', everyMinutes: 60 },
      policy: {
        maxActiveOccurrences: 1,
        maxFailures: 3,
        cooldownMinutes: 5,
        dailyBudgetMinutes: 30,
        shadowMode: true,
      },
      action: { operation: 'controller_ready' },
      stopConditions: [],
    });

    const readiness = await buildSystemReadiness(ctx);
    const automation = readiness.sections.find((section) => section.id === 'automation');
    expect(automation).toBeTruthy();
    expect(automation?.statusLabel).toContain('影子计划');
    expect(automation?.detail).toContain('shadow mode');
    expect(automation?.detail).toContain('不会排队或启动 Execution Job');
  });

  test('dead runtime file is ignored and does not report stale_fingerprint', () => {
    // healthy=false snapshots lag behind controller:restart; must not alarm as fingerprint mismatch.
    const report = evaluateConnectorFreshness({
      localToolNames: [...EXPECTED_FACADE_TOOLS],
      toolSurface: CONTROLLER_TOOL_SURFACE,
      schemaVersion: CONTROLLER_SCHEMA_VERSION,
      toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
      toolSurfaceFingerprint: controllerToolSurfaceFingerprint([...EXPECTED_FACADE_TOOLS]),
      runtime: {
        healthy: false,
        toolSurface: CONTROLLER_TOOL_SURFACE,
        schemaVersion: CONTROLLER_SCHEMA_VERSION,
        toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
        toolSurfaceFingerprint: 'deadbeefdeadbeef',
        source: 'runtime_file',
      },
    });
    expect(report.status).toBe('unable_to_verify_chatgpt_snapshot');
    expect(report.fingerprintMatches).toBeNull();
    expect(report.severity).toBe('info');
  });
});
