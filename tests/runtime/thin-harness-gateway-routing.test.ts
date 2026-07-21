import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  classifyGatewayExecutionPath,
  routeDurableMcpCall,
} from '../../src/runtime/gateway/mcp/router';
import { createMcpToolContext } from '../../src/cli/mcp/server';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { listExecutionJobs } from '../../src/runtime/execution/jobs/store';
import { listLocalBridgeJobSnapshots } from '../../src/cli/local-bridge/job-store';
import { callRepositoryTool } from '../../src/cli/mcp/repository-tools';
import { classifyRepositoryCommand } from '../../src/cli/repositories/command-classifier';
import { assessWorkMode } from '../../src/cli/controller/work-mode';
import { routeExecution, isFastEligibleTool } from '../../src/runtime/execution/thin-harness';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thin-gw-route-'));
  const controllerHome = join(root, 'controller');
  const repoRoot = join(root, 'repo');
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'gateway routing fixture\n');
  writeFileSync(join(repoRoot, 'src', 'lib.ts'), 'export const n = 1;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'init']);
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'gw-route' });
  const ctx = createMcpToolContext({
    controllerHome,
    profile: 'controller',
    repo: repoRoot,
  });
  return { root, controllerHome, repoRoot, repository, ctx };
}

const roots: string[] = [];

beforeEach(() => {
  // no-op; fixtures cleaned in afterEach
});

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Gateway Thin Harness routing before ExecutionJob', () => {
  test('classifies Fast readonly argv before durable path', () => {
    const classification = classifyGatewayExecutionPath('repository_command_execute', {
      command: ['git', 'status', '--short'],
      timeout_ms: 5_000,
    });
    expect(classification.path).toBe('fast');
    expect(classification.decision?.mode).toBe('fast');
  });

  test('async / durable request still forces durable', () => {
    expect(classifyGatewayExecutionPath('repository_command_execute', {
      command: ['git', 'status'],
      apply_mode: 'async',
    }).path).toBe('durable');
    expect(classifyGatewayExecutionPath('repository_command_execute', {
      command: ['bun', 'test'],
      mode: 'durable',
    }).path).toBe('durable');
    expect(classifyGatewayExecutionPath('run_check', {
      check_id: 'typecheck',
    }).path).toBe('durable');
  });

  test('MCP routeDurableMcpCall does not create ExecutionJob for Fast git status', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const localBefore = listLocalBridgeJobSnapshots(fx.repoRoot).length;

    const durable = await routeDurableMcpCall(fx.ctx, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: ['git', 'status', '--short'],
      timeout_ms: 5_000,
    });
    // Fast path must return undefined so the MCP server falls through to direct repository tools.
    expect(durable).toBeUndefined();

    const direct = await callRepositoryTool(fx.controllerHome, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: ['git', 'status', '--short'],
      timeout_ms: 5_000,
      include_latency_breakdown: true,
    });
    expect(direct?.isError).not.toBe(true);
    const payload = direct?.structuredContent as Record<string, unknown>;
    expect(payload.mode).toBe('fast');
    expect(payload.path).toBe('fast');
    expect((payload.durableSideEffects as { executionJobCount?: number } | undefined)?.executionJobCount ?? 0).toBe(0);
    expect((payload.durableSideEffects as { localJobCount?: number } | undefined)?.localJobCount ?? 0).toBe(0);
    expect((payload.durableSideEffects as { workerSpawnCount?: number } | undefined)?.workerSpawnCount ?? 0).toBe(0);

    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
    expect(listLocalBridgeJobSnapshots(fx.repoRoot).length).toBe(localBefore);
  });

  test('worker-owned repository_command_execute does not create nested Local Job', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const localBefore = listLocalBridgeJobSnapshots(fx.repoRoot).length;
    const response = await callRepositoryTool(fx.controllerHome, 'repository_command_execute', {
      repo_id: fx.repository.repoId,
      command: ['git', 'rev-parse', 'HEAD'],
      timeout_ms: 5_000,
      mode: 'durable',
      __from_durable_worker: true,
      __execution_job_id: 'job-test-1',
    });
    expect(response?.isError).not.toBe(true);
    const payload = response?.structuredContent as Record<string, unknown>;
    expect(payload.path).toBe('durable_worker_inline');
    expect(payload.mode).toBe('durable');
    expect(listLocalBridgeJobSnapshots(fx.repoRoot).length).toBe(localBefore);
    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(0);
  });

  test('argv readonly git branch/worktree/log are Fast eligible', () => {
    for (const command of [
      ['git', 'branch', '--show-current'],
      ['git', 'worktree', 'list'],
      ['git', 'log', '-n', '5', '--oneline'],
      ['git', 'show', 'HEAD:README.md'],
      ['git', 'ls-files'],
      ['rg', 'export', 'src'],
      ['bun', '--version'],
    ] as const) {
      expect(classifyRepositoryCommand([...command]).risk).toBe('readonly');
      expect(routeExecution({
        operation: 'repository_command_execute',
        command: [...command],
      }).mode).toBe('fast');
      expect(isFastEligibleTool('repository_command_execute', { command: [...command] })).toBe(true);
    }
  });

  test('dangerous shell and external write stay durable or reject', () => {
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['git', 'reset', '--hard', 'HEAD'],
    }).mode).toBe('reject');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: 'rm -rf /',
    }).mode).toBe('reject');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: ['git', 'push', 'origin', 'main'],
    }).mode).toBe('durable');
    expect(routeExecution({
      operation: 'repository_command_execute',
      command: 'git status && echo hi',
    }).mode).toBe('durable'); // shell not argv → durable
  });

  test('small multi-file work stays direct_edit / fast and never auto-campaign', () => {
    const assessment = assessWorkMode({
      description: 'Update three TypeScript helpers and a focused unit test',
      knownPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'tests/a.test.ts'],
      expectedFiles: 4,
      expectedChangedLines: 120,
    });
    expect(assessment.recommendedMode).toBe('direct_edit');
    expect(assessment.executionPath).toBe('fast');
    expect(assessment.issueRequired).toBe(false);
    expect(assessment.campaignRequired).toBe(false);

    const directCampaign = assessWorkMode({
      description: 'Ship three independent product workstreams in parallel',
      requiresIndependentDeliverables: true,
      independentTaskCount: 3,
      requiresParallelism: true,
    });
    expect(directCampaign.recommendedMode).toBe('direct_edit');
    expect(directCampaign.executionPath).toBe('durable');
    expect(directCampaign.campaignRequired).toBe(false);

    const campaign = assessWorkMode({
      description: 'Use Agents to ship three independent product workstreams in parallel',
      requiresIndependentDeliverables: true,
      independentTaskCount: 3,
      requiresParallelism: true,
      agentRequested: true,
    });
    expect(campaign.recommendedMode).toBe('campaign');
    expect(campaign.executionPath).toBe('campaign');
    expect(campaign.campaignRequired).toBe(true);
  });

  test('never recommends quick_agent or Issue dispatch without explicit Agent opt-in', () => {
    const medium = assessWorkMode({
      description: 'Implement a broad but bounded refactor directly',
      expectedFiles: 10,
      expectedChangedLines: 1_500,
    });
    expect(medium.recommendedMode).toBe('direct_edit');
    expect(medium.executionPath).toBe('durable');
    expect(medium.issueRequired).toBe(false);

    const explicitQuickAgent = assessWorkMode({
      description: 'Use Codex for a broad but bounded refactor',
      expectedFiles: 10,
      expectedChangedLines: 1_500,
      agentRequested: true,
    });
    expect(explicitQuickAgent.recommendedMode).toBe('quick_agent');

    const broad = assessWorkMode({
      description: 'Implement a large cross-cutting change directly',
      expectedFiles: 20,
      expectedChangedLines: 3_000,
    });
    expect(broad.recommendedMode).toBe('direct_edit');
    expect(broad.executionPath).toBe('durable');
    expect(broad.issueRequired).toBe(false);
    expect(broad.nextTools).not.toContain('dispatch_task');

    const explicitIssueAgent = assessWorkMode({
      description: 'Use Codex for a large cross-cutting change',
      expectedFiles: 20,
      expectedChangedLines: 3_000,
      agentRequested: true,
    });
    expect(explicitIssueAgent.recommendedMode).toBe('issue_task');
    expect(explicitIssueAgent.issueRequired).toBe(true);
  });

  test('workbench assess_work_mode keeps Agent routing opt-in', async () => {
    const fx = fixture();
    roots.push(fx.root);

    const directResponse = await callRepositoryTool(fx.controllerHome, 'repository_workbench', {
      repo_id: fx.repository.repoId,
      operation: 'assess_work_mode',
      payload: {
        description: 'Implement a broad refactor directly',
        expected_files: 10,
        expected_changed_lines: 1_500,
      },
    });
    expect(directResponse?.isError).not.toBe(true);
    expect((directResponse?.structuredContent as { assessment: { recommendedMode: string } }).assessment.recommendedMode).toBe('direct_edit');

    const agentResponse = await callRepositoryTool(fx.controllerHome, 'repository_workbench', {
      repo_id: fx.repository.repoId,
      operation: 'assess_work_mode',
      payload: {
        description: 'Use Codex for a broad refactor',
        expected_files: 10,
        expected_changed_lines: 1_500,
        agent_requested: true,
      },
    });
    expect(agentResponse?.isError).not.toBe(true);
    expect((agentResponse?.structuredContent as { assessment: { recommendedMode: string } }).assessment.recommendedMode).toBe('quick_agent');
  });

  test('workbench batch_execute runs multi-step Fast Path with one parent receipt', async () => {
    const fx = fixture();
    roots.push(fx.root);
    const jobsBefore = listExecutionJobs(fx.controllerHome, fx.repository.repoId).length;
    const response = await callRepositoryTool(fx.controllerHome, 'repository_workbench', {
      repo_id: fx.repository.repoId,
      operation: 'batch_execute',
      payload: {
        include_latency_breakdown: true,
        steps: [
          { kind: 'git_status', input: {} },
          { kind: 'search', input: { query: 'export' } },
          { kind: 'read_file', input: { path: 'README.md' } },
          { kind: 'git_diff', input: {} },
        ],
      },
    });
    expect(response?.isError).not.toBe(true);
    const payload = response?.structuredContent as Record<string, unknown>;
    expect(payload.mode).toBe('fast');
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.steps) && (payload.steps as unknown[]).length).toBe(4);
    expect(payload.receipt).toBeTruthy();
    expect(listExecutionJobs(fx.controllerHome, fx.repository.repoId).length).toBe(jobsBefore);
  });
});
