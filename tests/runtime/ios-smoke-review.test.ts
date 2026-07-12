import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  iosAppBuild,
  iosAppLaunch,
  iosSimulatorBoot,
  iosSmokeReview,
  resetIosDevelopmentHooksForTest,
  setIosDevelopmentHooksForTest,
} from '../../src/runtime/safe-tooling';
import {
  buildIosPluginManifest,
  executeIosPluginAction,
} from '../../src/runtime/plugins/ios-adapter';

const roots: string[] = [];

afterEach(() => {
  resetIosDevelopmentHooksForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-ios-smoke-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ios-smoke-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(repoRoot, 'App.xcodeproj'), { recursive: true });
  mkdirSync(join(repoRoot, 'App'), { recursive: true });
  writeFileSync(join(repoRoot, 'App/Info.plist'), '<plist/>\n');
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

function mockRunner(handlers: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>) {
  return (command: string, args: string[]) => {
    const joined = [command, ...args].join(' ');
    for (const [pattern, response] of Object.entries(handlers)) {
      if (joined.includes(pattern) || joined === pattern) {
        return {
          ok: response.ok !== false,
          status: response.ok === false ? 1 : 0,
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
          command: [command, ...args],
        };
      }
    }
    return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
  };
}

describe('iOS staged smoke review', () => {
  it('aggregates success, waits for simulator readiness, and cleans up only its own simulator', () => {
    const { repository } = fixture();
    const commands: string[][] = [];
    const sleeps: number[] = [];

    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-09T10:00:00.000Z'),
      sleep: (ms) => sleeps.push(ms),
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        const joined = [command, ...args].join(' ');
        if (joined.includes('xcodebuild -list')) {
          return { ok: true, status: 0, stdout: JSON.stringify({ project: { schemes: ['App'] } }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('xcodebuild build')) {
          const derivedIndex = args.indexOf('-derivedDataPath');
          const derivedDataPath = args[derivedIndex + 1];
          const appDir = join(derivedDataPath, 'Build/Products/Debug-iphonesimulator/App.app');
          mkdirSync(appDir, { recursive: true });
          writeFileSync(join(appDir, 'Info.plist'), 'x');
          return { ok: true, status: 0, stdout: '** BUILD SUCCEEDED **', stderr: '', command: [command, ...args] };
        }
        if (joined.includes('simctl list devices')) {
          return {
            ok: true,
            status: 0,
            stdout: JSON.stringify({ devices: { r: [{ name: 'iPhone 16 Pro', udid: 'UDID-1', state: 'Shutdown', isAvailable: true }] } }),
            stderr: '',
            command: [command, ...args],
          };
        }
        if (joined.includes('plutil -extract')) {
          return { ok: true, status: 0, stdout: 'com.example.App\n', stderr: '', command: [command, ...args] };
        }
        if (joined.includes('simctl launch')) {
          return { ok: true, status: 0, stdout: 'UDID-1: com.example.App', stderr: '', command: [command, ...args] };
        }
        if (joined.includes('simctl spawn')) {
          return { ok: true, status: 0, stdout: 'log line', stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
      },
    });

    const review = iosSmokeReview(repository, {
      scheme: 'App',
      simulatorName: 'iPhone 16 Pro',
      launchWaitMs: 250,
      cleanupPolicy: 'shutdown_on_success',
    });
    expect(review.overallStatus).toBe('passed');
    expect(review.stages.map((stage) => stage.stage)).toEqual([
      'project_discovery',
      'scheme_selection',
      'build',
      'simulator_preparation',
      'install',
      'launch',
      'screenshot',
      'logs',
    ]);
    expect(review.stages.every((stage) => stage.status === 'passed')).toBe(true);
    expect(review.artifacts.some((path) => path.includes('screenshots') || path.includes('screenshot'))).toBe(true);
    expect(review.simulatorOwnership).toBe('started_by_work');
    expect(review.simulatorCleanup && 'shutdown' in review.simulatorCleanup ? review.simulatorCleanup.shutdown : false).toBe(true);
    expect(sleeps).toEqual([250]);
    expect(commands.some((command) => command.join(' ') === 'xcrun simctl bootstatus UDID-1 -b')).toBe(true);
    expect(commands.some((command) => command.join(' ') === 'xcrun simctl shutdown UDID-1')).toBe(true);
  });

  it('returns build-stage failure only when xcodebuild fails', () => {
    const { repository } = fixture();
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: mockRunner({
        'xcodebuild -list': { stdout: JSON.stringify({ project: { schemes: ['App'] } }) },
        'xcodebuild build': { ok: false, stderr: 'error: compile failed' },
        'simctl list devices': {
          stdout: JSON.stringify({
            devices: {
              'r': [{ name: 'iPhone 16 Pro', udid: 'UDID-1', state: 'Shutdown', isAvailable: true }],
            },
          }),
        },
      }),
    });

    const review = iosSmokeReview(repository, { scheme: 'App' });
    expect(review.overallStatus).toBe('failed');
    expect(review.blockedStage).toBe('build');
    const byStage = Object.fromEntries(review.stages.map((stage) => [stage.stage, stage.status]));
    expect(byStage.project_discovery).toBe('passed');
    expect(byStage.scheme_selection).toBe('passed');
    expect(byStage.build).toBe('failed');
    expect(byStage.install).toBe('skipped');
    expect(byStage.screenshot).toBe('skipped');
  });

  it('returns scheme_selection failure when no schemes exist', () => {
    const { repository } = fixture();
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: mockRunner({
        'xcodebuild -list': { stdout: JSON.stringify({ project: { schemes: [] } }) },
      }),
    });

    const review = iosSmokeReview(repository, {});
    expect(review.overallStatus).toBe('failed');
    expect(review.blockedStage).toBe('scheme_selection');
    expect(review.stages.find((stage) => stage.stage === 'scheme_selection')?.repairHint).toContain('scheme');
  });

  it('exposes smoke_review through the ios plugin adapter', async () => {
    const { repoRoot, controllerHome, repository } = fixture();
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: mockRunner({
        'xcode-select -p': { stdout: '/Applications/Xcode.app/Contents/Developer\n' },
        'xcodebuild -version': { stdout: 'Xcode 18\n' },
        'simctl help': { stdout: 'help\n' },
        'xcodebuild -list': { stdout: JSON.stringify({ project: { schemes: ['App'] } }) },
        'xcodebuild build': { ok: false, stderr: 'error: compile failed' },
        'simctl list devices': {
          stdout: JSON.stringify({
            devices: { r: [{ name: 'iPhone 16 Pro', udid: 'UDID-1', state: 'Shutdown', isAvailable: true }] },
          }),
        },
      }),
    });

    const manifest = buildIosPluginManifest(0, undefined, repoRoot);
    expect(manifest.pluginId).toBe('ios');
    expect(manifest.actions.map((action) => action.actionId)).toContain('smoke_review');

    const result = await executeIosPluginAction({
      controllerHome,
      repoId: repository.repoId,
      repoRoot,
      pluginId: 'ios',
      actionId: 'smoke_review',
      requestId: 'ios-smoke-1',
      args: { scheme: 'App' },
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect(result.overallStatus).toBe('failed');
    expect(result.blockedStage).toBe('build');
    expect(Array.isArray(result.stages)).toBe(true);
  });

  it('keeps a reused simulator even when cleanup is requested', () => {
    const { repository } = fixture();
    const commands: string[][] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        const joined = [command, ...args].join(' ');
        if (joined.includes('simctl boot ')) {
          return { ok: false, status: 1, stdout: '', stderr: 'current state: Booted', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
      },
    });

    const boot = iosSimulatorBoot({ udid: 'UDID-REUSED', openSimulator: false });
    expect(boot.ready).toBe(true);
    expect('ownership' in boot ? boot.ownership : undefined).toBe('reused');
    expect(commands.some((command) => command.join(' ') === 'xcrun simctl bootstatus UDID-REUSED -b')).toBe(true);
  });

  it('uses a build-specific DerivedData directory and rejects ambiguous app products', () => {
    const { repository } = fixture();
    const buildRoots: string[] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-09T10:00:00.000Z'),
      runCommand: (command, args) => {
        const joined = [command, ...args].join(' ');
        if (joined.includes('xcodebuild -list')) {
          return { ok: true, status: 0, stdout: JSON.stringify({ project: { schemes: ['App'] } }), stderr: '', command: [command, ...args] };
        }
        if (joined.includes('xcodebuild build')) {
          const root = args[args.indexOf('-derivedDataPath') + 1];
          buildRoots.push(root);
          for (const name of ['One.app', 'Two.app', 'AppUITests-Runner.app']) {
            mkdirSync(join(root, 'Build/Products/Debug-iphonesimulator', name), { recursive: true });
          }
          return { ok: true, status: 0, stdout: 'ok', stderr: '', command: [command, ...args] };
        }
        return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
      },
    });

    const build = iosAppBuild(repository, { scheme: 'App', simulatorName: 'iPhone 16 Pro' });
    expect(build.ready).toBe(false);
    expect(build.error?.code).toBe('IOS_BUILD_PRODUCT_AMBIGUOUS');
    expect(buildRoots).toHaveLength(1);
    expect('derivedDataPath' in build ? build.derivedDataPath : '').toContain('DerivedData/');
    expect('builtApps' in build ? build.builtApps.some((path: string) => path.includes('AppUITests-Runner.app')) : false).toBe(true);
  });

  it('honors the bounded post-launch wait and classifies screenshots as controlled writes', () => {
    const sleeps: number[] = [];
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      sleep: (ms) => sleeps.push(ms),
      runCommand: (command, args) => ({ ok: true, status: 0, stdout: 'launched', stderr: '', command: [command, ...args] }),
    });
    const launched = iosAppLaunch({ udid: 'UDID-1', bundleId: 'com.example.App', waitMs: 99_999 });
    expect(launched.ready).toBe(true);
    expect('waitMs' in launched ? launched.waitMs : undefined).toBe(15_000);
    expect(sleeps).toEqual([15_000]);

    const manifest = buildIosPluginManifest();
    const screenshot = manifest.actions.find((action) => action.actionId === 'capture_screenshot');
    expect(screenshot?.readOnly).toBe(false);
    expect(screenshot?.risk).toBe('workspace_write');
    expect(screenshot?.confirmation).toBe('none');
  });
});
