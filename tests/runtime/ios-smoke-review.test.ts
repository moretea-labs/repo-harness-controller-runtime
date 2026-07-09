import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
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
  it('aggregates success across all stages and records screenshot artifacts', () => {
    const { repository } = fixture();
    const appDir = join(repository.canonicalRoot, '.repo-harness/ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'Info.plist'), 'x');

    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-09T10:00:00.000Z'),
      runCommand: mockRunner({
        'xcodebuild -list': {
          stdout: JSON.stringify({ project: { schemes: ['App'] } }),
        },
        'xcodebuild build': { ok: true, stdout: '** BUILD SUCCEEDED **' },
        'simctl list devices': {
          stdout: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
                { name: 'iPhone 16 Pro', udid: 'UDID-1', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
        },
        'simctl boot': { ok: true },
        'simctl install': { ok: true },
        'simctl launch': { ok: true, stdout: 'UDID-1: com.example.App' },
        'simctl io': { ok: true },
        'simctl spawn': { ok: true, stdout: 'log line' },
        'plutil -extract': { ok: true, stdout: 'com.example.App\n' },
      }),
    });

    // Pretend build produced the app path by placing it before review; smoke review also finds built apps.
    const review = iosSmokeReview(repository, { scheme: 'App', simulatorName: 'iPhone 16 Pro' });
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
});
