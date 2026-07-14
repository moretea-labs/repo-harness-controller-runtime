import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createWorkContract } from '../../src/runtime/control-plane/facade/work-contract-store';
import { getExecutionJob, listExecutionJobs } from '../../src/runtime/execution/jobs/store';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from '../runtime/process-hygiene';

const fixtures: Array<{ repoRoot: string; controllerHome: string }> = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await terminateProcessesByCommand([fixture.repoRoot, fixture.controllerHome]);
    await waitForNoProcessesByCommand([fixture.repoRoot, fixture.controllerHome]).catch(() => undefined);
    rmSync(fixture.repoRoot, { recursive: true, force: true });
    rmSync(fixture.controllerHome, { recursive: true, force: true });
  }
});

function createFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-work-submit-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-work-submit-home-'));
  fixtures.push({ repoRoot, controllerHome });
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'work-submit-fixture',
    scripts: { 'check:type': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Repo Harness Test'], { cwd: repoRoot });
  execFileSync('git', ['add', 'package.json'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, repoIdOverride: 'repo-work-submit' });
  const ctx = {
    repoRoot,
    controllerHome,
    policy: getMcpPolicy('controller', { repoRoot }),
    toolset: 'advanced' as const,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { ctx, repository, controllerHome };
}

function structured(result: Awaited<ReturnType<typeof callRuntimeTool>>): Record<string, unknown> {
  expect(result).toBeTruthy();
  return result!.structuredContent as Record<string, unknown>;
}

describe('work_submit hardening', () => {
  test('rejects invalid arguments before creating a durable Job', async () => {
    const { ctx, repository, controllerHome } = createFixture();
    const result = await callRuntimeTool(ctx, 'work_submit', {
      repo_id: repository.repoId,
      request_id: 'missing-semantic-key',
      operation: 'read_repository_file',
      arguments: {},
    });
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.structuredContent ?? {})).toContain('INVALID_ARGUMENT');
    expect(listExecutionJobs(controllerHome, repository.repoId, 20)).toHaveLength(0);
  });

  test('work_get and work_list include resumable WorkContracts as well as Execution Jobs', async () => {
    const { ctx, repository, controllerHome } = createFixture();
    const contract = createWorkContract({ controllerHome, repoId: repository.repoId }, {
      workId: 'work-retained-contract',
      repoId: repository.repoId,
      mode: 'goal_workloop',
      objective: 'Review a retained controller work contract',
      acceptanceCriteria: [],
      constraints: { requireHandoffOnAmbiguity: true },
      allowedPaths: [],
      forbiddenPaths: [],
      checks: [],
      requestedBy: 'chatgpt',
      status: 'waiting_for_review',
    });

    const fetched = structured(await callRuntimeTool(ctx, 'work_get', {
      repo_id: repository.repoId,
      work_id: contract.workId,
    }));
    expect((fetched.work as { kind?: string; workId?: string })).toMatchObject({
      kind: 'work_contract',
      workId: contract.workId,
    });

    const listed = structured(await callRuntimeTool(ctx, 'work_list', {
      repo_id: repository.repoId,
      limit: 20,
    }));
    expect((listed.works as Array<{ kind?: string; workId?: string }>).some((work) => work.kind === 'work_contract' && work.workId === contract.workId)).toBe(true);
  });

  test('submits readonly work without write claims and remains resumable after wait timeout', async () => {
    const { ctx, repository, controllerHome } = createFixture();
    const accepted = structured(await callRuntimeTool(ctx, 'work_submit', {
      repo_id: repository.repoId,
      request_id: 'readonly-context-1',
      operation: 'controller_context',
      arguments: {},
    }));
    const work = accepted.work as { workId: string };
    const job = getExecutionJob(controllerHome, repository.repoId, work.workId);
    expect(job.resourceClaims).toEqual([]);
    expect(job.operationMetadata?.mode).toBe('readonly');
    expect(job.operationMetadata?.replayable).toBe(true);

    const resumedByWorkId = structured(await callRuntimeTool(ctx, 'work_get', {
      repo_id: repository.repoId,
      work_id: work.workId,
      wait_ms: 1,
    }));
    expect(String((resumedByWorkId.work as { workId?: string }).workId)).toBe(work.workId);
    expect(typeof resumedByWorkId.timedOut).toBe('boolean');

    const resumedByRequestId = structured(await callRuntimeTool(ctx, 'work_get', {
      repo_id: repository.repoId,
      request_id: 'readonly-context-1',
    }));
    expect(String((resumedByRequestId.work as { workId?: string }).workId)).toBe(work.workId);
  });
});
