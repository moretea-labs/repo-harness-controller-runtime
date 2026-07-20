import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { buildIosPluginManifest, executeIosPluginAction } from '../../src/runtime/plugins/ios-adapter';
import {
  iosAgentDeviceActions,
  resetIosAgentDeviceRuntimeHooksForTest,
  setIosAgentDeviceRuntimeHooksForTest,
} from '../../src/runtime/plugins/ios-agent-device';
import { readInteractionSession } from '../../src/runtime/plugins/interaction-session';
import { resetIosDevelopmentHooksForTest, setIosDevelopmentHooksForTest } from '../../src/runtime/safe-tooling';

const roots: string[] = [];

afterEach(() => {
  resetIosAgentDeviceRuntimeHooksForTest();
  resetIosDevelopmentHooksForTest();
  delete process.env.REPO_HARNESS_AGENT_DEVICE_EXECUTABLE;
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-ios-agent-device-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ios-agent-device-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(repoRoot, 'App.xcodeproj'), { recursive: true });
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

function readyIosTooling(): void {
  setIosDevelopmentHooksForTest({
    platform: () => 'darwin',
    runCommand: (command, args) => {
      const joined = [command, ...args].join(' ');
      if (joined === 'xcode-select -p') return { ok: true, status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '', command: [command, ...args] };
      if (joined === 'xcodebuild -version') return { ok: true, status: 0, stdout: 'Xcode 18\n', stderr: '', command: [command, ...args] };
      if (joined === 'xcrun simctl help') return { ok: true, status: 0, stdout: 'help\n', stderr: '', command: [command, ...args] };
      return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
    },
  });
}

function pluginInput(
  fixtureValue: ReturnType<typeof fixture>,
  actionId: string,
  args: Record<string, unknown>,
  requestId = `request-${actionId}`,
) {
  return {
    controllerHome: fixtureValue.controllerHome,
    repoId: fixtureValue.repository.repoId,
    repoRoot: fixtureValue.repoRoot,
    pluginId: 'ios',
    actionId,
    requestId,
    args,
    origin: { surface: 'local-ui' as const, actor: 'test' },
  };
}

function success(data: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: true, data });
}

function device(id: string, name: string, kind: 'simulator' | 'device', booted: boolean) {
  return { platform: 'ios', appleOs: 'ios', id, name, kind, target: 'mobile', booted };
}

describe('optional agent-device iOS Simulator provider', () => {
  it('keeps existing iOS readiness unchanged when the optional CLI is absent', () => {
    const value = fixture();
    readyIosTooling();
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => ({ ok: false, status: 127, stdout: '', stderr: 'not found', command: [command, ...args] }),
    });

    const manifest = buildIosPluginManifest(0, undefined, value.repoRoot);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.lifecycle.state).toBe('enabled');
    expect((manifest.health.details?.agentDevice as Record<string, unknown>).available).toBe(false);
    expect(manifest.capabilities.map((capability) => capability.capabilityId)).toContain('ios-agent-device-simulator');
    expect(manifest.capabilities.map((capability) => capability.capabilityId)).toContain('ios-agent-device-physical');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_open');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_batch');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_prepare');
    expect(manifest.actions.map((action) => action.actionId)).toContain('agent_device_jd_search');
    expect(manifest.health.warnings).not.toContain('agent-device is not installed.');
  });

  it('requires exactly agent-device 0.19.3 before any provider action', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, status: 0, stdout: '0.20.0\n', stderr: '', command: [command, ...args] };
      },
    });

    const status = await executeIosPluginAction(pluginInput(value, 'agent_device_status', {}));
    expect(status.available).toBe(false);
    expect(status.expectedVersion).toBe('0.19.3');
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App' })))
      .rejects.toThrow('PLUGIN_DEPENDENCY_MISSING');
    expect(commands).toEqual([['agent-device', '--version']]);
  });

  it('accepts one exact connected physical iPhone and rejects unavailable or ambiguous targets', async () => {
    const value = fixture();
    readyIosTooling();
    let inventory = [device('PHONE-1', 'Greyson', 'device', true)];
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: inventory }), stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const physical = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'PHONE-1' }));
    expect((physical.interaction as Record<string, unknown>).provider).toBe('ios-device');
    expect(physical.physicalDeviceSupported).toBe(true);

    inventory = [device('SIM-OFF', 'iPhone 17 Pro', 'simulator', false)];
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-OFF' })))
      .rejects.toThrow('connected physical iPhone or already-booted iOS Simulator');

    inventory = [
      device('SIM-1', 'iPhone 17', 'simulator', true),
      device('SIM-2', 'iPhone 17', 'simulator', true),
    ];
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'iPhone 17' })))
      .rejects.toThrow('ambiguous');
    expect(commands.filter((command) => command[1] === 'open')).toHaveLength(1);
  });

  it('prepares a signed physical Runner and completes a bounded JD product search', async () => {
    const value = fixture();
    readyIosTooling();
    const developerDir = join(value.repoRoot, 'Xcode.app', 'Contents', 'Developer');
    mkdirSync(developerDir, { recursive: true });
    const commands: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    let snapshotCount = 0;
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-20T09:00:00.000Z'),
      runCommand: (command, args, options) => {
        commands.push({ argv: [command, ...args], env: options?.env });
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('PHONE-1', 'greyson', 'device', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'snapshot') {
          snapshotCount += 1;
          return {
            ok: true, status: 0,
            stdout: success({ tree: '@e1 SearchField label="搜索商品" value=""' }),
            stderr: '', command: [command, ...args],
          };
        }
        if (args[0] === 'batch') {
          const steps = JSON.parse(args[args.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
          return {
            ok: true, status: 0,
            stdout: success({
              total: steps.length,
              executed: steps.length,
              results: steps.map((step, index) => ({
                step: index + 1,
                command: step.command,
                ok: true,
                data: step.command === 'snapshot'
                  ? { tree: '@e7 StaticText label="爱他美卓傲 1段 800g"\n@e8 StaticText label="奶粉搜索结果"' }
                  : step.command === 'wait'
                    ? { matched: true, text: step.input.text ?? step.input.selector }
                    : { input: step.input },
              })),
              cost: { wallClockMs: 1200, runnerRoundTrips: 4 },
            }),
            stderr: '', command: [command, ...args],
          };
        }
        if (args[0] === 'screenshot') writeFileSync(args[1]!, 'png');
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const runnerConfig = {
      device: 'greyson',
      team_id: 'TEAM123456',
      runner_bundle_id: 'com.example.agentdevice.runner',
      developer_dir: developerDir,
    };
    const prepared = await executeIosPluginAction(pluginInput(value, 'agent_device_prepare', runnerConfig));
    expect(prepared.physicalDeviceSupported).toBe(true);
    const result = await executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      ...runnerConfig,
      query: '爱他美卓傲 1段 800g',
      search_target: '@e999',
      search_selector: 'type="SearchField"',
      submit_target: '@e998',
      submit_selector: 'label="搜索"',
      result_text: '奶粉搜索结果',
    }));

    expect(result.workflow).toBe('jd_product_search');
    expect(result.app).toBe('com.360buy.jdmobile');
    expect(JSON.stringify(result)).not.toContain('爱他美卓傲 1段 800g');
    expect(JSON.stringify(result.visibleResultText)).toContain('奶粉搜索结果');
    const artifact = (result.artifactCandidates as Array<Record<string, unknown>>)[0]!;
    expect(artifact.mediaType).toBe('image/png');
    expect(existsSync(String(artifact.path))).toBe(true);
    expect((result.interaction as Record<string, unknown>).status).toBe('closed');
    expect(readInteractionSession(value.repoRoot, 'ios-device', String((result.interaction as Record<string, unknown>).interactionId))?.status).toBe('closed');

    const prepare = commands.find(({ argv }) => argv[1] === 'prepare')!;
    expect(prepare.argv).toEqual(expect.arrayContaining(['ios-runner', '--device', 'greyson']));
    expect(prepare.env?.AGENT_DEVICE_IOS_TEAM_ID).toBe('TEAM123456');
    expect(prepare.env?.AGENT_DEVICE_IOS_BUNDLE_ID).toBe('com.example.agentdevice.runner');
    expect(prepare.env?.DEVELOPER_DIR).toBe(developerDir);
    const open = commands.find(({ argv }) => argv[1] === 'open' && argv.includes('com.360buy.jdmobile'))!;
    expect(open.argv).not.toContain('--relaunch');
    const batches = commands.filter(({ argv }) => argv[1] === 'batch');
    expect(snapshotCount).toBe(0);
    expect(batches).toHaveLength(1);
    const steps = JSON.parse(batches[0]!.argv[batches[0]!.argv.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
    expect(steps.map((step) => step.command)).toEqual(['fill', 'press', 'wait']);
    expect(steps[0]?.input.settle).toBe(true);
    expect(steps[0]?.input.target).toEqual({ kind: 'selector', selector: 'type="SearchField"' });
    expect(steps[1]?.input.target).toEqual({ kind: 'selector', selector: 'label="搜索"' });
    expect(steps[2]?.input).toEqual({ kind: 'text', text: '奶粉搜索结果', timeoutMs: 15_000 });
    expect(commands.some(({ argv }) => argv[1] === 'keyboard' && argv[2] === 'return')).toBe(false);
    expect((result.executionPlan as Record<string, unknown>).nativeBatchRequests).toBe(1);
    expect((result.executionPlan as Record<string, unknown>).nativeBatchSteps).toBe(3);
    expect((result.executionPlan as Record<string, unknown>).exactResultWait).toBe(true);
    expect((result.executionPlan as Record<string, unknown>).accessibilityEvidenceTier).toBe('exact_wait');
    expect((result.executionPlan as Record<string, unknown>).initialAccessibilitySnapshot).toBe(false);
    expect((result.executionPlan as Record<string, unknown>).accessibilitySnapshotRequests).toBe(0);
    expect((result.executionPlan as Record<string, unknown>).fullAccessibilitySnapshot).toBe(false);
    expect(commands.some(({ argv }) => argv[1] === 'close')).toBe(true);
  });

  it('blocks sensitive JD workflow semantics before touching device inventory', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, status: 0, stdout: args[0] === '--version' ? '0.19.3\n' : success(), stderr: '', command: [command, ...args] };
      },
    });
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_jd_search', {
      device: 'greyson', query: '提交订单并付款',
    }))).rejects.toThrow('IOS_DEVICE_SENSITIVE_ACTION_BLOCKED');
    expect(commands.some((command) => command[1] === 'devices')).toBe(false);
  });

  it('runs only typed serial commands in one isolated session and registers bounded artifacts', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-19T11:00:00.000Z'),
      runCommand: (command, args, options) => {
        commands.push({ argv: [command, ...args], env: options?.env });
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'screenshot') writeFileSync(args[1]!, 'png');
        if (args[0] === 'fill') return { ok: true, status: 0, stdout: success({ command: 'fill', text: args[2] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'events') return { ok: true, status: 0, stdout: success({ events: [{ type: 'fill', payload: { text: 'timeline-secret', value: 'timeline-secret' } }] }), stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success({ command: args[0] }), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'com.example.App', device: 'SIM-1', relaunch: true,
    }));
    const interaction = opened.interaction as Record<string, unknown>;
    const interactionId = String(interaction.interactionId);
    const sessionId = String(interaction.sessionId);
    expect(interaction.status).toBe('waiting_for_user');

    await executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', { interaction_id: interactionId, interactive: true }));
    await executeIosPluginAction(pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: 'label="Continue"' }));
    const filled = await executeIosPluginAction(pluginInput(value, 'agent_device_fill', { interaction_id: interactionId, target: 'id="email"', text: 'qa@example.com', delay_ms: 20 }));
    expect(JSON.stringify(filled)).not.toContain('qa@example.com');
    await executeIosPluginAction(pluginInput(value, 'agent_device_scroll', { interaction_id: interactionId, direction: 'down', amount: 2 }));
    const screenshot = await executeIosPluginAction(pluginInput(value, 'agent_device_screenshot', { interaction_id: interactionId, label: 'home', max_size: 1200 }));
    const events = await executeIosPluginAction(pluginInput(value, 'agent_device_events', { interaction_id: interactionId, limit: 20 }));
    expect(JSON.stringify(events)).not.toContain('timeline-secret');
    const closed = await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
    const closedAgain = await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));

    expect((closed.interaction as Record<string, unknown>).status).toBe('closed');
    expect(closedAgain.alreadyClosed).toBe(true);
    expect((screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]?.mediaType).toBe('image/png');
    const screenshotPath = String((screenshot.artifactCandidates as Array<Record<string, unknown>>)[0]?.path);
    expect(existsSync(screenshotPath)).toBe(true);
    const recorded = readInteractionSession(value.repoRoot, 'ios-simulator', interactionId);
    expect(recorded?.status).toBe('closed');
    expect(recorded?.targetId).toBe('SIM-1');

    const openCommand = commands.find(({ argv }) => argv[1] === 'open')!;
    expect(openCommand.argv).toEqual(expect.arrayContaining(['--device', 'iPhone 17 Pro', '--session', sessionId, '--platform', 'ios', '--json', '--relaunch']));
    const sessionCommands = commands.filter(({ argv }) => ['open', 'snapshot', 'press', 'fill', 'scroll', 'screenshot', 'events', 'close'].includes(argv[1]!));
    const stateDirs = new Set(sessionCommands.map(({ env }) => env?.AGENT_DEVICE_STATE_DIR));
    expect(stateDirs.size).toBe(1);
    expect([...stateDirs][0]).toContain(interactionId);
    expect(sessionCommands.every(({ env }) => env?.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS === '300000')).toBe(true);
    expect(sessionCommands.every(({ env }) => env?.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS === '300000')).toBe(true);
    expect(sessionCommands.every(({ env }) => env?.AGENT_DEVICE_IOS_RUNNER_RETENTION_MS === undefined)).toBe(true);
    for (const command of commands) expect(command.argv).not.toContain('mcp');
  });

  it('runs multiple allowlisted actions through one native batch and redacts fill text', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') {
          return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        }
        if (args[0] === 'batch') {
          const steps = JSON.parse(args[args.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
          return {
            ok: true, status: 0,
            stdout: success({
              total: steps.length,
              executed: steps.length,
              results: steps.map((step, index) => ({ step: index + 1, command: step.command, ok: true, data: step.input })),
              cost: { wallClockMs: 800, runnerRoundTrips: steps.length },
            }),
            stderr: '', command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    const result = await executeIosPluginAction(pluginInput(value, 'agent_device_batch', {
      interaction_id: interactionId,
      steps: [
        { kind: 'press', input: { target: 'label="Continue"' } },
        { kind: 'fill', input: { target: 'id="email"', text: 'private@example.com', delay_ms: 10 } },
        { kind: 'wait', input: { wait_type: 'stable', quiet_ms: 300, timeout_ms: 3_000 } },
        { kind: 'snapshot', input: { interactive: true } },
      ],
    }));

    expect(result.batched).toBe(true);
    expect(result.stepCount).toBe(4);
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    const batches = commands.filter((argv) => argv[1] === 'batch');
    expect(batches).toHaveLength(1);
    const nativeSteps = JSON.parse(batches[0]![batches[0]!.indexOf('--steps') + 1]!) as Array<{ command: string; input: Record<string, unknown> }>;
    expect(nativeSteps.map((step) => step.command)).toEqual(['press', 'fill', 'wait', 'snapshot']);
    expect(nativeSteps[0]?.input.settle).toBe(true);
    expect(nativeSteps[0]?.input.target).toEqual({ kind: 'selector', selector: 'label="Continue"' });
    expect(nativeSteps[1]?.input.settle).toBe(true);
    expect(nativeSteps[1]?.input.target).toEqual({ kind: 'selector', selector: 'id="email"' });
    expect(nativeSteps[1]?.input.delayMs).toBe(10);

    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_batch', {
      interaction_id: interactionId,
      steps: [{ kind: 'press', input: { target: '@e1', command: 'close' } }],
    }))).rejects.toThrow('unsupported fields');
    expect(commands.filter((argv) => argv[1] === 'batch')).toHaveLength(1);
  });

  it('closes failed sessions and redacts fill text from all error evidence', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'fill') {
          return {
            ok: false, status: 1,
            stdout: JSON.stringify({ success: false, error: { message: `rejected ${args[2]}` } }),
            stderr: `failed ${args[2]}`,
            command: [command, ...args],
          };
        }
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    let captured: unknown;
    try {
      await executeIosPluginAction(pluginInput(value, 'agent_device_fill', {
        interaction_id: interactionId, target: 'id="password"', text: 'top-secret-value',
      }));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(JSON.stringify(captured)).not.toContain('top-secret-value');
    expect(String((captured as Error).message)).toContain('agent-device fill failed');
    expect(commands.some((command) => command[1] === 'close')).toBe(true);
    const fillCommand = commands.find((command) => command[1] === 'fill')!;
    expect(fillCommand).toContain('top-secret-value');
    const record = readInteractionSession(value.repoRoot, 'ios-simulator', interactionId);
    expect(record?.status).toBe('failed');
    expect(JSON.stringify(record)).not.toContain('top-secret-value');
  });

  it('keeps ownership fenced when failure cleanup cannot close the provider session', async () => {
    const value = fixture();
    readyIosTooling();
    let closeSucceeds = false;
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        if (args[0] === 'press') return { ok: false, status: 1, stdout: '', stderr: 'runner disconnected', command: [command, ...args] };
        if (args[0] === 'close' && !closeSucceeds) return { ok: false, status: 1, stdout: '', stderr: 'daemon unavailable', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_press', { interaction_id: interactionId, target: '@e1' })))
      .rejects.toThrow('AGENT_DEVICE_CLEANUP_FAILED');
    expect(readInteractionSession(value.repoRoot, 'ios-simulator', interactionId)?.status).toBe('closing');
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' })))
      .rejects.toThrow('PLUGIN_RESOURCE_BUSY');

    closeSucceeds = true;
    const retried = await executeIosPluginAction(pluginInput(value, 'agent_device_close', { interaction_id: interactionId }));
    expect((retried.interaction as Record<string, unknown>).status).toBe('closed');
  });

  it('closes and terminalizes an expired session before allowing further use', async () => {
    const value = fixture();
    readyIosTooling();
    let now = new Date('2026-07-19T11:00:00.000Z');
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      now: () => now,
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        if (args[0] === 'devices') return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success(), stderr: '', command: [command, ...args] };
      },
    });

    const opened = await executeIosPluginAction(pluginInput(value, 'agent_device_open', { app: 'App', device: 'SIM-1' }));
    const interactionId = String((opened.interaction as Record<string, unknown>).interactionId);
    now = new Date('2026-07-19T14:00:00.000Z');
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_snapshot', { interaction_id: interactionId })))
      .rejects.toThrow('AGENT_DEVICE_SESSION_EXPIRED');
    expect(commands.some((command) => command[1] === 'close')).toBe(true);
    expect(readInteractionSession(value.repoRoot, 'ios-simulator', interactionId)?.status).toBe('failed');
  });

  it('rejects URL/deep-link app inputs before starting a provider session', async () => {
    const value = fixture();
    readyIosTooling();
    const commands: string[][] = [];
    setIosAgentDeviceRuntimeHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === '--version') return { ok: true, status: 0, stdout: '0.19.3\n', stderr: '', command: [command, ...args] };
        return { ok: true, status: 0, stdout: success({ devices: [device('SIM-1', 'iPhone 17 Pro', 'simulator', true)] }), stderr: '', command: [command, ...args] };
      },
    });
    await expect(executeIosPluginAction(pluginInput(value, 'agent_device_open', {
      app: 'myapp://login?token=secret', device: 'SIM-1',
    }))).rejects.toThrow('not a URL or tokenized deep link');
    expect(commands.some((command) => command[1] === 'devices')).toBe(false);
  });

  it('serializes all session actions and never exposes arbitrary or nested MCP execution', () => {
    const actions = Object.fromEntries(iosAgentDeviceActions().map((action) => [action.actionId, action]));
    for (const actionId of ['agent_device_open', 'agent_device_batch', 'agent_device_press', 'agent_device_fill', 'agent_device_scroll', 'agent_device_screenshot', 'agent_device_close']) {
      expect(actions[actionId]?.confirmation).toBe(actionId === 'agent_device_screenshot' ? 'none' : 'authorization');
      expect(actions[actionId]?.resourceClaims).toEqual(expect.arrayContaining([
        { resource: 'repo-state', mode: 'write' },
      ]));
    }
    for (const action of Object.values(actions)) {
      expect(action.actionId).not.toContain('mcp');
      expect(JSON.stringify(action.argumentsSchema)).not.toContain('command');
      expect(JSON.stringify(action.argumentsSchema)).not.toContain('args');
    }
  });
});
