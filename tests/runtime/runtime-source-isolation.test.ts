import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { controllerServiceStatus } from '../../src/cli/controller/lifecycle';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import {
  collectRuntimeSourceIdentity,
  CONTROLLER_RUNTIME_SOURCE_ROOT_ENV,
  evaluateActiveRuntimeSourceDrift,
  evaluateRuntimeSourceDrift,
  formatRuntimeSourceDriftMessage,
  packageRuntimeSourceRoot,
  readRuntimeGeneration,
  resolveControllerRuntimeSourceRoot,
  rotateRuntimeGeneration,
} from '../../src/runtime/control-plane/runtime-generation';
import { writeJsonAtomic } from '../../src/runtime/shared/json-files';

const roots: string[] = [];
const previousEnv = process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousEnv === undefined) delete process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV];
  else process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = previousEnv;
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initGitRepo(repoRoot: string, name: string): void {
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name }, null, 2));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Repo Harness Test');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'init');
}

function pinRuntimeSource(root: string): void {
  process.env[CONTROLLER_RUNTIME_SOURCE_ROOT_ENV] = root;
}

function mcpContext(controllerHome: string, repository: ReturnType<typeof registerRepository>): MultiRepositoryMcpToolContext {
  const policy = getMcpPolicy('controller', { repoRoot: repository.canonicalRoot });
  return {
    repoRoot: repository.canonicalRoot,
    controllerHome,
    policy,
    toolset: 'core',
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, unknown> {
  expect(result).toBeTruthy();
  return (result!.structuredContent
    ?? JSON.parse(result!.content[0] && 'text' in result!.content[0] ? String(result!.content[0].text) : '{}')) as Record<string, unknown>;
}

describe('runtime source isolation', () => {
  test('resolver prefers package root over ambient execution cwd', () => {
    const business = tempRoot('repo-harness-business-cwd-');
    initGitRepo(business, 'business-app');
    const resolved = resolveControllerRuntimeSourceRoot({ cwd: business, env: {} });
    expect(resolved.reason).toBe('package-root');
    expect(resolved.root).toBe(packageRuntimeSourceRoot());
    expect(realpathSync(resolved.root!)).not.toBe(realpathSync(business));
  });

  test('execution repository is never used as current runtime source for drift', () => {
    const runtimeRoot = tempRoot('repo-harness-runtime-src-');
    const businessRoot = tempRoot('repo-harness-business-src-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    initGitRepo(businessRoot, 'business-app');
    git(businessRoot, 'checkout', '-b', 'perf-i18n-global-opt');

    const active = collectRuntimeSourceIdentity(runtimeRoot);
    pinRuntimeSource(runtimeRoot);

    const withExecutionOverride = evaluateRuntimeSourceDrift(
      active,
      collectRuntimeSourceIdentity(businessRoot),
    );
    expect(withExecutionOverride.restartRequired).toBe(true);
    expect(withExecutionOverride.reasons.some((reason) => reason.includes('runtime source root moved'))).toBe(true);

    const isolated = evaluateActiveRuntimeSourceDrift(active);
    expect(isolated.restartRequired).toBe(false);
    expect(isolated.code).toBe('RUNTIME_SOURCE_OK');
    expect(isolated.current?.canonicalRoot).toBe(realpathSync(runtimeRoot));
    expect(isolated.current?.branch).toBe('main');
  });

  test('session-like repository switch leaves generation identity unchanged', () => {
    const runtimeRoot = tempRoot('repo-harness-runtime-gen-');
    const repoA = tempRoot('repo-harness-exec-a-');
    const repoB = tempRoot('repo-harness-exec-b-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    initGitRepo(repoA, 'business-a');
    initGitRepo(repoB, 'business-b');
    pinRuntimeSource(runtimeRoot);

    const controllerHome = tempRoot('repo-harness-runtime-home-');
    ensureControllerHome(controllerHome);
    const before = rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(runtimeRoot));
    const beforeRaw = readFileSync(join(controllerHome, 'system', 'runtime-generation.json'), 'utf8');

    // Simulate bind/switch of execution repositories without rotating generation.
    registerRepository({ path: repoA, controllerHome, displayName: 'A' });
    registerRepository({ path: repoB, controllerHome, displayName: 'B' });
    const after = readRuntimeGeneration(controllerHome);
    const afterRaw = readFileSync(join(controllerHome, 'system', 'runtime-generation.json'), 'utf8');

    expect(after?.generation).toBe(before.generation);
    expect(after?.revision).toBe(before.revision);
    expect(after?.source.canonicalRoot).toBe(before.source.canonicalRoot);
    expect(afterRaw).toBe(beforeRaw);

    const drift = evaluateActiveRuntimeSourceDrift(after?.source);
    expect(drift.restartRequired).toBe(false);
  });

  test('missing runtime snapshot is fail-closed with structured message', () => {
    const drift = evaluateRuntimeSourceDrift(undefined, collectRuntimeSourceIdentity(packageRuntimeSourceRoot()));
    expect(drift.restartRequired).toBe(true);
    expect(drift.code).toBe('RUNTIME_SOURCE_SNAPSHOT_MISSING');
    expect(drift.reasons).toEqual(['Controller runtime source snapshot is missing']);
    expect(formatRuntimeSourceDriftMessage(drift)).toContain('snapshot is missing');
    expect(formatRuntimeSourceDriftMessage(drift)).not.toContain('execution workspace');
  });

  test('true runtime source dirty triggers stale with accurate message', () => {
    const runtimeRoot = tempRoot('repo-harness-runtime-dirty-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    const active = collectRuntimeSourceIdentity(runtimeRoot);
    writeFileSync(join(runtimeRoot, 'src', 'runtime-change.ts'), 'export const changed = true;\n');
    pinRuntimeSource(runtimeRoot);

    const drift = evaluateActiveRuntimeSourceDrift(active);
    expect(drift.restartRequired).toBe(true);
    expect(drift.code).toBe('RUNTIME_SOURCE_SNAPSHOT_STALE');
    expect(drift.reasons).toContain('runtime source files changed after startup');
    expect(formatRuntimeSourceDriftMessage(drift)).toContain('Controller runtime source changed after startup');
  });

  test('accepts a clean non-default branch as the authoritative runtime checkout', () => {
    const runtimeRoot = tempRoot('repo-harness-runtime-stable-branch-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    git(runtimeRoot, 'checkout', '-b', 'codex/canonical-stable-baseline');
    const active = collectRuntimeSourceIdentity(runtimeRoot);

    writeFileSync(join(runtimeRoot, 'src', 'main-only-change.ts'), 'export const mainOnly = true;\n');
    git(runtimeRoot, 'checkout', 'main');
    git(runtimeRoot, 'add', '.');
    git(runtimeRoot, 'commit', '-m', 'main diverges from stable runtime');
    git(runtimeRoot, 'checkout', 'codex/canonical-stable-baseline');

    const current = collectRuntimeSourceIdentity(runtimeRoot);
    expect(current.defaultBranch).toBe('main');
    expect(current.defaultBranchCommit).not.toBe(active.commit);
    const drift = evaluateRuntimeSourceDrift(active, current);

    expect(drift.restartRequired).toBe(false);
    expect(drift.code).toBe('RUNTIME_SOURCE_OK');
  });

  test('MCP rh_status does not mark RUNTIME_SOURCE stale for a different execution repository', async () => {
    const runtimeRoot = tempRoot('repo-harness-runtime-mcp-');
    const businessRoot = tempRoot('repo-harness-business-mcp-');
    const controllerHome = tempRoot('repo-harness-home-mcp-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    initGitRepo(businessRoot, 'business-app');
    git(businessRoot, 'checkout', '-b', 'perf-i18n-global-opt');
    pinRuntimeSource(runtimeRoot);
    ensureControllerHome(controllerHome);

    const generation = rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(runtimeRoot));
    writeJsonAtomic(join(controllerHome, 'daemon', 'state.json'), {
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      gatewaySeparated: true,
      workerIsolation: true,
      generation: generation.generation,
      source: generation.source,
    });
    writeFileSync(join(controllerHome, 'daemon', 'controller.pid'), `${process.pid}\n`, 'utf8');
    writeJsonAtomic(join(controllerHome, 'scheduler', 'state.json'), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: new Date().toISOString(),
      lastTickAt: new Date().toISOString(),
      lastDispatchAt: new Date().toISOString(),
      lastReconcileAt: new Date().toISOString(),
      lastRepoDispatch: {},
    });

    const repository = registerRepository({ path: businessRoot, controllerHome, displayName: 'Business' });
    const payload = structured(await callRuntimeTool(mcpContext(controllerHome, repository), 'rh_status', {
      repo_id: repository.repoId,
      operation: 'get',
    }));
    const data = payload.data as {
      readiness: { ready: boolean; state: string; reasons: Array<{ code: string; message: string }> };
      repositoryState?: { branch?: string | null };
      runtime?: { source?: { canonicalRoot?: string; branch?: string | null } };
    };
    expect(data.readiness.reasons.some((reason) => reason.code.startsWith('RUNTIME_SOURCE'))).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('runtime source root moved');
    // repository state still reflects the business checkout
    if (data.repositoryState?.branch) {
      expect(data.repositoryState.branch).toBe('perf-i18n-global-opt');
    }
  });

  test('CLI controller status and active drift agree under the same fixture', async () => {
    const runtimeRoot = tempRoot('repo-harness-runtime-cli-');
    const businessRoot = tempRoot('repo-harness-business-cli-');
    const controllerHome = tempRoot('repo-harness-home-cli-');
    initGitRepo(runtimeRoot, 'controller-runtime-fixture');
    initGitRepo(businessRoot, 'business-app');
    pinRuntimeSource(runtimeRoot);
    ensureControllerHome(controllerHome);
    const generation = rotateRuntimeGeneration(controllerHome, collectRuntimeSourceIdentity(runtimeRoot));
    writeJsonAtomic(join(controllerHome, 'daemon', 'state.json'), {
      schemaVersion: 1,
      status: 'ready',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      generation: generation.generation,
      source: generation.source,
    });

    const drift = evaluateActiveRuntimeSourceDrift(generation.source);
    const status = await controllerServiceStatus({ repo: businessRoot, controllerHome });
    expect(drift.restartRequired).toBe(false);
    expect(status.restartRequired).toBe(false);
    expect(status.runtimeSource?.canonicalRoot).toBe(realpathSync(runtimeRoot));
    expect(status.runtimeSource?.canonicalRoot).not.toBe(realpathSync(businessRoot));
  });
});
