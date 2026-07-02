import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../src/runtime/control-plane/daemon-client';
import { createExecutionJob, getExecutionJob, listExecutionJobs } from '../src/runtime/execution/jobs/store';
import { listActiveLeases } from '../src/runtime/resources/leases/store';
import { readRepositoryProjection } from '../src/runtime/projections/materialized-view';
import { registerRepository } from '../src/cli/repositories/registry';
import { createMcpToolContext } from '../src/cli/mcp/server';
import { callRuntimeTool } from '../src/runtime/gateway/mcp/runtime-tools';

const root = mkdtempSync(join(tmpdir(), 'repo-harness-runtime-smoke-'));
const repoRoot = join(root, 'repo');
const controllerHome = join(root, 'controller');
let daemonPid: number | undefined;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore' });
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

try {
  execFileSync('mkdir', ['-p', repoRoot]);
  git('init');
  git('config', 'user.email', 'runtime-smoke@example.invalid');
  git('config', 'user.name', 'Runtime Smoke');
  writeFileSync(join(repoRoot, 'README.md'), '# runtime smoke\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'initial');
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'runtime-smoke' });
  const created = createExecutionJob(controllerHome, {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    type: 'mcp-tool',
    requestId: 'runtime-smoke:controller-context',
    semanticKey: `runtime-smoke:${repository.repoId}:controller-context`,
    origin: { surface: 'system', actor: 'runtime-smoke' },
    payload: { operation: 'controller_context', target: 'mcp-tool', profile: 'controller', maxOutputBytes: 128 * 1024 },
    resourceClaims: [],
    timeoutMs: 30_000,
    maxAttempts: 2,
  });

  const first = ensureControllerDaemon(controllerHome);
  const second = ensureControllerDaemon(controllerHome);
  daemonPid = first.pid;
  if (!first.pid || first.pid !== second.pid) throw new Error(`DAEMON_DEDUPE_FAILED: ${first.pid} vs ${second.pid}`);

  const deadline = Date.now() + 30_000;
  let job = created.job;
  while (Date.now() < deadline) {
    job = getExecutionJob(controllerHome, repository.repoId, created.job.jobId);
    if (['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(job.status)) break;
    await sleep(100);
  }
  if (job.status !== 'succeeded') throw new Error(`JOB_SMOKE_FAILED: ${job.status} ${job.error?.message ?? ''}`);
  if (job.result?.repoId !== repository.repoId) throw new Error('REPOSITORY_ENVELOPE_MISSING');
  if (!job.result?.repository || !job.result?.runtimeStorage) throw new Error('MULTI_REPOSITORY_RESULT_CONTRACT_MISSING');
  if (job.evidenceIds.length < 1) throw new Error('EVIDENCE_MISSING');
  const evidencePath = join(controllerHome, 'repositories', repository.repoId, 'evidence', `${job.evidenceIds[0]}.json`);
  if (!existsSync(evidencePath)) throw new Error(`EVIDENCE_FILE_MISSING: ${evidencePath}`);
  if (listActiveLeases(controllerHome, repository.repoId).length !== 0) throw new Error('LEASE_NOT_RELEASED');

  const workbenchCreated = createExecutionJob(controllerHome, {
    repoId: '__controller__',
    type: 'mcp-tool',
    requestId: 'runtime-smoke:repository-workbench',
    semanticKey: 'runtime-smoke:controller:repository-workbench',
    origin: { surface: 'system', actor: 'runtime-smoke' },
    payload: { operation: 'repository_workbench', target: 'repository-tool' },
    resourceClaims: [],
    timeoutMs: 30_000,
    maxAttempts: 1,
  });
  let workbenchJob = workbenchCreated.job;
  const workbenchDeadline = Date.now() + 30_000;
  while (Date.now() < workbenchDeadline) {
    workbenchJob = getExecutionJob(controllerHome, '__controller__', workbenchJob.jobId);
    if (['succeeded', 'failed', 'timed_out', 'cancelled', 'orphaned', 'stale', 'human_attention_required'].includes(workbenchJob.status)) break;
    await sleep(100);
  }
  if (workbenchJob.status !== 'succeeded') throw new Error(`WORKBENCH_JOB_SMOKE_FAILED: ${workbenchJob.status} ${workbenchJob.error?.message ?? ''}`);
  if (!workbenchJob.result?.workbench || typeof workbenchJob.result.workbench !== 'object') throw new Error(`WORKBENCH_RESULT_MISSING: ${JSON.stringify(workbenchJob.result)}`);

  rmSync(join(controllerHome, 'repositories', repository.repoId, 'projections', 'controller-context.json'), { force: true });
  const mcpContext = createMcpToolContext({ repo: repoRoot, controllerHome, profile: 'controller' });
  const bridgeStartedAt = Date.now();
  const bridgeStatusResult = await callRuntimeTool(mcpContext, 'local_bridge_status', {});
  const bridgeLatencyMs = Date.now() - bridgeStartedAt;
  if (!bridgeStatusResult || bridgeStatusResult.isError) throw new Error('LOCAL_BRIDGE_STATUS_FAST_PATH_FAILED');
  if (bridgeLatencyMs > 1_000) throw new Error(`LOCAL_BRIDGE_STATUS_BLOCKED_GATEWAY: ${bridgeLatencyMs}ms`);
  const bridgeStatus = bridgeStatusResult.structuredContent as Record<string, unknown>;
  if (bridgeStatus.nonBlocking !== true) throw new Error('LOCAL_BRIDGE_STATUS_NOT_MATERIALIZED');

  const jobsBeforeContext = listExecutionJobs(controllerHome, repository.repoId, 100).map((entry) => entry.jobId);
  const contextStartedAt = Date.now();
  const firstContextResult = await callRuntimeTool(mcpContext, 'controller_context', {});
  const contextLatencyMs = Date.now() - contextStartedAt;
  if (!firstContextResult || firstContextResult.isError) throw new Error('CONTROLLER_CONTEXT_FAST_PATH_FAILED');
  if (contextLatencyMs > 1_500) throw new Error(`CONTROLLER_CONTEXT_BLOCKED_GATEWAY: ${contextLatencyMs}ms`);
  const firstContext = firstContextResult.structuredContent as Record<string, unknown>;
  const contextProjection = firstContext.contextProjection as Record<string, unknown> | undefined;
  if (contextProjection?.refreshJobId !== undefined) throw new Error('CONTROLLER_CONTEXT_CREATED_REFRESH_JOB');
  if (contextProjection?.strategy !== 'event-driven' || contextProjection.readOnly !== true || contextProjection.nonBlocking !== true) {
    throw new Error(`CONTROLLER_CONTEXT_NOT_READ_ONLY: ${JSON.stringify(contextProjection)}`);
  }
  const jobsAfterContext = listExecutionJobs(controllerHome, repository.repoId, 100).map((entry) => entry.jobId);
  if (JSON.stringify(jobsAfterContext) !== JSON.stringify(jobsBeforeContext)) throw new Error('CONTROLLER_CONTEXT_MUTATED_JOB_INDEX');
  const secondContextResult = await callRuntimeTool(mcpContext, 'controller_context', {});
  const secondContext = secondContextResult?.structuredContent as Record<string, unknown> | undefined;
  const secondProjection = secondContext?.contextProjection as Record<string, unknown> | undefined;
  if (secondProjection?.strategy !== 'event-driven' || secondProjection.readOnly !== true) throw new Error('CONTROLLER_CONTEXT_READ_CONTRACT_CHANGED');

  const projection = readRepositoryProjection(controllerHome, repository.repoId);
  if (projection.activeJobs.some((entry) => entry.jobId === job.jobId)) throw new Error('TERMINAL_JOB_REMAINED_ACTIVE');

  const daemon = readControllerDaemonStatus(controllerHome);
  if (daemon.status !== 'ready') throw new Error(`DAEMON_NOT_READY: ${daemon.status}`);
  console.log(JSON.stringify({
    status: 'ok',
    daemonPid: daemon.pid,
    repoId: repository.repoId,
    jobId: job.jobId,
    jobStatus: job.status,
    evidenceIds: job.evidenceIds,
    workbenchJobId: workbenchJob.jobId,
    workbenchStatus: workbenchJob.status,
    localBridgeStatusLatencyMs: bridgeLatencyMs,
    controllerContextLatencyMs: contextLatencyMs,
    controllerContextStrategy: contextProjection?.strategy,
    activeLeases: 0,
  }, null, 2));
} finally {
  if (daemonPid) {
    try { process.kill(daemonPid, 'SIGTERM'); } catch { /* already stopped */ }
    await sleep(200);
  }
  rmSync(root, { recursive: true, force: true });
}
