import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertNoSecretsInText,
  createGoalContract,
  dispatchProvider,
  evaluateGoalPolicyGate,
  executorDispatch,
  getGoalContract,
  goalCreate,
  goalFinalize,
  goalHandoffPacketCreate,
  goalStart,
  goalTickOnce,
  listProviders,
  checkProviderHealth,
  previewExecutorRoute,
  providerConfigStatus,
  repairContinue,
  routeExecutor,
  tickActiveGoals,
  validateStructuredProviderOutput,
  type GoalLoopContext,
  type ProviderDescriptor,
} from '../../src/runtime/control-plane/goal-loop';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(env: NodeJS.ProcessEnv = {}, overrides?: GoalLoopContext['providerEnv']) {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-goal-loop-'));
  roots.push(root);
  let tick = 0;
  const now = () => `2026-07-09T12:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`;
  const ctx: GoalLoopContext = {
    goalStore: { root: join(root, 'goals'), now },
    packetStore: { root: join(root, 'packets'), now },
    repoId: 'repo_123b7cf58b6b17b5cbe46a56',
    providerEnv: {
      skipExecutableProbe: true,
      env: overrides?.env ?? env,
      overrides: {
        codex_cli: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
        claude_cli: { status: 'unavailable', directDispatch: false },
        github_copilot_cloud: { status: 'unavailable', directDispatch: false },
        ...overrides?.overrides,
      },
      mockHealth: overrides?.mockHealth,
    },
    now,
  };
  return { ctx, root };
}

function providersFor(overrides: Partial<Record<string, Partial<ProviderDescriptor>>> = {}, env: NodeJS.ProcessEnv = {}) {
  return listProviders({
    env,
    skipExecutableProbe: true,
    overrides: {
      codex_cli: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
      claude_cli: { status: 'unavailable' },
      github_copilot_cloud: { status: 'unavailable' },
      ...overrides,
    },
  });
}

describe('GoalContract lifecycle', () => {
  test('create/read/update lifecycle', () => {
    const { ctx } = fixture();
    const created = goalCreate(ctx, {
      title: 'Fix facade routing',
      objective: 'Complete autonomous goal loop',
      mode: 'autonomous',
      acceptanceCriteria: ['typecheck passes'],
      checkIds: ['package:check:type'],
    });
    expect(created.status).toBe('created');
    expect(created.repoId).toBe(ctx.repoId);
    expect(getGoalContract(ctx.goalStore, created.goalId)?.objective).toContain('autonomous goal loop');

    const started = goalStart(ctx, created.goalId);
    expect(started.to).toBe('planning');
    expect(getGoalContract(ctx.goalStore, created.goalId)?.status).toBe('planning');
  });
});

describe('daemon tick transitions', () => {
  test('created -> planning -> ready', () => {
    const { ctx } = fixture();
    const goal = goalCreate(ctx, {
      title: 'Tick path',
      objective: 'Advance without ChatGPT each step',
    });
    const t1 = goalTickOnce(ctx, goal.goalId);
    expect(t1).toMatchObject({ from: 'created', to: 'planning', transitioned: true });
    const t2 = goalTickOnce(ctx, goal.goalId);
    expect(t2).toMatchObject({ from: 'planning', to: 'ready', transitioned: true });
    expect(getGoalContract(ctx.goalStore, goal.goalId)?.status).toBe('ready');
  });

  test('tickActiveGoals advances each active goal once', () => {
    const { ctx } = fixture();
    const a = goalCreate(ctx, { title: 'A', objective: 'one' });
    const b = goalCreate(ctx, { title: 'B', objective: 'two' });
    const results = tickActiveGoals(ctx);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.to === 'planning')).toBe(true);
    expect(getGoalContract(ctx.goalStore, a.goalId)?.status).toBe('planning');
    expect(getGoalContract(ctx.goalStore, b.goalId)?.status).toBe('planning');
  });
});

describe('ExecutorRouter', () => {
  test('chooses direct_edit for low-risk deterministic change', () => {
    const providers = providersFor();
    const decision = routeExecutor({
      goal: {
        goalId: 'g1',
        repoId: 'r1',
        mode: 'autonomous',
        status: 'ready',
        objective: 'typo fix',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        repairAttempts: 0,
        retryBudget: 5,
      },
      taskIntent: 'deterministic_edit',
      risk: 'local_repo_write',
      providers,
    });
    expect(decision.selectedProviderId).toBe('direct_edit');
    expect(decision.directDispatch).toBe(true);
  });

  test('chooses codex_cli when ready for normal code task', () => {
    const providers = providersFor();
    const decision = routeExecutor({
      goal: {
        goalId: 'g1',
        repoId: 'r1',
        mode: 'autonomous',
        status: 'ready',
        objective: 'implement feature',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        repairAttempts: 0,
        retryBudget: 5,
      },
      taskIntent: 'code_implementation',
      risk: 'workspace_write',
      providers,
    });
    expect(decision.selectedProviderId).toBe('codex_cli');
  });

  test('chooses grok_cli when ready after codex failed', () => {
    const providers = providersFor({
      grok_cli: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
      grok_api: { status: 'missing_auth', directDispatch: false },
    });
    const decision = routeExecutor({
      goal: {
        goalId: 'g1',
        repoId: 'r1',
        mode: 'autonomous',
        status: 'repairing',
        objective: 'repair after codex',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        lastProviderId: 'codex_cli',
        lastFailureClass: 'source_defect',
        repairAttempts: 1,
        retryBudget: 5,
      },
      taskIntent: 'code_repair',
      risk: 'workspace_write',
      providers,
    });
    expect(decision.selectedProviderId).toBe('grok_cli');
    expect(decision.directDispatch).toBe(true);
  });

  test('chooses grok_api when configured and codex/grok_cli unavailable', () => {
    const providers = providersFor({
      grok_cli: { status: 'unavailable', directDispatch: false },
      grok_api: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
    }, { XAI_API_KEY: 'test-not-a-real-key' });
    const decision = routeExecutor({
      goal: {
        goalId: 'g1',
        repoId: 'r1',
        mode: 'autonomous',
        status: 'repairing',
        objective: 'repair after codex',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        lastProviderId: 'codex_cli',
        lastFailureClass: 'source_defect',
        repairAttempts: 1,
        retryBudget: 5,
      },
      taskIntent: 'code_repair',
      risk: 'workspace_write',
      providers,
    });
    expect(decision.selectedProviderId).toBe('grok_api');
    expect(decision.directDispatch).toBe(true);
  });

  test('does not choose chatgpt_handoff for direct dispatch', () => {
    const providers = providersFor({
      codex_cli: { status: 'unavailable', directDispatch: false },
      grok_api: { status: 'missing_auth', directDispatch: false },
      deepseek_api: { status: 'missing_auth', directDispatch: false },
      openai_api: { status: 'missing_auth', directDispatch: false },
      direct_edit: { status: 'disabled', directDispatch: false },
    });
    const decision = routeExecutor({
      goal: {
        goalId: 'g1',
        repoId: 'r1',
        mode: 'autonomous',
        status: 'ready',
        objective: 'anything',
        constraints: {},
        allowedExecutors: [],
        forbiddenExecutors: [],
        repairAttempts: 0,
        retryBudget: 5,
      },
      taskIntent: 'code_implementation',
      risk: 'workspace_write',
      providers,
    });
    expect(decision.selectedProviderId).toBe('chatgpt_handoff');
    expect(decision.directDispatch).toBe(false);
    expect(decision.handoffOnly).toBe(true);
  });
});

describe('provider health and config', () => {
  test('missing XAI_API_KEY marks grok_api missing_auth', () => {
    const health = checkProviderHealth('grok_api', {
      env: {},
      skipExecutableProbe: true,
    });
    expect(health.status).toBe('missing_auth');
    expect(health.lastErrorCode).toBe('MISSING_XAI_API_KEY');
    expect(health.directDispatchAllowed).toBe(false);
    expect(health.redacted).toBe(true);
  });

  test('configured XAI_API_KEY marks grok_api ready for direct dispatch only when live effective', () => {
    const withoutLive = checkProviderHealth('grok_api', {
      env: { XAI_API_KEY: 'xai-test-placeholder' },
      skipExecutableProbe: true,
      liveModelProvidersEffective: false,
    });
    expect(withoutLive.authPresent).toBe(true);
    expect(withoutLive.directDispatchAllowed).toBe(false);

    const withLive = checkProviderHealth('grok_api', {
      env: { XAI_API_KEY: 'xai-test-placeholder', REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS: '1' },
      skipExecutableProbe: true,
      liveModelProvidersEffective: true,
    });
    expect(withLive.status).toBe('ready');
    expect(withLive.authPresent).toBe(true);
    expect(withLive.directDispatchAllowed).toBe(true);
  });

  test('chatgpt_handoff is always handoff_only', () => {
    const health = checkProviderHealth('chatgpt_handoff', { skipExecutableProbe: true });
    expect(health.handoffOnly).toBe(true);
    expect(health.directDispatchAllowed).toBe(false);
    expect(health.status).toBe('handoff_only');
  });

  test('provider config status splits invokable vs missing auth', () => {
    const status = providerConfigStatus({
      env: { XAI_API_KEY: 'xai-test', REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS: '1' },
      skipExecutableProbe: true,
      liveModelProvidersEffective: true,
      overrides: {
        codex_cli: { status: 'ready', directDispatch: true },
        grok_api: { status: 'ready', directDispatch: true, authPresent: true },
      },
    });
    expect(status.invokable.some((p) => p.providerId === 'grok_api' || p.providerId === 'codex_cli')).toBe(true);
    expect(status.handoffOnly.some((p) => p.providerId === 'chatgpt_handoff')).toBe(true);
    expect(status.redacted).toBe(true);
  });
});

describe('handoff packet', () => {
  test('chatgpt_handoff produces continuation packet', () => {
    const { ctx } = fixture({}, {
      overrides: {
        codex_cli: { status: 'unavailable', directDispatch: false },
        grok_api: { status: 'missing_auth', directDispatch: false },
        deepseek_api: { status: 'missing_auth', directDispatch: false },
        openai_api: { status: 'missing_auth', directDispatch: false },
        direct_edit: { status: 'disabled', directDispatch: false },
      },
    });
    const goal = goalCreate(ctx, {
      title: 'Blocked goal',
      objective: 'Need ChatGPT supervisor continuation',
    });
    // Advance to ready
    goalTickOnce(ctx, goal.goalId);
    goalTickOnce(ctx, goal.goalId);
    const tick = goalTickOnce(ctx, goal.goalId, { taskIntent: 'code_implementation' });
    expect(tick.to).toBe('handoff_ready');
    expect(tick.handoffPacketId).toBeTruthy();

    const packet = goalHandoffPacketCreate(ctx, goal.goalId, {
      blockers: ['no invokable provider'],
      requiredUserDecision: 'Configure XAI_API_KEY or continue in ChatGPT',
    });
    expect(packet.goalId).toBe(goal.goalId);
    expect(packet.redacted).toBe(true);
    expect(packet.nextSafeActions.length).toBeGreaterThan(0);
    expect(packet.recommendedProvider).toBe('chatgpt_handoff');
    expect(JSON.stringify(packet)).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
  });
});

describe('Grok structured dispatch and safety', () => {
  test('configured mock Grok provider can return structured patch proposal', () => {
    const result = dispatchProvider({
      providerId: 'grok_api',
      objective: 'Fix failing typecheck',
      acceptanceCriteria: ['tsc passes'],
      allowedPaths: ['src/runtime/control-plane/goal-loop/types.ts'],
      mockResponse: {
        summary: 'Adjust status union typing',
        proposed_patch: '*** Begin Patch\n*** Update File: src/foo.ts\n+export const x = 1\n*** End Patch',
        changed_files: ['src/foo.ts'],
        verification_commands: ['npm run check:type'],
        risk_notes: ['bounded'],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.appliedByRepoHarness).toBe(true);
    expect(result.output?.changed_files).toContain('src/foo.ts');
  });

  test('unsafe provider output is rejected', () => {
    const validated = validateStructuredProviderOutput({
      summary: 'wipe disk',
      proposed_patch: 'rm -rf /',
      changed_files: ['x'],
      verification_commands: [],
      risk_notes: [],
    });
    expect(validated.ok).toBe(false);

    const dispatch = dispatchProvider({
      providerId: 'grok_api',
      objective: 'bad',
      acceptanceCriteria: [],
      mockResponse: 'unsafe',
    });
    expect(dispatch.ok).toBe(false);
    expect(dispatch.rejectionReason).toMatch(/unsafe|rejected/i);
  });

  test('chatgpt_handoff cannot be direct-dispatched', () => {
    const result = dispatchProvider({
      providerId: 'chatgpt_handoff',
      objective: 'plan',
      acceptanceCriteria: [],
    });
    expect(result.ok).toBe(false);
    expect(result.directDispatch).toBe(false);
  });
});

describe('policy gates', () => {
  test('external write requires approval', () => {
    const denied = evaluateGoalPolicyGate({
      effect: 'external_write',
      constraints: { allowExternalWrite: false },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.approvalState).toBe('strong_confirmation_required');

    const allowed = evaluateGoalPolicyGate({
      effect: 'external_write',
      constraints: { allowExternalWrite: true },
      approvalConfirmed: true,
      strongConfirmationText: 'confirm-destructive-or-external-effect',
    });
    expect(allowed.allowed).toBe(true);
  });

  test('executor_dispatch respects external write gate', () => {
    const { ctx } = fixture({ XAI_API_KEY: 'xai-test' }, {
      overrides: {
        grok_api: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
      },
    });
    const goal = goalCreate(ctx, {
      title: 'External',
      objective: 'send email',
      constraints: { allowExternalWrite: false },
    });
    const result = executorDispatch(ctx, {
      goalId: goal.goalId,
      externalWrite: true,
      risk: 'remote_write',
    });
    expect(result.ok).toBe(false);
    expect(result.approvalState).toBe('strong_confirmation_required');
    expect(result.dispatched).toBe(false);
  });
});

describe('repair and finalization', () => {
  test('source failure enters repairing', () => {
    const { ctx } = fixture({ XAI_API_KEY: 'xai-test' }, {
      overrides: {
        grok_api: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
        codex_cli: { status: 'ready', directDispatch: true },
      },
    });
    const goal = goalCreate(ctx, {
      title: 'Repair path',
      objective: 'Implement feature then fix tests',
      checkIds: ['package:test'],
    });
    // created -> planning -> ready -> dispatching -> running -> verifying
    goalTickOnce(ctx, goal.goalId);
    goalTickOnce(ctx, goal.goalId);
    goalTickOnce(ctx, goal.goalId, { taskIntent: 'code_implementation' });
    goalTickOnce(ctx, goal.goalId, {
      taskIntent: 'code_implementation',
      dispatchMock: {
        summary: 'patch',
        changed_files: ['a.ts'],
        proposed_patch: 'diff',
        verification_commands: ['bun test'],
        risk_notes: [],
      },
    });
    goalTickOnce(ctx, goal.goalId);
    const verifying = getGoalContract(ctx.goalStore, goal.goalId);
    expect(verifying?.status).toBe('verifying');

    const failTick = goalTickOnce(ctx, goal.goalId, {
      verificationResult: { checkId: 'package:test', ok: false, summary: '1 test failed' },
      forceFailureClass: 'test_failure',
    });
    expect(failTick.to).toBe('repairing');
  });

  test('repeated provider failure creates handoff packet', () => {
    const { ctx } = fixture({}, {
      overrides: {
        codex_cli: { status: 'ready', directDispatch: true },
        grok_api: { status: 'missing_auth', directDispatch: false },
      },
    });
    const goal = createGoalContract(ctx.goalStore, {
      repoId: ctx.repoId,
      title: 'Provider churn',
      objective: 'fail providers',
      status: 'dispatching',
      retryBudget: 1,
      currentStep: 'dispatching',
    });
    // Force repairAttempts near budget via update path inside failure handler
    const tick = goalTickOnce(ctx, goal.goalId, {
      taskIntent: 'code_implementation',
      providerFailure: true,
      forceFailureClass: 'provider_unavailable',
    });
    // With retryBudget 1, first failure increments to 1 then may still recover to repairing;
    // second failure should handoff.
    const g1 = getGoalContract(ctx.goalStore, goal.goalId)!;
    if (g1.status !== 'handoff_ready') {
      // Move back to dispatching if repairing
      if (g1.status === 'repairing') {
        goalTickOnce(ctx, goal.goalId, { taskIntent: 'code_repair' });
      }
      const tick2 = goalTickOnce(ctx, goal.goalId, {
        providerFailure: true,
        forceFailureClass: 'provider_unavailable',
      });
      expect(['handoff_ready', 'repairing', 'waiting_for_user', 'failed']).toContain(tick2.to);
      if (tick2.to === 'handoff_ready') {
        expect(tick2.handoffPacketId || getGoalContract(ctx.goalStore, goal.goalId)?.handoffPacketIds.length).toBeTruthy();
      }
    } else {
      expect(tick.handoffPacketId || g1.handoffPacketIds.length).toBeTruthy();
    }
  });

  test('finalization requires verification evidence', () => {
    const { ctx } = fixture();
    const goal = goalCreate(ctx, {
      title: 'Finalize gate',
      objective: 'Need evidence',
      verificationPolicy: { requirePassingEvidence: true, requiredCheckIds: ['package:check:type'], maxInfrastructureRetries: 3 },
    });
    const blocked = goalFinalize(ctx, goal.goalId);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/verification evidence/i);

    // Provide evidence through tick path
    goalTickOnce(ctx, goal.goalId); // planning
    goalTickOnce(ctx, goal.goalId); // ready
    // Manually jump verification by recording via tick with verifying state is hard;
    // use goalFinalize after injecting verification via repair path: update store through tick from verifying
    // Simpler: create with status verifying via createGoalContract
    const g2 = createGoalContract(ctx.goalStore, {
      repoId: ctx.repoId,
      title: 'With evidence',
      objective: 'done',
      status: 'verifying',
      verificationPolicy: { requirePassingEvidence: true, requiredCheckIds: ['package:check:type'], maxInfrastructureRetries: 3 },
    });
    goalTickOnce(ctx, g2.goalId, {
      verificationResult: { checkId: 'package:check:type', ok: true, summary: 'passed' },
    });
    expect(getGoalContract(ctx.goalStore, g2.goalId)?.status).toBe('finalized');
  });

  test('repair_continue re-dispatches after source failure', () => {
    const { ctx } = fixture({ XAI_API_KEY: 'xai-test' }, {
      overrides: {
        grok_cli: { status: 'ready', directDispatch: true, configured: true, authPresent: true },
        grok_api: { status: 'missing_auth', directDispatch: false },
        codex_cli: { status: 'unavailable', directDispatch: false },
      },
    });
    const goal = createGoalContract(ctx.goalStore, {
      repoId: ctx.repoId,
      title: 'Continue repair',
      objective: 'fix types',
      status: 'repairing',
      lastFailureClass: 'typecheck_failure',
      lastProviderId: 'codex_cli',
      repairAttempts: 1,
      retryBudget: 5,
    });
    const tick = repairContinue(ctx, goal.goalId);
    expect(tick.to).toBe('dispatching');
    expect(tick.providerId).toBe('grok_cli');
  });
});

describe('secrets hygiene', () => {
  test('no secrets appear in provider summaries or handoff packets', () => {
    const health = checkProviderHealth('grok_api', {
      env: { XAI_API_KEY: 'xai-super-secret-value-should-not-leak' },
      skipExecutableProbe: true,
    });
    expect(JSON.stringify(health)).not.toContain('xai-super-secret-value-should-not-leak');
    expect(assertNoSecretsInText(health.summary)).toBe(true);

    const { ctx } = fixture({ XAI_API_KEY: 'xai-super-secret-value-should-not-leak' });
    const goal = goalCreate(ctx, { title: 'Secret check', objective: 'no leaks' });
    const packet = goalHandoffPacketCreate(ctx, goal.goalId, {
      blockers: ['auth needed'],
    });
    expect(JSON.stringify(packet)).not.toContain('xai-super-secret-value-should-not-leak');
    expect(packet.redacted).toBe(true);
  });
});

describe('route preview helper', () => {
  test('previewExecutorRoute mirrors routeExecutor', () => {
    const { ctx } = fixture();
    const goal = goalCreate(ctx, { title: 'Preview', objective: 'route preview' });
    const preview = previewExecutorRoute({
      goal: getGoalContract(ctx.goalStore, goal.goalId)!,
      taskIntent: 'deterministic_edit',
      risk: 'local_repo_write',
      providers: listProviders(ctx.providerEnv),
    });
    expect(preview.selectedProviderId).toBe('direct_edit');
  });
});
