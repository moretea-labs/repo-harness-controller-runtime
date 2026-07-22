import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_AGENT_TIMEOUT_MS, MIN_AGENT_TIMEOUT_MS } from '../../src/cli/controller/runtime-config';
import {
  executeLocalBridgeJob,
  getLocalBridgeJob,
  reconcileLocalBridgeJobs,
  submitLocalBridgeJob,
} from '../../src/cli/local-bridge/job-store';
import {
  previewRepositoryCommandExecution,
  REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS,
  REPOSITORY_COMMAND_MAX_TIMEOUT_MS,
  REPOSITORY_COMMAND_MIN_TIMEOUT_MS,
} from '../../src/cli/repositories/command-executor';
import { registerRepository } from '../../src/cli/repositories/registry';
import { createExecutionJob, getExecutionJob, updateExecutionJob } from '../../src/runtime/execution/jobs/store';
import { waitForExecutionJob } from '../../src/runtime/execution/jobs/wait';
import { executeExecutionJob } from '../../src/runtime/execution/workers/executor';
import { acquireExecutionLeases, releaseExecutionLeases, renewExecutionLeases } from '../../src/runtime/resources/leases/store';
import { terminateProcessTree } from '../../src/runtime/shared/process-tree';
import { terminateProcessesByCommand, waitForNoProcessesByCommand } from './process-hygiene';

const roots: string[] = [];
const tracked: ChildProcess[] = [];

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

function seedRepo(controllerHome: string, repoRoot: string) {
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Repo Harness Test']);
  git(repoRoot, ['config', 'user.email', 'repo-harness-test@example.com']);
  writeFileSync(join(repoRoot, 'README.md'), 'hello\n');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'init']);
  return registerRepository({ path: repoRoot, controllerHome });
}

function listLocalJobIds(repoRoot: string): string[] {
  const jobsDir = join(repoRoot, '.ai/harness/local-jobs');
  if (!existsSync(jobsDir)) return [];
  return readdirSync(jobsDir).filter((name) => name.startsWith('JOB-'));
}

afterEach(async () => {
  for (const child of tracked.splice(0)) {
    if (child.pid) await terminateProcessTree(child.pid, { gracePeriodMs: 50, killAfterMs: 300, pollIntervalMs: 25 });
  }
  await terminateProcessesByCommand(roots);
  await waitForNoProcessesByCommand(roots);
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('repository command execution lifecycle', () => {
  test('accepts explicit long timeouts up to the shared agent maximum and rejects above it', () => {
    const controllerHome = tempRoot('repo-harness-cmd-timeout-home-');
    const repoRoot = tempRoot('repo-harness-cmd-timeout-repo-');
    const repository = seedRepo(controllerHome, repoRoot);

    expect(REPOSITORY_COMMAND_MAX_TIMEOUT_MS).toBe(MAX_AGENT_TIMEOUT_MS);
    expect(REPOSITORY_COMMAND_MIN_TIMEOUT_MS).toBe(MIN_AGENT_TIMEOUT_MS);
    expect(REPOSITORY_COMMAND_DEFAULT_TIMEOUT_MS).toBe(120_000);

    const longOk = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MAX_AGENT_TIMEOUT_MS,
    });
    expect(longOk.execution.status).toBe('preview');

    const minOk = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MIN_AGENT_TIMEOUT_MS,
    });
    expect(minOk.execution.status).toBe('preview');

    expect(() => previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MAX_AGENT_TIMEOUT_MS + 1,
    })).toThrow(/COMMAND_OPTION_INVALID/);

    expect(() => previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: MIN_AGENT_TIMEOUT_MS - 1,
    })).toThrow(/COMMAND_OPTION_INVALID/);

    expect(() => previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
      timeoutMs: 13 * 60 * 60 * 1000,
    })).toThrow(String(MAX_AGENT_TIMEOUT_MS));

    const withDefault = previewRepositoryCommandExecution(repository, {
      command: "printf 'ready\\n'",
      dryRun: true,
    });
    expect(withDefault.execution.status).toBe('preview');
  });

  test('outer durable Execution Job stays non-terminal while Local Job is queued/running and propagates terminal success', async () => {
    const controllerHome = tempRoot('repo-harness-cmd-prop-home-');
    const repoRoot = tempRoot('repo-harness-cmd-prop-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const marker = join(repoRoot, 'lifecycle-ready.marker');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify([
      "const { writeFileSync } = require('fs');",
      `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'ok'); console.log('lifecycle-ready'); }, 600);`,
    ].join(' '))}`;

    const preview = previewRepositoryCommandExecution(repository, {
      command,
      dryRun: true,
    });
    expect(preview.execution.approvalToken).toBeTruthy();

    const created = createExecutionJob(controllerHome, {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      type: 'repository-command',
      requestId: 'lifecycle-queued-running-propagation',
      semanticKey: 'repository-command:lifecycle-propagation',
      origin: { surface: 'mcp', actor: 'repository_command_execute' },
      payload: {
        operation: 'repository_command_execute',
        target: 'repository-tool',
        arguments: {
          repo_id: repository.repoId,
          checkout_id: repository.activeCheckoutId,
          command,
          approval_token: preview.execution.approvalToken,
          timeout_ms: 30_000,
          request_id: 'lifecycle-queued-running-propagation',
        },
        timeoutMs: 30_000,
      },
      timeoutMs: 30_000,
      resourceClaims: [
        { resourceKey: `workspace:${repository.activeCheckoutId}`, mode: 'write' },
        { resourceKey: `git-refs:${repository.repoId}`, mode: 'exclusive' },
      ],
    }).job;

    let settled = false;
    const executionPromise = executeExecutionJob(controllerHome, created).then((value) => {
      settled = true;
      return value;
    });

    let sawActiveChild = false;
    for (let attempt = 0; attempt < 120 && !sawActiveChild; attempt += 1) {
      await Bun.sleep(25);
      for (const jobId of listLocalJobIds(repoRoot)) {
        const child = getLocalBridgeJob(repoRoot, jobId);
        if (['approved', 'dispatched', 'running'].includes(child.status)) {
          sawActiveChild = true;
          expect(settled).toBe(false);
        }
      }
    }
    expect(sawActiveChild).toBe(true);
    expect(settled).toBe(false);

    const execution = await executionPromise;
    expect(execution.ok).toBe(true);
    expect(execution.result?.status).toBe('succeeded');
    const nested = execution.result?.localJob as { status?: string; jobId?: string } | undefined;
    expect(nested?.status).toBe('succeeded');
    expect(typeof nested?.jobId).toBe('string');
    const terminalLocal = getLocalBridgeJob(repoRoot, String(nested?.jobId));
    expect(terminalLocal.status).toBe('succeeded');
    expect(readFileSync(marker, 'utf-8')).toBe('ok');

    // executeExecutionJob returns the worker result; Job store transition is owned by worker-entry.
    const stillQueued = getExecutionJob(controllerHome, repository.repoId, created.jobId);
    expect(stillQueued.status).toBe('queued');
  });

  test('does not hold the repository lock while a command runs so the outer lease can renew', async () => {
    const controllerHome = tempRoot('repo-harness-cmd-renew-home-');
    const repoRoot = tempRoot('repo-harness-cmd-renew-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const command = "sleep 1 && printf 'renew-ok\\n'";
    const preview = previewRepositoryCommandExecution(repository, {
      command,
      dryRun: true,
      timeoutMs: 10_000,
    });
    const acquired = acquireExecutionLeases(
      controllerHome,
      repository.repoId,
      'EJOB-renew-owner',
      [{ resourceKey: `workspace:${repository.activeCheckoutId}`, mode: 'write' }],
      30_000,
    );
    expect(acquired.acquired).toBe(true);

    const submitted = submitLocalBridgeJob(repoRoot, {
      action: 'repository-command',
      requestedBy: 'test',
      payload: {
        controllerHome,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        command,
        approvalToken: preview.execution.approvalToken,
        timeoutMs: 10_000,
      },
    });
    executeLocalBridgeJob(repoRoot, submitted.jobId);

    let active = getLocalBridgeJob(repoRoot, submitted.jobId);
    for (let attempt = 0; attempt < 100 && !active.workerPid; attempt += 1) {
      await Bun.sleep(10);
      active = getLocalBridgeJob(repoRoot, submitted.jobId);
    }
    expect(active.status).toBe('running');
    expect(active.workerPid).toBeTruthy();

    const renewed = renewExecutionLeases(
      controllerHome,
      repository.repoId,
      'EJOB-renew-owner',
      30_000,
      acquired.leases.map((lease) => ({ leaseId: lease.leaseId, fencingToken: lease.fencingToken })),
    );
    expect(renewed).toHaveLength(1);
    expect(Date.parse(renewed[0]!.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(acquired.leases[0]!.heartbeatAt));

    let terminal = active;
    for (let attempt = 0; attempt < 200 && !['succeeded', 'failed', 'timed_out'].includes(terminal.status); attempt += 1) {
      await Bun.sleep(10);
      terminal = getLocalBridgeJob(repoRoot, submitted.jobId);
    }
    expect(terminal.status).toBe('succeeded');
    releaseExecutionLeases(
      controllerHome,
      repository.repoId,
      'EJOB-renew-owner',
      renewed.map((lease) => ({ leaseId: lease.leaseId, fencingToken: lease.fencingToken })),
    );
  });

  test('propagates terminal Local Job failure to the durable Execution Job result', async () => {
    const controllerHome = tempRoot('repo-harness-cmd-fail-home-');
    const repoRoot = tempRoot('repo-harness-cmd-fail-repo-');
    const repository = seedRepo(controllerHome, repoRoot);
    const command = "python - <<'PY'\nimport sys\nprint('fail-path')\nsys.exit(7)\nPY";

    const preview = previewRepositoryCommandExecution(repository, {
      command,
      dryRun: true,
    });
    const created = createExecutionJob(controllerHome, {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      type: 'repository-command',
      requestId: 'lifecycle-terminal-failure',
      semanticKey: 'repository-command:lifecycle-failure',
      origin: { surface: 'mcp', actor: 'repository_command_execute' },
      payload: {
        operation: 'repository_command_execute',
        target: 'repository-tool',
        arguments: {
          repo_id: repository.repoId,
          checkout_id: repository.activeCheckoutId,
          command,
          approval_token: preview.execution.approvalToken,
          timeout_ms: 20_000,
          request_id: 'lifecycle-terminal-failure',
        },
        timeoutMs: 20_000,
      },
      timeoutMs: 20_000,
    }).job;

    const execution = await executeExecutionJob(controllerHome, created);
    expect(execution.ok).toBe(false);
    expect(execution.error?.code).toBe('LEGACY_JOB_FAILED');
    const nested = execution.error?.details?.localJob as { status?: string; jobId?: string } | undefined;
    expect(nested?.status).toBe('failed');
    if (nested?.jobId) {
      expect(getLocalBridgeJob(repoRoot, nested.jobId).status).toBe('failed');
    }
  });

  test('controller restart reattaches a still-live detached child instead of orphaning it', async () => {
    const controllerHome = tempRoot('repo-harness-cmd-reattach-home-');
    const repoRoot = tempRoot('repo-harness-cmd-reattach-repo-');
    const repository = seedRepo(controllerHome, repoRoot);

    const submitted = submitLocalBridgeJob(repoRoot, {
      action: 'repository-command',
      requestedBy: 'test',
      payload: {
        controllerHome,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        command: "printf 'reattach\\n'",
        approvalToken: 'unused-for-fixture',
        timeoutMs: 60_000,
      },
    });

    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    worker.unref();
    tracked.push(worker);
    if (!worker.pid) throw new Error('worker pid missing');

    const jobPath = join(repoRoot, '.ai/harness/local-jobs', submitted.jobId, 'job.json');
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    const fixture = JSON.parse(readFileSync(jobPath, 'utf-8'));
    fixture.status = 'running';
    fixture.startedAt = new Date().toISOString();
    fixture.updatedAt = fixture.startedAt;
    fixture.ownerPid = 999_999_001;
    fixture.workerPid = worker.pid;
    fixture.deadlineAt = new Date(Date.now() + 60_000).toISOString();
    fixture.heartbeatAt = staleHeartbeat;
    writeFileSync(jobPath, `${JSON.stringify(fixture, null, 2)}\n`);

    const reattached = getLocalBridgeJob(repoRoot, submitted.jobId);
    expect(reattached.status).toBe('running');
    expect(reattached.ownerPid).toBe(process.pid);
    expect(reattached.workerPid).toBe(worker.pid);
    expect(reattached.finishedAt).toBeUndefined();
    expect(reattached.heartbeatAt).toBeTruthy();
    expect(Date.parse(String(reattached.heartbeatAt))).toBeGreaterThan(Date.parse(staleHeartbeat));

    const reconciled = reconcileLocalBridgeJobs(repoRoot);
    expect(reconciled.terminalized).toBe(0);
    expect(getLocalBridgeJob(repoRoot, submitted.jobId).status).toBe('running');

    // When both owner and detached worker are gone, orphan remains the correct recovery.
    const pathAfter = JSON.parse(readFileSync(jobPath, 'utf-8'));
    pathAfter.ownerPid = 999_999_002;
    pathAfter.workerPid = 999_999_003;
    pathAfter.status = 'running';
    delete pathAfter.finishedAt;
    writeFileSync(jobPath, `${JSON.stringify(pathAfter, null, 2)}\n`);

    const orphaned = getLocalBridgeJob(repoRoot, submitted.jobId);
    expect(orphaned.status).toBe('orphaned');
    expect(orphaned.finishedAt).toBeTruthy();
  });

  test('persisted deadline terminalizes a running repository-command Local Job', () => {
    const controllerHome = tempRoot('repo-harness-cmd-deadline-home-');
    const repoRoot = tempRoot('repo-harness-cmd-deadline-repo-');
    const repository = seedRepo(controllerHome, repoRoot);

    const submitted = submitLocalBridgeJob(repoRoot, {
      action: 'repository-command',
      requestedBy: 'test',
      payload: {
        controllerHome,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        command: "printf 'deadline\\n'",
        approvalToken: 'unused-for-fixture',
        timeoutMs: 60_000,
      },
    });

    const jobPath = join(repoRoot, '.ai/harness/local-jobs', submitted.jobId, 'job.json');
    const fixture = JSON.parse(readFileSync(jobPath, 'utf-8'));
    fixture.status = 'running';
    fixture.startedAt = new Date(Date.now() - 10_000).toISOString();
    fixture.updatedAt = fixture.startedAt;
    fixture.ownerPid = process.pid;
    fixture.workerPid = 999_999_777;
    fixture.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    fixture.heartbeatAt = new Date().toISOString();
    writeFileSync(jobPath, `${JSON.stringify(fixture, null, 2)}\n`);

    const timedOut = getLocalBridgeJob(repoRoot, submitted.jobId);
    expect(timedOut.status).toBe('timed_out');
    expect(timedOut.finishedAt).toBeTruthy();
    expect(String(timedOut.error ?? '')).toMatch(/deadline/i);
  });

  test('wait=true style polling times out while durable Job is still non-terminal', async () => {
    const controllerHome = tempRoot('repo-harness-cmd-wait-home-');
    const repoRoot = tempRoot('repo-harness-cmd-wait-repo-');
    const repository = seedRepo(controllerHome, repoRoot);

    const created = createExecutionJob(controllerHome, {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      type: 'repository-command',
      requestId: 'lifecycle-wait-semantics',
      semanticKey: 'repository-command:lifecycle-wait',
      origin: { surface: 'mcp', actor: 'repository_command_execute' },
      payload: {
        operation: 'repository_command_execute',
        target: 'repository-tool',
        arguments: { repo_id: repository.repoId, command: "printf 'queued\\n'" },
      },
      timeoutMs: 30_000,
    }).job;

    const waited = await waitForExecutionJob({
      controllerHome,
      repoId: repository.repoId,
      jobId: created.jobId,
      timeoutMs: 250,
      pollIntervalMs: 50,
    });
    expect(waited.timedOut).toBe(true);
    expect(waited.job.status).toBe('queued');
    expect(waited.waitedMs).toBeGreaterThanOrEqual(200);

    // Once the Job is terminal, wait returns immediately without a timeout.
    updateExecutionJob(controllerHome, repository.repoId, created.jobId, (job) => ({
      ...job,
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    }));
    const terminal = await waitForExecutionJob({
      controllerHome,
      repoId: repository.repoId,
      jobId: created.jobId,
      timeoutMs: 2_000,
      pollIntervalMs: 50,
    });
    expect(terminal.timedOut).toBe(false);
    expect(terminal.job.status).toBe('succeeded');
  });

  test('settlement reports LEGACY_JOB_TIMEOUT when Local Job remains active past budget', async () => {
    const controllerHome = tempRoot('repo-harness-cmd-settle-timeout-home-');
    const repoRoot = tempRoot('repo-harness-cmd-settle-timeout-repo-');
    const repository = seedRepo(controllerHome, repoRoot);

    const submitted = submitLocalBridgeJob(repoRoot, {
      action: 'repository-command',
      requestedBy: 'test',
      payload: {
        controllerHome,
        repoId: repository.repoId,
        checkoutId: repository.activeCheckoutId,
        command: "printf 'stuck\\n'",
        approvalToken: 'unused-for-fixture',
        timeoutMs: 60_000,
      },
    });
    const jobPath = join(repoRoot, '.ai/harness/local-jobs', submitted.jobId, 'job.json');
    const fixture = JSON.parse(readFileSync(jobPath, 'utf-8'));
    fixture.status = 'running';
    fixture.startedAt = new Date().toISOString();
    fixture.updatedAt = fixture.startedAt;
    fixture.ownerPid = process.pid;
    fixture.deadlineAt = new Date(Date.now() + 60_000).toISOString();
    fixture.heartbeatAt = new Date().toISOString();
    writeFileSync(jobPath, `${JSON.stringify(fixture, null, 2)}\n`);

    const created = createExecutionJob(controllerHome, {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      type: 'repository-command',
      requestId: 'lifecycle-settlement-timeout',
      semanticKey: 'repository-command:lifecycle-settlement-timeout',
      origin: { surface: 'mcp', actor: 'repository_command_execute' },
      payload: {
        operation: 'legacy-local-job',
        target: 'runtime',
        arguments: { localJobId: submitted.jobId },
        timeoutMs: 1_000,
      },
      timeoutMs: 1_000,
    }).job;

    const execution = await executeExecutionJob(controllerHome, created);
    expect(execution.ok).toBe(false);
    expect(execution.error?.code).toBe('LEGACY_JOB_TIMEOUT');
    expect(String(execution.error?.message ?? '')).toContain(submitted.jobId);
    // Settlement budget expired without terminalizing the still-active Local Job.
    const local = getLocalBridgeJob(repoRoot, submitted.jobId);
    expect(local.status).toBe('running');
  });
});
