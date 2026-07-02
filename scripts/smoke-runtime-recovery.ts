import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RepoActor } from '../src/runtime/control-plane/repo-actor/actor';
import { reconcileExecutionJobs } from '../src/runtime/control-plane/global-scheduler/reconciliation';
import { attachExecutionWorker, createExecutionJob, getExecutionJob, heartbeatExecutionJob, transitionExecutionJobFromWorker, updateExecutionJob } from '../src/runtime/execution/jobs/store';
import { markOperationCompleted, markOperationStarted } from '../src/runtime/execution/jobs/receipt-store';
import { readRepositoryProjection } from '../src/runtime/projections/materialized-view';
import { createSchedule } from '../src/runtime/workflow/schedules/store';
import { createPortfolioWorkflow } from '../src/runtime/workflow/portfolio/store';
import { recordCandidateFinding } from '../src/runtime/workflow/findings/store';
import { assertAutomatedOperationAllowed } from '../src/runtime/control-plane/governance/external-effects';
import { listActiveLeases, releaseExecutionLeases, renewExecutionLeases } from '../src/runtime/resources/leases/store';

const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-recovery-smoke-'));
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  const mutating = createExecutionJob(controllerHome, {
    repoId: 'repo-a', type: 'mcp-tool', requestId: 'mutating-1', semanticKey: 'mutating-1',
    origin: { surface: 'system' }, payload: { operation: 'create_issue', target: 'mcp-tool' },
    resourceClaims: [{ resourceKey: 'repo-state', mode: 'write' }], maxAttempts: 3,
  }).job;
  const claimed = new RepoActor(controllerHome, 'repo-a').tryClaimNext();
  assert(claimed?.job.jobId === mutating.jobId, 'mutating job was not claimed');
  const mutatingRunning = attachExecutionWorker(controllerHome, 'repo-a', mutating.jobId, 99999999);
  assert(mutatingRunning?.status === 'running', 'mutating worker was not attached');
  markOperationStarted(controllerHome, mutatingRunning, 99999999);
  updateExecutionJob(controllerHome, 'repo-a', mutating.jobId, (job) => ({ ...job, heartbeatAt: '2000-01-01T00:00:00.000Z' }));
  reconcileExecutionJobs(controllerHome);
  const ambiguous = getExecutionJob(controllerHome, 'repo-a', mutating.jobId);
  assert(ambiguous.status === 'human_attention_required', `ambiguous mutation was replayed as ${ambiguous.status}`);

  const recoverable = createExecutionJob(controllerHome, {
    repoId: 'repo-b', type: 'mcp-tool', requestId: 'recover-1', semanticKey: 'recover-1',
    origin: { surface: 'system' }, payload: { operation: 'controller_context', target: 'mcp-tool' },
    resourceClaims: [], maxAttempts: 2,
  }).job;
  const readClaimed = new RepoActor(controllerHome, 'repo-b').tryClaimNext();
  assert(readClaimed?.job.jobId === recoverable.jobId, 'read job was not claimed');
  const recoverableRunning = attachExecutionWorker(controllerHome, 'repo-b', recoverable.jobId, 99999998);
  assert(recoverableRunning?.status === 'running', 'recoverable worker was not attached');
  markOperationStarted(controllerHome, recoverableRunning, 99999998);
  markOperationCompleted(controllerHome, recoverableRunning, 99999998, {
    outcome: 'succeeded', result: { recovered: true }, evidenceIds: ['EVD-recovered'],
  });
  updateExecutionJob(controllerHome, 'repo-b', recoverable.jobId, (job) => ({ ...job, heartbeatAt: '2000-01-01T00:00:00.000Z' }));
  const recovery = reconcileExecutionJobs(controllerHome);
  const recovered = getExecutionJob(controllerHome, 'repo-b', recoverable.jobId);
  assert(recovered.status === 'succeeded', `completed receipt was not recovered: ${recovered.status}`);
  assert(recovered.result?.recovered === true, 'recovered result missing');
  assert(recovery.recovered >= 1, 'recovery counter missing');

  const scheduleInput = {
    requestId: 'schedule-idempotency', repoId: 'repo-a', name: 'bounded triage', enabled: true,
    trigger: { type: 'manual' as const },
    policy: { maxActiveOccurrences: 1, maxFailures: 3, cooldownMinutes: 0, dailyBudgetMinutes: 10, shadowMode: true },
    action: { operation: 'controller_context', resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' as const }] },
    stopConditions: [] as string[],
  };
  const scheduleA = createSchedule(controllerHome, scheduleInput);
  const scheduleB = createSchedule(controllerHome, scheduleInput);
  assert(scheduleA.scheduleId === scheduleB.scheduleId, 'Schedule requestId was not idempotent');

  const portfolioInput = {
    name: 'portfolio-idempotency', requestId: 'portfolio-idempotency', failurePolicy: 'stop' as const,
    steps: [{ stepId: 'one', repoId: 'repo-a', operation: 'controller_context', dependsOn: [], priority: 'P2' as const, resourceClaims: [], status: 'pending' as const }],
  };
  const portfolioA = createPortfolioWorkflow(controllerHome, portfolioInput);
  const portfolioB = createPortfolioWorkflow(controllerHome, portfolioInput);
  assert(portfolioA.workflowId === portfolioB.workflowId, 'Portfolio requestId was not idempotent');

  const zombie = createExecutionJob(controllerHome, {
    repoId: 'repo-zombie', type: 'mcp-tool', requestId: 'zombie-1', semanticKey: 'zombie-1',
    origin: { surface: 'system' }, payload: { operation: 'controller_context', target: 'mcp-tool' },
    resourceClaims: [{ resourceKey: 'repo-state', mode: 'read' }], maxAttempts: 3,
  }).job;
  const zombieFirst = new RepoActor(controllerHome, 'repo-zombie').tryClaimNext();
  assert(zombieFirst?.job.jobId === zombie.jobId, 'zombie test first attempt was not claimed');
  const zombieFirstRunning = attachExecutionWorker(controllerHome, 'repo-zombie', zombie.jobId, 99999997);
  assert(zombieFirstRunning?.status === 'running', 'zombie first worker was not attached');
  const oldLeaseRefs = zombieFirstRunning.leaseRefs.map((ref) => ({ leaseId: ref.leaseId, fencingToken: ref.fencingToken }));
  updateExecutionJob(controllerHome, 'repo-zombie', zombie.jobId, (job) => ({ ...job, heartbeatAt: '2000-01-01T00:00:00.000Z' }));
  reconcileExecutionJobs(controllerHome);
  const zombieSecond = new RepoActor(controllerHome, 'repo-zombie').tryClaimNext();
  assert(zombieSecond?.job.attempt === zombieFirstRunning.attempt + 1, 'zombie test second attempt was not claimed');
  const zombieSecondRunning = attachExecutionWorker(controllerHome, 'repo-zombie', zombie.jobId, 99999996);
  assert(zombieSecondRunning?.status === 'running', 'zombie replacement worker was not attached');
  const newLeaseRefs = zombieSecondRunning.leaseRefs.map((ref) => ({ leaseId: ref.leaseId, fencingToken: ref.fencingToken }));
  heartbeatExecutionJob(controllerHome, 'repo-zombie', zombie.jobId, 99999996, zombieSecondRunning.attempt);
  let staleHeartbeatRejected = false;
  try { heartbeatExecutionJob(controllerHome, 'repo-zombie', zombie.jobId, 99999997, zombieFirstRunning.attempt); }
  catch { staleHeartbeatRejected = true; }
  assert(staleHeartbeatRejected, 'stale Worker heartbeat was accepted');
  let staleRenewRejected = false;
  try { renewExecutionLeases(controllerHome, 'repo-zombie', zombie.jobId, 30_000, oldLeaseRefs); }
  catch { staleRenewRejected = true; }
  assert(staleRenewRejected, 'stale Worker renewed a replacement lease');
  releaseExecutionLeases(controllerHome, 'repo-zombie', zombie.jobId, oldLeaseRefs);
  assert(listActiveLeases(controllerHome, 'repo-zombie').some((lease) => newLeaseRefs.some((ref) => ref.leaseId === lease.leaseId)), 'stale Worker released the replacement lease');
  let staleCompletionRejected = false;
  try {
    transitionExecutionJobFromWorker(controllerHome, 'repo-zombie', zombie.jobId, {
      workerPid: 99999997, attempt: zombieFirstRunning.attempt, leaseRefs: oldLeaseRefs,
    }, 'succeeded');
  } catch { staleCompletionRejected = true; }
  assert(staleCompletionRejected, 'stale Worker published a terminal result');

  const candidateA = recordCandidateFinding(controllerHome, {
    repoId: 'repo-a', requestId: 'candidate-observation-1', semanticKey: 'frequent-502:mcp-timeout',
    title: 'Frequent MCP 502', summary: 'Observed during bounded triage.',
    evidence: { source: 'schedule', reference: 'OCC-1' },
  });
  const candidateB = recordCandidateFinding(controllerHome, {
    repoId: 'repo-a', requestId: 'candidate-observation-2', semanticKey: 'frequent-502:mcp-timeout',
    title: 'Frequent MCP 502', summary: 'Observed again.',
    evidence: { source: 'schedule', reference: 'OCC-2' },
  });
  assert(candidateA.findingId === candidateB.findingId && candidateB.observationCount === 2, 'candidate finding was not semantically deduplicated');
  let automaticIssueBlocked = false;
  try { assertAutomatedOperationAllowed('create_issue'); } catch { automaticIssueBlocked = true; }
  assert(automaticIssueBlocked, 'Schedule/Portfolio could create an Issue without candidate promotion');

  let cycleRejected = false;
  try {
    createPortfolioWorkflow(controllerHome, {
      name: 'cycle', requestId: 'portfolio-cycle', failurePolicy: 'stop',
      steps: [
        { stepId: 'a', repoId: 'repo-a', operation: 'controller_context', dependsOn: ['b'], priority: 'P2', resourceClaims: [], status: 'pending' },
        { stepId: 'b', repoId: 'repo-b', operation: 'controller_context', dependsOn: ['a'], priority: 'P2', resourceClaims: [], status: 'pending' },
      ],
    });
  } catch { cycleRejected = true; }
  assert(cycleRejected, 'Portfolio dependency cycle was accepted');

  const projection = readRepositoryProjection(controllerHome, 'repo-a');
  assert(projection.attention.some((entry) => entry.jobId === mutating.jobId), 'terminal attention state is absent from projection');

  console.log(JSON.stringify({
    status: 'ok',
    ambiguousMutation: ambiguous.status,
    recoveredReceipt: recovered.status,
    scheduleId: scheduleA.scheduleId,
    portfolioWorkflowId: portfolioA.workflowId,
    projectionAttention: projection.attention.length,
    zombieWorkerFenced: staleHeartbeatRejected && staleRenewRejected && staleCompletionRejected,
    candidateFindingDeduplicated: candidateB.observationCount,
    automaticIssueBlocked,
    portfolioCycleRejected: cycleRejected,
  }, null, 2));
} finally {
  rmSync(controllerHome, { recursive: true, force: true });
}
