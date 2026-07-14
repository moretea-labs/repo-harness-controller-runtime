import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  clearIosXcodeStatusCacheForTest,
  iosProjectDiscover,
  iosSimulatorScreenshot,
  iosSimulatorsList,
  iosXcodeStatus,
  resetIosDevelopmentHooksForTest,
  setIosDevelopmentHooksForTest,
  iosAppInstall,
} from '../../src/runtime/safe-tooling';

const roots: string[] = [];

afterEach(() => {
  resetIosDevelopmentHooksForTest();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-ios-tools-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-ios-tools-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  mkdirSync(join(repoRoot, 'App.xcodeproj'), { recursive: true });
  mkdirSync(join(repoRoot, 'App'), { recursive: true });
  writeFileSync(join(repoRoot, 'App/Info.plist'), '<plist/>\n');
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, repository };
}

describe('iOS development safe tooling', () => {
  it('reports Xcode status and parses simulator JSON through structured commands', () => {
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand(command, args) {
        const joined = [command, ...args].join(' ');
        if (joined === 'xcode-select -p') return { ok: true, status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '', command: [command, ...args] };
        if (joined === 'xcodebuild -version') return { ok: true, status: 0, stdout: 'Xcode 18.0\n', stderr: '', command: [command, ...args] };
        if (joined.startsWith('xcrun simctl help')) return { ok: true, status: 0, stdout: 'simctl\n', stderr: '', command: [command, ...args] };
        if (joined.startsWith('xcrun simctl list devices')) return { ok: true, status: 0, stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ name: 'iPhone 16 Pro', udid: 'UDID-1', state: 'Shutdown', isAvailable: true }] } }), stderr: '', command: [command, ...args] };
        return { ok: false, status: 1, stdout: '', stderr: 'unexpected', command: [command, ...args] };
      },
    });

    expect(iosXcodeStatus().ready).toBe(true);
    const simulators = iosSimulatorsList();
    expect(simulators.ready).toBe(true);
    expect(simulators.ready && 'devices' in simulators ? simulators.devices?.[0]?.name : undefined).toBe('iPhone 16 Pro');
  });

  it('caches host Xcode probes on the hot path and still allows force refresh', () => {
    let probeCount = 0;
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      runCommand(command, args) {
        probeCount += 1;
        const joined = [command, ...args].join(' ');
        if (joined === 'xcode-select -p') return { ok: true, status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '', command: [command, ...args] };
        if (joined === 'xcodebuild -version') return { ok: true, status: 0, stdout: 'Xcode 18.0\n', stderr: '', command: [command, ...args] };
        if (joined.startsWith('xcrun simctl help')) return { ok: true, status: 0, stdout: 'simctl\n', stderr: '', command: [command, ...args] };
        return { ok: false, status: 1, stdout: '', stderr: 'unexpected', command: [command, ...args] };
      },
    });

    expect(iosXcodeStatus().ready).toBe(true);
    const firstProbes = probeCount;
    expect(firstProbes).toBe(3);
    expect(iosXcodeStatus().ready).toBe(true);
    expect(probeCount).toBe(firstProbes);
    clearIosXcodeStatusCacheForTest();
    expect(iosXcodeStatus({ forceRefresh: true }).ready).toBe(true);
    expect(probeCount).toBe(firstProbes + 3);
  });

  it('caches degraded Xcode probes briefly so repeated hot reads do not re-run failing host checks', () => {
    let probeCount = 0;
    let currentMs = 0;
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date(currentMs),
      runCommand(command, args) {
        probeCount += 1;
        const joined = [command, ...args].join(' ');
        if (joined === 'xcode-select -p') return { ok: true, status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '', command: [command, ...args] };
        if (joined === 'xcodebuild -version') return { ok: false, status: 1, stdout: '', stderr: 'license not accepted', command: [command, ...args] };
        if (joined.startsWith('xcrun simctl help')) return { ok: true, status: 0, stdout: 'simctl\n', stderr: '', command: [command, ...args] };
        return { ok: false, status: 1, stdout: '', stderr: 'unexpected', command: [command, ...args] };
      },
    });

    expect(iosXcodeStatus().ready).toBe(false);
    expect(probeCount).toBe(3);
    expect(iosXcodeStatus().ready).toBe(false);
    expect(probeCount).toBe(3);

    currentMs = 10_001;
    expect(iosXcodeStatus().ready).toBe(false);
    expect(probeCount).toBe(6);
  });

  it('discovers projects and writes screenshots only under bounded artifact paths', () => {
    const { repository } = fixture();
    setIosDevelopmentHooksForTest({
      platform: () => 'darwin',
      now: () => new Date('2026-07-06T09:00:00.000Z'),
      runCommand(command, args) {
        return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
      },
    });

    const discovered = iosProjectDiscover(repository);
    expect(discovered.ready).toBe(true);
    expect(discovered.project).toBe('App.xcodeproj');

    const screenshot = iosSimulatorScreenshot(repository, { udid: 'UDID-1', label: 'home' });
    expect(screenshot.ready).toBe(true);
    expect(screenshot.ready && 'screenshot' in screenshot ? screenshot.screenshot : undefined).toStartWith('.repo-harness/ios/screenshots/');
  });

  it('rejects installing unbounded app paths', () => {
    const { repository } = fixture();
    setIosDevelopmentHooksForTest({ platform: () => 'darwin' });
    expect(() => iosAppInstall(repository, { udid: 'UDID-1', appPath: '/tmp/Evil.app' })).toThrow('IOS_APP_PATH_NOT_BOUNDED');
  });
});
