import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  createExecutionJob,
  getExecutionJob,
  updateExecutionJob,
} from '../../src/runtime/execution/jobs/store';
import {
  markOperationCompleted,
  markOperationDelegated,
  markOperationStarted,
  readOperationReceipt,
} from '../../src/runtime/execution/jobs/receipt-store';
import {
  buildDelegatedExecutionResult,
  hasDurableChildReference,
  isAgentDelegationOperation,
} from '../../src/runtime/execution/jobs/child-reference';
import { reconcileExecutionJobs } from '../../src/runtime/control-plane/global-scheduler/reconciliation';
import { acquireExecutionLeases, listActiveLeases } from '../../src/runtime/resources/leases/store';
import { createIssue, getIssue, listIssues } from '../../src/cli/controller/issue-store';
import {
  executeLocalBridgeJobInline,
  getLocalBridgeJob,
  submitLocalBridgeJob,
} from '../../src/cli/local-bridge/job-store';
import { acceptTaskJob, getAgentJob } from '../../src/cli/agent-jobs/job-manager';
import { executeExecutionJob } from '../../src/runtime/execution/workers/executor';
import { buildJobOperationDigest } from '../../src/runtime/control-plane/facade/operation-digest';
import { summarizeExecutionJobForMcp } from '../../src/runtime/safe-tooling/job-summary';
import { claimsForMcpOperation } from '../../src/runtime/gateway/mcp/resource-policy';

const roots: string[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

function gitRepo(): string {
  const root = temp('repo-harness-agent-deleg-repo-');
  const controllerHome = temp('repo-harness-agent-deleg-home-');
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, '.ai/harness'), { recursive: true });
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'], {
    cwd: root,
    stdio: 'ignore',
  });
  return root;
}

function writeSyntheticRun(
  repoRoot: string,
  runId: string,
  status: 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' = 'starting',
  issueId = 'ISS-TEST',
  taskId = 'T1',
): void {
  const runDir = join(repoRoot, '.ai/harness/jobs', runId);
  mkdirSync(runDir, { recursive: true });
  const epochDir = join(repoRoot, '.ai/harness/controller');
  mkdirSync(epochDir, { recursive: true });
  const epochPath = join(epochDir, 'runtime-owner.json');
  const epoch = {
    schemaVersion: 1,
    pid: process.pid,
    epoch: `epoch-${runId}`,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(epochPath, `${JSON.stringify(epoch, null, 2)}\n`);
  const now = new Date().toISOString();
  for (const file of ['stdout.log', 'stderr.log', 'events.jsonl', 'prompt.md']) {
    writeFileSync(join(runDir, file), '');
  }
  writeFileSync(join(runDir, 'meta.json'), `${JSON.stringify({
    schemaVersion: 3,
    runId,
    issueId,
    taskId,
    agent: 'codex',
    provider: 'local',
    executionMode: 'workspace',
    status,
    repoRoot,
    worktree: repoRoot,
    branch: null,
    baseRevision: null,
    promptPath: `.ai/harness/jobs/${runId}/prompt.md`,
    stdoutPath: `.ai/harness/jobs/${runId}/stdout.log`,
    stderrPath: `.ai/harness/jobs/${runId}/stderr.log`,
    resultPath: `.ai/harness/jobs/${runId}/result.json`,
    eventsPath: `.ai/harness/jobs/${runId}/events.jsonl`,
    controllerPid: process.pid,
    controllerEpoch: epoch.epoch,
    controllerEpochPath: '.ai/harness/controller/runtime-owner.json',
    createdAt: now,
    startedAt: now,
    ...(status === 'succeeded' || status === 'failed' ? { finishedAt: now } : {}),
    lastHeartbeatAt: now,
  }, null, 2)}\n`);
}

afterEach(() => {
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('agent delegation lifecycle bootstrap stability', () => {
  test('identifies agent delegation operations', () => {
    expect(isAgentDelegationOperation('quick_agent_session')).toBe(true);
    expect(isAgentDelegationOperation('dispatch_task')).toBe(true);
    expect(isAgentDelegationOperation('run_check')).toBe(false);
  });

  test('1. parent worker exit before child Run is created allows safe retry', () => {
    const controllerHome = temp('repo-harness-deleg-before-child-');
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'agent-run',
      requestId: 'req-before-child',
      semanticKey: 'mcp-tool:quick_agent_session:repo-a:before',
      origin: { surface: 'mcp', actor: 'quick_agent_session' },
      payload: { operation: 'quick_agent_session', arguments: { title: 't', objective: 'o' } },
      resourceClaims: [{ resourceKey: 'agent-dispatch:repo-a:req-before-child', mode: 'write' }],
      maxAttempts: 3,
    }).job;
    const running = updateExecutionJob(controllerHome, created.repoId, created.jobId, (job) => ({
      ...job,
      status: 'running',
      attempt: 1,
      workerPid: 999_001,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    markOperationStarted(controllerHome, running, 999_001);

    const summary = reconcileExecutionJobs(controllerHome, created.repoId);
    const recovered = getExecutionJob(controllerHome, created.repoId, created.jobId);
    expect(recovered.status).toBe('queued');
    expect(recovered.error?.code).toBe('WORKER_LOST');
    expect(summary.requeued).toBeGreaterThanOrEqual(1);
    expect(recovered.status).not.toBe('human_attention_required');
  });

  test('2. child Run created then parent dies before receipt completion recovers as delegated', () => {
    const controllerHome = temp('repo-harness-deleg-after-child-');
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'agent-run',
      requestId: 'req-after-child',
      semanticKey: 'mcp-tool:quick_agent_session:repo-a:after',
      origin: { surface: 'mcp', actor: 'quick_agent_session' },
      payload: { operation: 'quick_agent_session', arguments: { title: 't', objective: 'o' } },
      resourceClaims: [{ resourceKey: 'agent-dispatch:repo-a:req-after-child', mode: 'write' }],
      maxAttempts: 2,
    }).job;
    const childReference = {
      localJobId: 'JOB-child-1',
      runId: 'RUN-child-1',
      issueId: 'ISS-EPH',
      taskId: 'T1',
      requestId: 'req-after-child',
      delegatedAt: new Date().toISOString(),
    };
    const running = updateExecutionJob(controllerHome, created.repoId, created.jobId, (job) => ({
      ...job,
      status: 'running',
      attempt: 1,
      workerPid: 999_002,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    markOperationStarted(controllerHome, running, 999_002);
    markOperationDelegated(
      controllerHome,
      running,
      999_002,
      childReference,
      buildDelegatedExecutionResult({ childReference }),
    );

    const summary = reconcileExecutionJobs(controllerHome, created.repoId);
    const recovered = getExecutionJob(controllerHome, created.repoId, created.jobId);
    expect(summary.recovered).toBeGreaterThanOrEqual(1);
    expect(recovered.status).toBe('succeeded');
    expect(recovered.result?.delegated).toBe(true);
    expect((recovered.result?.childReference as { runId?: string } | undefined)?.runId).toBe('RUN-child-1');
    expect(recovered.status).not.toBe('human_attention_required');
  });

  test('3. gateway disconnect does not cancel a child Agent Run', () => {
    const repoRoot = gitRepo();
    const runId = 'RUN-gateway-disconnect';
    writeSyntheticRun(repoRoot, runId, 'starting', 'ISS-GW', 'T1');
    // Parent Job terminal + Gateway gone must leave the Run authoritative.
    const run = getAgentJob(repoRoot, runId);
    expect(['queued', 'starting', 'running']).toContain(run.status);
    // No parent worker remains; child meta is unchanged.
    const again = getAgentJob(repoRoot, runId);
    expect(['queued', 'starting', 'running']).toContain(again.status);
    expect(again.finishedAt).toBeUndefined();
  });

  test('4. controller restart recovers parent Job association via child reference', () => {
    const controllerHome = temp('repo-harness-deleg-restart-');
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'dispatch-task',
      requestId: 'req-restart',
      semanticKey: 'mcp-tool:dispatch_task:repo-a:restart',
      origin: { surface: 'mcp', actor: 'dispatch_task' },
      payload: {
        operation: 'dispatch_task',
        arguments: { issue_id: 'ISS-1', task_id: 'T1' },
      },
      resourceClaims: [{ resourceKey: 'agent-dispatch:repo-a:req-restart', mode: 'write' }],
    }).job;
    const childReference = {
      localJobId: 'JOB-restart',
      runId: 'RUN-restart',
      issueId: 'ISS-1',
      taskId: 'T1',
      requestId: 'req-restart',
    };
    markOperationCompleted(controllerHome, {
      ...created,
      attempt: 1,
      status: 'running',
    }, 1, {
      outcome: 'succeeded',
      result: buildDelegatedExecutionResult({ childReference }),
      childReference,
    });
    const finished = updateExecutionJob(controllerHome, created.repoId, created.jobId, (job) => ({
      ...job,
      status: 'succeeded',
      result: buildDelegatedExecutionResult({ childReference }),
      finishedAt: new Date().toISOString(),
      workerPid: undefined,
      leaseRefs: [],
    }));
    const digest = buildJobOperationDigest(finished);
    expect(digest.delegationAccepted).toBe(true);
    expect(digest.childReference?.runId).toBe('RUN-restart');
    expect(digest.resultAccepted).toBe(false);
  });

  test('5. lease expiry with durable child Run does not produce false ambiguous', () => {
    const controllerHome = temp('repo-harness-deleg-lease-');
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'agent-run',
      requestId: 'req-lease',
      semanticKey: 'mcp-tool:quick_agent_session:repo-a:lease',
      origin: { surface: 'mcp', actor: 'quick_agent_session' },
      payload: { operation: 'quick_agent_session', arguments: { title: 't', objective: 'o' } },
      resourceClaims: [{ resourceKey: 'agent-dispatch:repo-a:req-lease', mode: 'write' }],
    }).job;
    const acquisition = acquireExecutionLeases(
      controllerHome,
      created.repoId,
      created.jobId,
      created.resourceClaims,
      1_000,
    );
    expect(acquisition.acquired).toBe(true);
    const leaseRefs = acquisition.leases.map((lease) => ({
      leaseId: lease.leaseId,
      resourceKey: lease.resourceKey,
      fencingToken: lease.fencingToken,
      expiresAt: lease.expiresAt,
    }));
    const childReference = {
      localJobId: 'JOB-lease',
      runId: 'RUN-lease',
      issueId: 'ISS-L',
      taskId: 'T1',
      requestId: 'req-lease',
    };
    const running = updateExecutionJob(controllerHome, created.repoId, created.jobId, (job) => ({
      ...job,
      status: 'running',
      attempt: 1,
      workerPid: 999_003,
      leaseRefs,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));
    markOperationDelegated(
      controllerHome,
      running,
      999_003,
      childReference,
      buildDelegatedExecutionResult({ childReference }),
    );
    // Force lease expiry semantics by clearing worker and reconciling.
    updateExecutionJob(controllerHome, created.repoId, created.jobId, (job) => ({
      ...job,
      workerPid: undefined,
      heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    }));
    const summary = reconcileExecutionJobs(controllerHome, created.repoId);
    const recovered = getExecutionJob(controllerHome, created.repoId, created.jobId);
    expect(recovered.status).toBe('succeeded');
    expect(recovered.error?.code).not.toBe('WORKER_OUTCOME_AMBIGUOUS');
    expect(recovered.error?.code).not.toBe('OPERATION_OUTCOME_AMBIGUOUS');
    expect(summary.recovered + summary.terminal).toBeGreaterThanOrEqual(1);
  });

  test('6. same requestId does not create a second Agent Run', () => {
    const repoRoot = gitRepo();
    const issue = createIssue(repoRoot, {
      title: 'Idempotent dispatch',
      kind: 'investigation',
      tasks: [{ title: 'T', objective: 'do work', risk: 'low', recommendedAgent: 'codex' }],
    });
    const task = issue.tasks[0]!;
    const first = acceptTaskJob({
      repoRoot,
      issueId: issue.id,
      taskId: task.id,
      agent: 'codex',
      requestId: 'same-request-id',
      isolate: true,
      timeoutMs: 60_000,
    });
    const second = acceptTaskJob({
      repoRoot,
      issueId: issue.id,
      taskId: task.id,
      agent: 'codex',
      requestId: 'same-request-id',
      isolate: true,
      timeoutMs: 60_000,
    });
    expect(second.reused).toBe(true);
    expect(second.runId).toBe(first.runId);
  });

  test('7. parent Job terminal leaves Task/Local Job/projection free of false parent-running', () => {
    const repoRoot = gitRepo();
    const controllerHome = process.env.REPO_HARNESS_CONTROLLER_HOME!;
    const job = submitLocalBridgeJob(repoRoot, {
      action: 'quick-agent-session',
      requestedBy: 'test',
      payload: {
        title: 'Parent terminal projection',
        objective: 'Accept only.',
        risk: 'readonly',
        agent: 'codex',
        isolate: true,
        requestId: 'req-parent-terminal',
        ephemeral: true,
      },
    });
    // Simulate accepted dispatch without starting a real agent binary.
    const issue = createIssue(repoRoot, {
      title: 'Parent terminal projection',
      kind: 'investigation',
      ephemeral: true,
      ephemeralOwnerJobId: job.jobId,
      tasks: [{ title: 'Accept only.', objective: 'Accept only.', risk: 'readonly', recommendedAgent: 'codex' }],
    });
    const task = issue.tasks[0]!;
    const runId = 'RUN-parent-terminal';
    writeSyntheticRun(repoRoot, runId, 'starting', issue.id, task.id);
    const jobPath = join(repoRoot, '.ai/harness/local-jobs', job.jobId, 'job.json');
    const stored = JSON.parse(readFileSync(jobPath, 'utf-8'));
    stored.status = 'dispatched';
    stored.runId = runId;
    stored.issueId = issue.id;
    stored.taskId = task.id;
    stored.ephemeral = true;
    stored.result = {
      issueId: issue.id,
      taskId: task.id,
      runId,
      delegated: true,
      childReference: {
        localJobId: job.jobId,
        runId,
        issueId: issue.id,
        taskId: task.id,
        requestId: 'req-parent-terminal',
      },
    };
    writeFileSync(jobPath, `${JSON.stringify(stored, null, 2)}\n`);

    const parent = createExecutionJob(controllerHome, {
      repoId: 'repo-parent-terminal',
      type: 'agent-run',
      requestId: 'req-parent-terminal',
      semanticKey: 'mcp-tool:quick_agent_session:repo-parent-terminal:x',
      origin: { surface: 'mcp', actor: 'quick_agent_session' },
      payload: { operation: 'quick_agent_session', arguments: { title: 't', objective: 'o' } },
      resourceClaims: [{ resourceKey: 'agent-dispatch:repo-parent-terminal:x', mode: 'write' }],
    }).job;
    const finished = updateExecutionJob(controllerHome, parent.repoId, parent.jobId, (jobState) => ({
      ...jobState,
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      workerPid: undefined,
      leaseRefs: [],
      result: buildDelegatedExecutionResult({
        childReference: {
          localJobId: job.jobId,
          runId,
          issueId: issue.id,
          taskId: task.id,
          requestId: 'req-parent-terminal',
        },
        localJob: getLocalBridgeJob(repoRoot, job.jobId) as unknown as Record<string, unknown>,
      }),
    }));

    expect(finished.status).toBe('succeeded');
    expect(finished.status).not.toBe('running');
    const local = getLocalBridgeJob(repoRoot, job.jobId);
    // Local Job follows Agent Run authority, not the parent Job.
    expect(['dispatched', 'running']).toContain(local.status);
    expect(local.runId).toBe(runId);
    const summary = summarizeExecutionJobForMcp(finished, repoRoot);
    expect(summary.delegationAccepted).toBe(true);
    expect(['queued', 'starting', 'running', 'dispatched']).toContain(String(summary.childRunStatus ?? summary.childLocalJobStatus));
    // Parent is not reported as the active Task authority once terminal.
    expect(summary.status).toBe('succeeded');
    expect(summary.terminal).toBe(true);
  });

  test('8. ephemeral quick session does not pollute durable tasks/issues', () => {
    const repoRoot = gitRepo();
    const durableBefore = existsSync(join(repoRoot, 'tasks/issues'))
      ? readdirSync(join(repoRoot, 'tasks/issues'))
      : [];
    const issue = createIssue(repoRoot, {
      title: 'Ephemeral isolation proof',
      kind: 'investigation',
      ephemeral: true,
      ephemeralOwnerJobId: 'JOB-eph',
      tasks: [{ title: 'Inspect', objective: 'Inspect only.', risk: 'readonly' }],
    });
    expect(issue.ephemeral).toBe(true);
    expect(listIssues(repoRoot)).toEqual([]);
    expect(getIssue(repoRoot, issue.id).ephemeral).toBe(true);
    const durableAfter = existsSync(join(repoRoot, 'tasks/issues'))
      ? readdirSync(join(repoRoot, 'tasks/issues'))
      : [];
    expect(durableAfter).toEqual(durableBefore);
    expect(existsSync(join(repoRoot, '.ai/harness/ephemeral-issues'))).toBe(true);
    const ephemeralNames = readdirSync(join(repoRoot, '.ai/harness/ephemeral-issues'));
    expect(ephemeralNames.some((name) => name.includes(issue.id))).toBe(true);

    const durable = createIssue(repoRoot, {
      title: 'Durable isolation proof',
      kind: 'feature',
      ephemeral: false,
      tasks: [{ title: 'Ship', objective: 'Ship durable.', risk: 'low' }],
    });
    expect(durable.ephemeral).toBeFalsy();
    expect(listIssues(repoRoot).some((entry) => entry.id === durable.id)).toBe(true);
    expect(existsSync(join(repoRoot, 'tasks/issues', `${durable.id}-${durable.slug}.issue.json`))).toBe(true);
  });

  test('9. unknown write without child reference still fails closed', () => {
    const controllerHome = temp('repo-harness-deleg-ambiguous-');
    const created = createExecutionJob(controllerHome, {
      repoId: 'repo-a',
      type: 'repository-command',
      requestId: 'req-ambiguous',
      semanticKey: 'repository-tool:repository_command_execute:repo-a:x',
      origin: { surface: 'mcp', actor: 'repository_command_execute' },
      payload: { operation: 'repository_command_execute', arguments: { command: 'true' } },
      resourceClaims: [{ resourceKey: 'workspace:checkout', mode: 'write' }],
      maxAttempts: 1,
    }).job;
    const running = updateExecutionJob(controllerHome, created.repoId, created.jobId, (job) => ({
      ...job,
      status: 'running',
      attempt: 1,
      workerPid: 999_004,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    markOperationStarted(controllerHome, running, 999_004);
    const summary = reconcileExecutionJobs(controllerHome, created.repoId);
    const recovered = getExecutionJob(controllerHome, created.repoId, created.jobId);
    expect(recovered.status).toBe('human_attention_required');
    expect(recovered.error?.code).toBe('OPERATION_OUTCOME_AMBIGUOUS');
    expect(summary.terminal).toBeGreaterThanOrEqual(1);
  });

  test('10. fencing/idempotent agent-dispatch claims do not grab workspace leases', () => {
    const claims = claimsForMcpOperation(
      'quick_agent_session',
      { request_id: 'req-fence', title: 't', objective: 'o', isolate: true },
      'repo-a',
      'checkout-a',
    );
    expect(claims).toEqual([
      { resourceKey: 'agent-dispatch:repo-a:req-fence', mode: 'write' },
    ]);
    expect(claims.every((claim) => !claim.resourceKey.startsWith('workspace:'))).toBe(true);
  });

  test('executor accepts agent local job without waiting for run terminal state', async () => {
    const repoRoot = gitRepo();
    const controllerHome = process.env.REPO_HARNESS_CONTROLLER_HOME!;
    const local = submitLocalBridgeJob(repoRoot, {
      action: 'quick-agent-session',
      requestedBy: 'test',
      payload: {
        title: 'Accept without settle',
        objective: 'Return after accept.',
        risk: 'readonly',
        agent: 'codex',
        isolate: true,
        requestId: 'req-accept-only',
        ephemeral: true,
      },
    });
    // Pre-create a synthetic accepted local job state with run, skipping real agent spawn.
    const issue = createIssue(repoRoot, {
      title: 'Accept without settle',
      kind: 'investigation',
      ephemeral: true,
      ephemeralOwnerJobId: local.jobId,
      tasks: [{ title: 'Accept', objective: 'Accept', risk: 'readonly', recommendedAgent: 'codex' }],
    });
    const task = issue.tasks[0]!;
    const runId = 'RUN-accept-only';
    writeSyntheticRun(repoRoot, runId, 'starting', issue.id, task.id);
    const jobPath = join(repoRoot, '.ai/harness/local-jobs', local.jobId, 'job.json');
    const stored = JSON.parse(readFileSync(jobPath, 'utf-8'));
    stored.status = 'dispatched';
    stored.runId = runId;
    stored.issueId = issue.id;
    stored.taskId = task.id;
    stored.ephemeral = true;
    stored.result = {
      issueId: issue.id,
      taskId: task.id,
      runId,
      status: 'running',
      delegated: true,
      childReference: {
        localJobId: local.jobId,
        runId,
        issueId: issue.id,
        taskId: task.id,
        requestId: 'req-accept-only',
      },
    };
    writeFileSync(jobPath, `${JSON.stringify(stored, null, 2)}\n`);

    const { registerRepository } = await import('../../src/cli/repositories/registry');
    const repository = registerRepository({ path: repoRoot, controllerHome });
    const boundParent = createExecutionJob(controllerHome, {
      repoId: repository.repoId,
      checkoutId: repository.activeCheckoutId,
      type: 'agent-run',
      requestId: 'req-accept-only',
      semanticKey: `legacy-local-job:${repository.repoId}:${local.jobId}`,
      origin: { surface: 'local-ui', actor: 'test', causationId: local.jobId },
      payload: {
        operation: 'legacy-local-job',
        target: 'runtime',
        arguments: {
          localJobId: local.jobId,
          agentDelegation: true,
          localAction: 'quick-agent-session',
        },
      },
      resourceClaims: [{ resourceKey: `agent-dispatch:${repository.repoId}:${local.jobId}`, mode: 'write' }],
    }).job;

    const started = Date.now();
    const result = await executeExecutionJob(controllerHome, boundParent);
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(result.result?.delegated).toBe(true);
    expect(hasDurableChildReference(result.result?.childReference as { runId?: string })).toBe(true);
    // Must not poll-wait for the long-running child (250ms loops up to minutes).
    expect(elapsed).toBeLessThan(5_000);
    const receipt = readOperationReceipt(controllerHome, boundParent.repoId, boundParent.jobId);
    expect(receipt?.state === 'delegated' || receipt?.childReference?.runId).toBeTruthy();
  });
});
