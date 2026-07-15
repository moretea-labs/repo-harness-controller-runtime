import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerEpoch } from '../../src/cli/agent-jobs/worker-lifecycle';
import { projectAgentRunToLocalBridgeStatus } from '../../src/cli/local-bridge/job-store';
import { runControllerCheckAsync, snapshotControllerCheck } from '../../src/cli/controller/check-runner';
import { executeRepositoryCommandAsync } from '../../src/cli/repositories/command-executor';
import { ensureRepositoryRuntimeStorage } from '../../src/cli/repositories/runtime-storage';
import type { RepositoryRecord } from '../../src/cli/repositories/types';
import { stableCheckoutId } from '../../src/cli/repositories/identity';
import { createCampaign, getCampaign, updateCampaign } from '../../src/runtime/workflow/campaigns/store';
import { openCampaignCheckpoint } from '../../src/runtime/workflow/campaigns/review';
import { reconcileCampaign } from '../../src/runtime/workflow/campaigns/engine';
import { cancelCampaign } from '../../src/runtime/workflow/campaigns/cleanup';
import { createExecutionJob, getExecutionJob, transitionExecutionJob } from '../../src/runtime/execution/jobs/store';
import { legacySettlementTimeoutMs } from '../../src/runtime/execution/jobs/legacy-adapter';
import type { LocalBridgeJob } from '../../src/cli/local-bridge/types';

const roots: string[] = [];
function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function repository(root: string, controllerHome: string, repoId = 'repo-hardening'): RepositoryRecord {
  const checkoutId = stableCheckoutId(repoId, root);
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    repoId,
    displayName: repoId,
    localRoot: root,
    canonicalRoot: root,
    activeCheckoutId: checkoutId,
    checkouts: [{
      checkoutId,
      localRoot: root,
      canonicalRoot: root,
      worktree: false,
      branch: 'main',
      createdAt: at,
      updatedAt: at,
      lastSeenAt: at,
    }],
    defaultBranch: 'main',
    repositoryType: 'local-git',
    enabled: true,
    createdAt: at,
    updatedAt: at,
    lastSeenAt: at,
    configurationPath: join(root, '.ai', 'harness', 'repository.json'),
    stateStorageStrategy: 'hybrid',
  };
}

function forceReconcile(controllerHome: string, campaignId: string) {
  const current = getCampaign(controllerHome, 'repo-a', campaignId);
  if (current.nextReconcileAt) {
    updateCampaign(controllerHome, 'repo-a', campaignId, `force:${current.revision}`, (campaign) => {
      campaign.nextReconcileAt = undefined;
      return campaign;
    }, { wakeScheduler: false });
  }
  return reconcileCampaign(controllerHome, 'repo-a', campaignId);
}

describe('runtime consistency hardening', () => {
  test('keeps a live controller epoch stable and only rotates it on takeover', async () => {
    const root = temporary('repo-harness-owner-');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    if (!child.pid) throw new Error('child did not start');
    const first = ensureControllerEpoch(root, child.pid);
    const sibling = ensureControllerEpoch(root, process.pid);
    expect(sibling.epoch).toBe(first.epoch);
    expect(sibling.pid).toBe(child.pid);
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    const takeover = ensureControllerEpoch(root, process.pid);
    expect(takeover.epoch).not.toBe(first.epoch);
    expect(takeover.revision).toBe((first.revision ?? 1) + 1);
  });

  test('serializes parallel ownership readers behind one live controller epoch', async () => {
    const root = temporary('repo-harness-owner-race-');
    const owner = ensureControllerEpoch(root, process.pid);
    const modulePath = join(import.meta.dir, '../../src/cli/agent-jobs/worker-lifecycle.ts');
    const script = `import { ensureControllerEpoch } from ${JSON.stringify(modulePath)}; process.stdout.write(JSON.stringify(ensureControllerEpoch(${JSON.stringify(root)})));`;
    const records = await Promise.all(Array.from({ length: 12 }, () => new Promise<{ epoch: string; pid: number; revision?: number }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `ownership reader exited ${String(code)}`));
        else resolvePromise(JSON.parse(stdout));
      });
    })));
    expect(new Set(records.map((record) => record.epoch))).toEqual(new Set([owner.epoch]));
    expect(new Set(records.map((record) => record.pid))).toEqual(new Set([process.pid]));
    expect(new Set(records.map((record) => record.revision))).toEqual(new Set([owner.revision]));
  });

  test('projects starting Agent Runs as active Local Jobs', () => {
    expect(projectAgentRunToLocalBridgeStatus('starting')).toBe('running');
    expect(projectAgentRunToLocalBridgeStatus('queued')).toBe('dispatched');
    expect(projectAgentRunToLocalBridgeStatus('succeeded')).toBe('succeeded');
  });

  test('gives durable legacy settlement more time than the inner operation timeout', () => {
    const job = {
      payload: { timeoutMs: 8_000 },
    } as unknown as LocalBridgeJob;
    expect(legacySettlementTimeoutMs(job)).toBe(38_000);

    const defaulted = { payload: {} } as unknown as LocalBridgeJob;
    expect(legacySettlementTimeoutMs(defaulted)).toBe(60 * 60_000 + 30_000);
  });

  test('executes an immutable check snapshot after the registry changes', async () => {
    const root = temporary('repo-harness-check-snapshot-');
    mkdirSync(join(root, '.repo-harness'), { recursive: true });
    writeFileSync(join(root, '.repo-harness', 'checks.json'), JSON.stringify({
      version: 1,
      checks: {
        fixture: { command: [process.execPath, '-e', "process.stdout.write('snapshot-ok')"] },
      },
    }));
    const snapshot = snapshotControllerCheck(root, 'fixture');
    writeFileSync(join(root, '.repo-harness', 'checks.json'), JSON.stringify({ version: 1, checks: {} }));
    const result = await runControllerCheckAsync(root, 'fixture', { snapshot });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('snapshot-ok');
  });

  test('ignores harness-owned runtime writes when classifying repository mutations', async () => {
    const root = temporary('repo-harness-command-delta-');
    const controllerHome = temporary('repo-harness-command-home-');
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Repo Harness Test']);
    git(root, ['config', 'user.email', 'repo-harness@example.com']);
    writeFileSync(join(root, 'README.md'), 'hello\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'init']);
    writeFileSync(join(root, 'README.md'), 'pre-existing user change\n');
    const record = repository(root, controllerHome);
    const execution = await executeRepositoryCommandAsync(controllerHome, record, {
      command: 'git status --short',
    }, {
      onSpawn: () => {
        const path = join(root, '.ai', 'harness', 'local-jobs', 'fixture');
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'job.json'), '{}\n');
      },
    });
    expect(execution.ok).toBe(true);
    expect(execution.repositoryChanged).toBe(false);
    expect(execution.changedPaths).toEqual([]);
    expect(execution.policyDecision).toBe('allowed');
  });

  test('detects content changes to a path that was already dirty before a read-only command', async () => {
    const root = temporary('repo-harness-command-fingerprint-');
    const controllerHome = temporary('repo-harness-command-fingerprint-home-');
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Repo Harness Test']);
    git(root, ['config', 'user.email', 'repo-harness@example.com']);
    writeFileSync(join(root, 'README.md'), 'hello\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'init']);
    writeFileSync(join(root, 'README.md'), 'dirty before command\n');
    const record = repository(root, controllerHome);
    const execution = await executeRepositoryCommandAsync(controllerHome, record, {
      command: 'git status --short',
    }, {
      onSpawn: () => writeFileSync(join(root, 'README.md'), 'changed while command ran\n'),
    });
    expect(execution.repositoryChanged).toBe(true);
    expect(execution.changedPaths).toEqual(['README.md']);
  });

  test('migrates non-empty worktree storage and quarantines collisions without blocking execution', () => {
    const root = temporary('repo-harness-storage-');
    const controllerHome = temporary('repo-harness-storage-home-');
    const record = repository(root, controllerHome);
    const source = join(root, '.ai', 'harness', 'worktrees');
    const target = join(controllerHome, 'repositories', record.repoId, 'worktrees');
    mkdirSync(join(source, 'stale'), { recursive: true });
    writeFileSync(join(source, 'stale', 'source.txt'), 'source');
    mkdirSync(join(source, 'stale', 'node_modules', 'dependency'), { recursive: true });
    writeFileSync(join(source, 'stale', 'node_modules', 'dependency', 'generated.bin'), 'generated');
    mkdirSync(join(target, 'stale'), { recursive: true });
    writeFileSync(join(target, 'stale', 'target.txt'), 'target');
    const report = ensureRepositoryRuntimeStorage(record, controllerHome);
    const binding = report.bindings.find((entry) => entry.name === 'worktrees');
    expect(report.readyForExecution).toBe(true);
    expect(binding?.status).toBe('quarantined');
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, 'stale', 'target.txt'))).toBe(true);
    const quarantineRoot = join(controllerHome, 'repositories', record.repoId, 'quarantine', 'runtime-storage', 'worktrees');
    expect(existsSync(quarantineRoot)).toBe(true);
    const [quarantinedEntry] = readdirSync(quarantineRoot);
    expect(existsSync(join(quarantineRoot, quarantinedEntry, 'source.txt'))).toBe(true);
    expect(existsSync(join(quarantineRoot, quarantinedEntry, 'node_modules'))).toBe(false);
  });

  test('terminates no-change Campaign tasks without review or rescheduling', () => {
    const controllerHome = temporary('repo-harness-campaign-no-change-');
    const created = createCampaign(controllerHome, {
      repoId: 'repo-a', checkoutId: 'checkout-a', requestId: 'no-change', semanticKey: 'no-change',
      title: 'No change', goal: 'Already satisfied', reviewPolicy: 'every_task',
      tasks: [{ taskId: 'T1', title: 'Inspect', operation: 'record_candidate_finding' }],
    }).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    transitionExecutionJob(controllerHome, 'repo-a', campaign.tasks[0].jobId!, 'running');
    transitionExecutionJob(controllerHome, 'repo-a', campaign.tasks[0].jobId!, 'succeeded', {
      result: { changeOutcome: 'no_change' },
    });
    forceReconcile(controllerHome, created.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    expect(campaign.tasks[0].status).toBe('succeeded_no_change');
    expect(campaign.tasks[0].outcome).toBe('already_satisfied');
    expect(campaign.status).toBe('ready_for_human_acceptance');
    expect(campaign.checkpoints).toHaveLength(0);
    expect(campaign.tasks[0].jobId).toBeTruthy();
  });

  test('fails required-change tasks explicitly as no-effect', () => {
    const controllerHome = temporary('repo-harness-campaign-no-effect-');
    const created = createCampaign(controllerHome, {
      repoId: 'repo-a', checkoutId: 'checkout-a', requestId: 'no-effect', semanticKey: 'no-effect',
      title: 'Must change', goal: 'Create a diff',
      tasks: [{ taskId: 'T1', title: 'Change', operation: 'record_candidate_finding', requiresChanges: true }],
    }).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    let campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    transitionExecutionJob(controllerHome, 'repo-a', campaign.tasks[0].jobId!, 'running');
    transitionExecutionJob(controllerHome, 'repo-a', campaign.tasks[0].jobId!, 'succeeded', {
      result: { changeOutcome: 'no_change' },
    });
    forceReconcile(controllerHome, created.campaignId);
    campaign = getCampaign(controllerHome, 'repo-a', created.campaignId);
    expect(campaign.tasks[0].status).toBe('failed_no_effect');
    expect(campaign.tasks[0].error?.code).toBe('CAMPAIGN_NO_EFFECT');
    expect(campaign.status).toBe('failed');
    expect(campaign.checkpoints.some((entry) => entry.kind === 'task_review')).toBe(false);
  });

  test('cancels supervisor trigger Jobs as part of the Campaign cleanup barrier', async () => {
    const controllerHome = temporary('repo-harness-campaign-supervisor-cancel-');
    const created = createCampaign(controllerHome, {
      repoId: 'repo-a', checkoutId: 'checkout-a', requestId: 'cancel-supervisor', semanticKey: 'cancel-supervisor',
      title: 'Cancel supervisor', goal: 'Cancel all children',
      tasks: [{ taskId: 'T1', title: 'Task', operation: 'record_candidate_finding' }],
    }).campaign;
    const supervisorJob = createExecutionJob(controllerHome, {
      repoId: 'repo-a', type: 'reconciliation', requestId: 'supervisor-trigger', semanticKey: 'supervisor-trigger',
      payload: { operation: 'campaign-supervisor' }, origin: { surface: 'system' },
    }).job;
    updateCampaign(controllerHome, 'repo-a', created.campaignId, 'open-supervisor-checkpoint', (campaign) => {
      const opened = openCampaignCheckpoint(campaign, 'failure', 'T1');
      opened.checkpoint.triggerJobId = supervisorJob.jobId;
      return campaign;
    }, { wakeScheduler: false });
    const cancelled = await cancelCampaign(controllerHome, 'repo-a', created.campaignId, 'cancel-supervisor-request', 'test');
    expect(cancelled.status).toBe('cancelled');
    expect(getExecutionJob(controllerHome, 'repo-a', supervisorJob.jobId).status).toBe('cancelled');
    expect(cancelled.cleanup?.resources.some((entry) => entry.kind === 'job' && entry.id === supervisorJob.jobId)).toBe(true);
  });

  test('cancels child Jobs before declaring a Campaign cancelled', async () => {
    const controllerHome = temporary('repo-harness-campaign-cancel-');
    const created = createCampaign(controllerHome, {
      repoId: 'repo-a', checkoutId: 'checkout-a', requestId: 'cancel', semanticKey: 'cancel',
      title: 'Cancel', goal: 'Cancel safely',
      tasks: [{ taskId: 'T1', title: 'Task', operation: 'record_candidate_finding' }],
    }).campaign;
    reconcileCampaign(controllerHome, 'repo-a', created.campaignId);
    const active = getCampaign(controllerHome, 'repo-a', created.campaignId);
    const cancelled = await cancelCampaign(controllerHome, 'repo-a', created.campaignId, 'cancel-request', 'test');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks[0].status).toBe('cancelled');
    expect(cancelled.cleanup?.finishedAt).toBeTruthy();
    expect(cancelled.cleanup?.resources.some((entry) => entry.kind === 'job' && entry.id === active.tasks[0].jobId)).toBe(true);
    expect(cancelled.cleanup?.leaks).toEqual([]);
  });
});
