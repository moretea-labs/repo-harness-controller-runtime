import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRepositories } from '../../src/cli/repositories/registry';
import { CONTROLLER_SCOPE_REPO_ID, controllerSystemRoot } from '../../src/cli/repositories/controller-home';
import {
  executeLocalSystemPluginAction,
  resetLocalSystemPluginHooksForTest,
  setLocalSystemPluginHooksForTest,
} from '../../src/runtime/plugins/local-system-adapter';
import {
  controllerPluginRepository,
  listAssistantPluginManifests,
  submitAssistantPluginAction,
} from '../../src/runtime/plugins/store';
import { executeExecutionJob } from '../../src/runtime/execution/workers/executor';

const roots: string[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function input(controllerHome: string, actionId: string, args: Record<string, unknown> = {}) {
  return {
    controllerHome,
    repoId: CONTROLLER_SCOPE_REPO_ID,
    repoRoot: controllerSystemRoot(controllerHome),
    pluginId: 'local_system',
    actionId,
    requestId: `test-${actionId}`,
    args,
    origin: { surface: 'mcp' as const, actor: 'test' },
  };
}

afterEach(() => {
  resetLocalSystemPluginHooksForTest();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('controller-scoped local_system plugin', () => {
  test('executes a bounded durable diagnostic without registering a repository', async () => {
    const controllerHome = temp('repo-harness-local-system-home-');
    setLocalSystemPluginHooksForTest({
      runCommand: (command, args) => ({
        ok: true,
        status: 0,
        stdout: command === 'ps' ? 'x'.repeat(100_000) : 'ok',
        stderr: '',
        command: [command, ...args],
      }),
    });

    const repository = controllerPluginRepository(controllerHome);
    const manifests = listAssistantPluginManifests(controllerHome, repository);
    expect(manifests.map((manifest) => manifest.pluginId)).toEqual(['local_system']);
    expect(listRepositories(controllerHome)).toEqual([]);

    const submitted = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'local_system',
      actionId: 'system_snapshot',
      requestId: 'local-system-durable-snapshot',
      args: {},
      origin: { surface: 'mcp', actor: 'test' },
    });
    expect(submitted.job.repoId).toBe(CONTROLLER_SCOPE_REPO_ID);
    const result = await executeExecutionJob(controllerHome, submitted.job);
    expect(result.ok).toBe(true);
    expect(result.repoRoot).toBe(controllerSystemRoot(controllerHome));
    expect(JSON.stringify(result.result).length).toBeLessThan(90_000);
    expect(listRepositories(controllerHome)).toEqual([]);
  });

  test('opens applications through typed argv only', async () => {
    const controllerHome = temp('repo-harness-local-system-open-');
    const commands: string[][] = [];
    setLocalSystemPluginHooksForTest({
      runCommand: (command, args) => {
        commands.push([command, ...args]);
        return { ok: true, status: 0, stdout: '', stderr: '', command: [command, ...args] };
      },
    });

    const result = await executeLocalSystemPluginAction(input(controllerHome, 'open_application', { app_name: 'Xcode' }));
    expect(result.opened).toBe(true);
    expect(commands).toEqual([['open', '-a', 'Xcode']]);
  });

  test('uses expiring target grants and blocks traversal and symlink escapes', async () => {
    const controllerHome = temp('repo-harness-local-system-targets-');
    const target = temp('repo-harness-local-system-root-');
    const outside = temp('repo-harness-local-system-outside-');
    writeFileSync(join(target, 'inside.txt'), 'inside\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(outside, join(target, 'escape'));

    await executeLocalSystemPluginAction(input(controllerHome, 'authorize_target', {
      target_key: 'workspace',
      root_path: target,
      expires_in_minutes: 60,
      reason: 'test target',
    }));
    const read = await executeLocalSystemPluginAction(input(controllerHome, 'read_text', {
      target_key: 'workspace',
      path: 'inside.txt',
    }));
    expect(read.content).toContain('inside');

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'read_text', {
      target_key: 'workspace',
      path: '../secret.txt',
    }))).rejects.toThrow('LOCAL_SYSTEM_PATH_OUTSIDE_TARGET');
    await expect(executeLocalSystemPluginAction(input(controllerHome, 'read_text', {
      target_key: 'workspace',
      path: 'escape/secret.txt',
    }))).rejects.toThrow('LOCAL_SYSTEM_SYMLINK_ESCAPE');

    const targetsPath = join(controllerSystemRoot(controllerHome), 'local-system', 'targets.json');
    const store = JSON.parse(readFileSync(targetsPath, 'utf8')) as { targets: Array<Record<string, unknown>> };
    store.targets[0].expiresAt = '2000-01-01T00:00:00.000Z';
    writeFileSync(targetsPath, `${JSON.stringify(store, null, 2)}\n`);
    const listed = await executeLocalSystemPluginAction(input(controllerHome, 'list_targets'));
    expect(listed.targets).toEqual([]);
  });

  test('never overwrites an existing destination', async () => {
    const controllerHome = temp('repo-harness-local-system-copy-');
    const target = temp('repo-harness-local-system-copy-root-');
    mkdirSync(join(target, 'folder'));
    writeFileSync(join(target, 'source.txt'), 'source');
    writeFileSync(join(target, 'folder/destination.txt'), 'existing');
    await executeLocalSystemPluginAction(input(controllerHome, 'authorize_target', {
      target_key: 'workspace', root_path: target, reason: 'copy test',
    }));

    await expect(executeLocalSystemPluginAction(input(controllerHome, 'copy_file', {
      source_target_key: 'workspace',
      source_path: 'source.txt',
      destination_target_key: 'workspace',
      destination_path: 'folder/destination.txt',
    }))).rejects.toThrow('LOCAL_SYSTEM_DESTINATION_EXISTS');
  });
});
