import { randomUUID } from 'crypto';
import {
  createGoalContract,
  getGoalContract,
  listActiveGoalContracts,
  listGoalContracts,
  summarizeGoalContract,
  transitionGoalStatus,
  updateGoalContract,
  type CreateGoalContractInput,
  type GoalContractStoreOptions,
} from './goal-contract-store';
import {
  createGoalHandoffPacket,
  getGoalHandoffPacket,
  listGoalHandoffPackets,
  type HandoffPacketStoreOptions,
} from './handoff-packet';
import { routeExecutor } from './executor-router';
import { classifyFailure } from './failure-taxonomy';
import { evaluateGoalPolicyGate, effectFromRisk } from './policy-gates';
import {
  checkProviderHealth,
  listProviderHealth,
  listProviders,
  providerConfigStatus,
  type ProviderRegistryEnv,
} from './provider-registry';
import { dispatchProvider } from './provider-dispatch';
import { readProviderConfig, readRoutingConfig, type GoalLoopConfigLocation } from './config-store';
import type {
  FailureClass,
  GoalContract,
  GoalHandoffPacket,
  GoalLoopTickResult,
  GoalMode,
  GoalStatus,
  StructuredProviderOutput,
  TaskIntent,
} from './types';
import { isTerminalGoalStatus } from './types';

export interface GoalLoopContext {
  goalStore: GoalContractStoreOptions;
  packetStore: HandoffPacketStoreOptions;
  repoId: string;
  providerEnv?: ProviderRegistryEnv;
  /** When set, ExecutorRouter and provider registry load user GUI config. */
  configLocation?: GoalLoopConfigLocation;
  now?: () => string;
}

function resolvedProviderEnv(ctx: GoalLoopContext): ProviderRegistryEnv {
  const base = ctx.providerEnv ?? {};
  const configLocation = ctx.configLocation ?? base.configLocation;
  return { ...base, configLocation };
}

function routingFromConfig(ctx: GoalLoopContext) {
  const loc = ctx.configLocation ?? ctx.providerEnv?.configLocation;
  if (!loc) return undefined;
  try {
    return readRoutingConfig(loc);
  } catch {
    return undefined;
  }
}

function goalLoopEnabled(ctx: GoalLoopContext): boolean {
  const loc = ctx.configLocation ?? ctx.providerEnv?.configLocation;
  if (!loc) return true;
  try {
    return readProviderConfig(loc).goalLoopEnabled !== false;
  } catch {
    return true;
  }
}

function nowIso(ctx: GoalLoopContext): string {
  return ctx.now?.() ?? ctx.goalStore.now?.() ?? new Date().toISOString();
}

function storeOpts(ctx: GoalLoopContext): GoalContractStoreOptions {
  return { ...ctx.goalStore, now: ctx.now ?? ctx.goalStore.now };
}

function packetOpts(ctx: GoalLoopContext): HandoffPacketStoreOptions {
  return { ...ctx.packetStore, now: ctx.now ?? ctx.packetStore.now };
}

export interface GoalCreateArgs {
  title: string;
  objective: string;
  mode?: GoalMode;
  issueId?: string;
  taskIds?: string[];
  acceptanceCriteria?: string[];
  allowedExecutors?: string[];
  forbiddenExecutors?: string[];
  requiredApprovals?: string[];
  constraints?: CreateGoalContractInput['constraints'];
  verificationPolicy?: CreateGoalContractInput['verificationPolicy'];
  retryBudget?: number;
  checkIds?: string[];
}

export function goalCreate(ctx: GoalLoopContext, args: GoalCreateArgs): GoalContract {
  return createGoalContract(storeOpts(ctx), {
    repoId: ctx.repoId,
    title: args.title,
    objective: args.objective,
    mode: args.mode ?? 'autonomous',
    issueId: args.issueId,
    taskIds: args.taskIds,
    acceptanceCriteria: args.acceptanceCriteria,
    allowedExecutors: args.allowedExecutors,
    forbiddenExecutors: args.forbiddenExecutors,
    requiredApprovals: args.requiredApprovals,
    constraints: args.constraints,
    verificationPolicy: {
      requiredCheckIds: args.checkIds ?? args.verificationPolicy?.requiredCheckIds ?? [],
      ...args.verificationPolicy,
    },
    retryBudget: args.retryBudget,
  });
}

export function goalList(ctx: GoalLoopContext, status?: GoalStatus | 'active' | 'all', limit?: number): GoalContract[] {
  return listGoalContracts({ ...storeOpts(ctx), status: status ?? 'all', limit });
}

export function goalGet(ctx: GoalLoopContext, goalId: string): GoalContract | undefined {
  return getGoalContract(storeOpts(ctx), goalId);
}

export function goalStatus(ctx: GoalLoopContext, goalId?: string): Record<string, unknown> {
  const providers = listProviderHealth(resolvedProviderEnv(ctx));
  if (goalId) {
    const goal = goalGet(ctx, goalId);
    if (!goal) return { found: false, goalId, providers: compactProviderHealth(providers) };
    const packets = listGoalHandoffPackets({ ...packetOpts(ctx), goalId: goal.goalId, limit: 3 });
    return {
      found: true,
      goal: userFacingGoalStatus(goal),
      advanced: {
        goalId: goal.goalId,
        lastRunId: goal.lastRunId,
        lastProviderId: goal.lastProviderId,
        handoffPacketIds: goal.handoffPacketIds,
      },
      providers: compactProviderHealth(providers),
      handoffPacketAvailable: packets.length > 0,
      latestHandoffPacketId: packets[0]?.packetId,
      approvalRequired: goal.status === 'waiting_for_user' || (goal.requiredApprovals?.length ?? 0) > 0,
    };
  }

  const active = listActiveGoalContracts(storeOpts(ctx));
  return {
    activeGoals: active.map(userFacingGoalStatus),
    activeCount: active.length,
    providers: compactProviderHealth(providers),
    invokableProviders: providers.filter((p) => p.directDispatchAllowed).map((p) => p.providerId),
    handoffOnlyProviders: providers.filter((p) => p.handoffOnly).map((p) => p.providerId),
  };
}

function userFacingGoalStatus(goal: GoalContract): Record<string, unknown> {
  return {
    title: goal.title,
    stage: goal.status,
    currentStep: goal.currentStep,
    mode: goal.mode,
    providerSelected: goal.lastProviderId,
    lastVerification: goal.verificationEvidence?.slice(-1)[0] ?? null,
    waitingReason: goal.waitingReason,
    nextSafeAction: goal.nextSafeAction,
    handoffPacketAvailable: goal.handoffPacketIds.length > 0,
    repairAttempts: goal.repairAttempts,
    retryBudget: goal.retryBudget,
    updatedAt: goal.updatedAt,
  };
}

function compactProviderHealth(providers: ReturnType<typeof listProviderHealth>) {
  return providers.map((p) => ({
    providerId: p.providerId,
    status: p.status,
    directDispatchAllowed: p.directDispatchAllowed,
    handoffOnly: p.handoffOnly,
    lastErrorCode: p.lastErrorCode,
    summary: p.summary,
  }));
}

export function goalStart(ctx: GoalLoopContext, goalId: string): GoalLoopTickResult {
  const goal = goalGet(ctx, goalId);
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);
  if (isTerminalGoalStatus(goal.status)) {
    return {
      goalId,
      from: goal.status,
      to: goal.status,
      transitioned: false,
      reason: `Goal is already terminal (${goal.status}).`,
    };
  }
  if (goal.status !== 'created' && goal.status !== 'stopped') {
    // Starting an active goal is equivalent to a single tick.
    return goalTickOnce(ctx, goalId);
  }
  const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'planning', 'Goal started; entering planning.', {
    currentStep: 'planning',
    nextSafeAction: 'Complete planning and mark ready',
  });
  return {
    goalId,
    from: goal.status,
    to: updated.status,
    transitioned: true,
    reason: 'created -> planning',
    nextSafeAction: updated.nextSafeAction,
  };
}

export function goalContinue(ctx: GoalLoopContext, goalId: string): GoalLoopTickResult {
  return goalTickOnce(ctx, goalId);
}

export function goalStop(ctx: GoalLoopContext, goalId: string, reason?: string): GoalContract {
  return transitionGoalStatus(storeOpts(ctx), goalId, 'stopped', reason ?? 'Goal stopped by operator.', {
    currentStep: 'stopped',
    waitingReason: undefined,
    nextSafeAction: 'Create a new goal or restart if needed',
  });
}

export function goalFinalize(
  ctx: GoalLoopContext,
  goalId: string,
  options: { force?: boolean } = {},
): { goal: GoalContract; ok: boolean; reason: string } {
  const goal = goalGet(ctx, goalId);
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);

  const evidence = goal.verificationEvidence ?? [];
  const required = goal.verificationPolicy.requiredCheckIds;
  const hasPassing = evidence.some((entry) => entry.ok);
  const allRequiredPass =
    required.length === 0
      ? hasPassing
      : required.every((checkId) => evidence.some((entry) => entry.checkId === checkId && entry.ok));

  if (!options.force && goal.verificationPolicy.requirePassingEvidence && !allRequiredPass) {
    const updated = transitionGoalStatus(
      storeOpts(ctx),
      goalId,
      goal.status === 'verifying' ? 'verifying' : 'verifying',
      'Finalization blocked: missing verification evidence.',
      {
        currentStep: 'awaiting_verification_evidence',
        nextSafeAction: 'Record passing verification evidence before finalize',
      },
    );
    return {
      goal: updated,
      ok: false,
      reason: 'Finalization requires verification evidence.',
    };
  }

  const updated = transitionGoalStatus(
    storeOpts(ctx),
    goalId,
    options.force && !allRequiredPass ? 'failed' : 'finalized',
    options.force && !allRequiredPass
      ? 'Forced finalize without evidence → failed.'
      : 'Goal finalized with verification evidence.',
    {
      currentStep: options.force && !allRequiredPass ? 'failed' : 'finalized',
      nextSafeAction: undefined,
    },
  );
  return {
    goal: updated,
    ok: updated.status === 'finalized',
    reason: updated.status === 'finalized' ? 'finalized' : 'failed',
  };
}

export interface GoalTickOptions {
  goalId?: string;
  /** Inject task intent for routing (tests / explicit continue). */
  taskIntent?: TaskIntent;
  risk?: ExecutorRouteInputRisk;
  verificationResult?: { checkId: string; ok: boolean; summary?: string };
  dispatchMock?: StructuredProviderOutput | 'unsafe' | 'empty';
  forceFailureClass?: FailureClass;
  providerFailure?: boolean;
  externalWrite?: boolean;
  approvalConfirmed?: boolean;
  strongConfirmationText?: string;
}

type ExecutorRouteInputRisk =
  | 'readonly'
  | 'local_repo_write'
  | 'workspace_write'
  | 'remote_write'
  | 'destructive'
  | 'raw_secret_config';

/**
 * One bounded transition per goal per tick.
 * Daemon calls this for each active goal; ChatGPT is not required to drive every step.
 */
export function goalTickOnce(ctx: GoalLoopContext, goalId: string, options: GoalTickOptions = {}): GoalLoopTickResult {
  const goal = goalGet(ctx, goalId);
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);
  if (isTerminalGoalStatus(goal.status)) {
    return {
      goalId,
      from: goal.status,
      to: goal.status,
      transitioned: false,
      reason: `Goal is terminal (${goal.status}); no tick transition.`,
    };
  }
  if (!goalLoopEnabled(ctx)) {
    return {
      goalId,
      from: goal.status,
      to: goal.status,
      transitioned: false,
      reason: 'Goal loop disabled in Automation Settings.',
      nextSafeAction: 'Enable goal loop in Model & Tool Providers settings',
    };
  }

  const providers = listProviders(resolvedProviderEnv(ctx));
  const routingConfig = routingFromConfig(ctx);
  const from = goal.status;

  // Policy / external write gate
  if (options.externalWrite) {
    const gate = evaluateGoalPolicyGate({
      effect: 'external_write',
      constraints: goal.constraints,
      approvalConfirmed: options.approvalConfirmed,
      strongConfirmationText: options.strongConfirmationText,
    });
    if (!gate.allowed) {
      const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'waiting_for_user', gate.reason, {
        failureClass: 'external_write_requires_approval',
        waitingReason: gate.reason,
        nextSafeAction: 'Approve external write with strong confirmation',
      });
      return {
        goalId,
        from,
        to: updated.status,
        transitioned: from !== updated.status,
        reason: gate.reason,
        waitingReason: gate.reason,
        nextSafeAction: updated.nextSafeAction,
      };
    }
  }

  switch (from) {
    case 'created': {
      const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'planning', 'Daemon tick: created -> planning', {
        currentStep: 'planning',
        nextSafeAction: 'Finish planning constraints and acceptance criteria',
      });
      return tickResult(goalId, from, updated, 'created -> planning');
    }
    case 'planning': {
      const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'ready', 'Daemon tick: planning -> ready', {
        currentStep: 'ready',
        nextSafeAction: 'Dispatch to an invokable provider',
      });
      return tickResult(goalId, from, updated, 'planning -> ready');
    }
    case 'ready': {
      const route = routeExecutor({
        goal,
        taskIntent: options.taskIntent ?? inferTaskIntent(goal),
        risk: options.risk ?? 'workspace_write',
        providers,
        routingConfig,
        externalWrite: options.externalWrite,
      });
      if (route.waitForUser) {
        const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'waiting_for_user', route.reason, {
          waitingReason: route.reason,
          nextSafeAction: 'Provide approval or adjust constraints',
        });
        return tickResult(goalId, from, updated, route.reason, { waitingReason: route.reason });
      }
      if (route.handoffOnly || !route.selectedProviderId || !route.directDispatch) {
        const packet = attachHandoff(ctx, goal, route.reason, route.selectedProviderId ?? 'chatgpt_handoff');
        const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'handoff_ready', route.reason, {
          providerId: route.selectedProviderId ?? 'chatgpt_handoff',
          waitingReason: route.reason,
          nextSafeAction: 'Open handoff packet and continue in ChatGPT or configure an invokable provider',
        });
        return {
          ...tickResult(goalId, from, updated, route.reason),
          handoffPacketId: packet.packetId,
          providerId: route.selectedProviderId ?? undefined,
        };
      }
      const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'dispatching', `Selected provider ${route.selectedProviderId}`, {
        providerId: route.selectedProviderId,
        currentStep: `dispatching:${route.selectedProviderId}`,
        nextSafeAction: `Dispatch bounded work to ${route.selectedProviderId}`,
      });
      return tickResult(goalId, from, updated, `ready -> dispatching (${route.selectedProviderId})`, {
        providerId: route.selectedProviderId,
      });
    }
    case 'dispatching': {
      const route = routeExecutor({
        goal,
        taskIntent: options.taskIntent ?? inferTaskIntent(goal),
        risk: options.risk ?? 'workspace_write',
        providers,
        routingConfig,
      });
      if (route.waitForUser) {
        const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'waiting_for_user', route.reason, {
          waitingReason: route.reason,
          nextSafeAction: 'Approve before dispatch',
        });
        return tickResult(goalId, from, updated, route.reason);
      }
      if (!route.directDispatch || !route.selectedProviderId || route.handoffOnly) {
        const packet = attachHandoff(ctx, goal, 'No direct-dispatch provider for dispatching step', 'chatgpt_handoff');
        const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'handoff_ready', 'Provider not directly invokable', {
          providerId: 'chatgpt_handoff',
          nextSafeAction: 'Use handoff packet',
        });
        return { ...tickResult(goalId, from, updated, 'dispatching -> handoff_ready'), handoffPacketId: packet.packetId };
      }

      if (options.providerFailure) {
        return handleProviderFailure(ctx, goal, route.selectedProviderId, options.forceFailureClass ?? 'provider_unavailable');
      }

      const dispatch = dispatchProvider({
        providerId: route.selectedProviderId,
        objective: goal.objective,
        acceptanceCriteria: goal.acceptanceCriteria,
        allowedPaths: goal.constraints.allowedPaths,
        mockResponse: options.dispatchMock,
      });

      if (!dispatch.ok) {
        if (dispatch.rejectionReason?.includes('handoff-only')) {
          const packet = attachHandoff(ctx, goal, dispatch.summary, 'chatgpt_handoff');
          const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'handoff_ready', dispatch.summary, {
            providerId: 'chatgpt_handoff',
          });
          return { ...tickResult(goalId, from, updated, dispatch.summary), handoffPacketId: packet.packetId };
        }
        return handleProviderFailure(
          ctx,
          goal,
          route.selectedProviderId,
          options.forceFailureClass ?? 'provider_unavailable',
          dispatch.rejectionReason ?? dispatch.summary,
        );
      }

      const runId = `run-${randomUUID().slice(0, 8)}`;
      const updated = updateGoalContract(storeOpts(ctx), goalId, {
        status: 'running',
        currentStep: `running:${route.selectedProviderId}`,
        lastProviderId: route.selectedProviderId,
        lastRunId: runId,
        nextSafeAction: 'Wait for provider proposal then verify via repo-harness',
        appendArtifact: {
          kind: 'provider_proposal',
          id: runId,
          title: `Proposal from ${route.selectedProviderId}`,
          summary: dispatch.summary.slice(0, 400),
          createdAt: nowIso(ctx),
        },
        appendTransition: {
          from,
          to: 'running',
          reason: `Dispatched to ${route.selectedProviderId}; repo-harness owns apply/verify`,
          at: nowIso(ctx),
          providerId: route.selectedProviderId,
        },
      });
      return tickResult(goalId, from, updated, `dispatching -> running (${route.selectedProviderId})`, {
        providerId: route.selectedProviderId,
      });
    }
    case 'running': {
      // Model work completed (or simulated): move to verification owned by harness.
      const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'verifying', 'Provider work complete; verifying via repo-harness', {
        currentStep: 'verifying',
        nextSafeAction: 'Run registered checks and record evidence',
      });
      return tickResult(goalId, from, updated, 'running -> verifying');
    }
    case 'verifying': {
      if (options.verificationResult) {
        const entry = {
          checkId: options.verificationResult.checkId,
          ok: options.verificationResult.ok,
          summary: (options.verificationResult.summary ?? (options.verificationResult.ok ? 'passed' : 'failed')).slice(0, 400),
          at: nowIso(ctx),
        };
        updateGoalContract(storeOpts(ctx), goalId, { appendVerification: entry });
        if (options.verificationResult.ok) {
          const finalized = goalFinalize(ctx, goalId);
          return {
            goalId,
            from,
            to: finalized.goal.status,
            transitioned: true,
            reason: finalized.ok ? 'verifying -> finalized' : finalized.reason,
            nextSafeAction: finalized.goal.nextSafeAction,
          };
        }
        // Source/test failure → repairing
        const classified = classifyFailure({
          knownClass: options.forceFailureClass
            ?? (options.verificationResult.checkId.includes('type') ? 'typecheck_failure' : 'test_failure'),
          message: entry.summary,
        });
        const updated = updateGoalContract(storeOpts(ctx), goalId, {
          status: 'repairing',
          currentStep: 'repairing',
          lastFailureClass: classified.failureClass,
          repairAttempts: goal.repairAttempts + 1,
          nextSafeAction: classified.suggestedAction,
          appendTransition: {
            from,
            to: 'repairing',
            reason: `Verification failed: ${classified.failureClass}`,
            at: nowIso(ctx),
            failureClass: classified.failureClass,
          },
        });
        return tickResult(goalId, from, updated, 'verifying -> repairing', {
          nextSafeAction: classified.suggestedAction,
        });
      }

      // No verification evidence yet: stay or finalize attempt
      if ((goal.verificationEvidence ?? []).some((e) => e.ok)) {
        const finalized = goalFinalize(ctx, goalId);
        return {
          goalId,
          from,
          to: finalized.goal.status,
          transitioned: finalized.goal.status !== from,
          reason: finalized.reason,
        };
      }
      return {
        goalId,
        from,
        to: from,
        transitioned: false,
        reason: 'Awaiting verification evidence (run checks via repo-harness).',
        nextSafeAction: 'Record verification results',
      };
    }
    case 'repairing': {
      if (goal.repairAttempts >= goal.retryBudget) {
        const packet = attachHandoff(ctx, goal, 'Retry budget exhausted', 'chatgpt_handoff');
        const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'failed', 'Retry budget exhausted', {
          failureClass: goal.lastFailureClass ?? 'unknown',
          nextSafeAction: 'Review handoff packet and restart with new budget if needed',
        });
        // Prefer handoff_ready when budget exhausted due to provider issues; failed for source exhaustion.
        if (goal.lastFailureClass === 'provider_unavailable' || goal.lastFailureClass === 'provider_rate_limited') {
          const handoff = transitionGoalStatus(storeOpts(ctx), goalId, 'handoff_ready', 'Repeated provider failure; handoff packet created', {
            providerId: 'chatgpt_handoff',
            failureClass: goal.lastFailureClass,
            nextSafeAction: 'Open handoff packet',
          });
          return {
            ...tickResult(goalId, from, handoff, 'repairing -> handoff_ready (budget)'),
            handoffPacketId: packet.packetId,
          };
        }
        return { ...tickResult(goalId, from, updated, 'repairing -> failed (budget)'), handoffPacketId: packet.packetId };
      }

      // Re-dispatch repair
      const route = routeExecutor({
        goal: { ...goal, lastFailureClass: goal.lastFailureClass ?? 'source_defect' },
        taskIntent: 'code_repair',
        risk: options.risk ?? 'workspace_write',
        providers,
        routingConfig,
      });
      if (route.handoffOnly || !route.directDispatch || !route.selectedProviderId) {
        const packet = attachHandoff(ctx, goal, route.reason, 'chatgpt_handoff');
        const updated = transitionGoalStatus(storeOpts(ctx), goalId, 'handoff_ready', route.reason, {
          providerId: 'chatgpt_handoff',
        });
        return { ...tickResult(goalId, from, updated, 'repairing -> handoff_ready'), handoffPacketId: packet.packetId };
      }
      const updated = transitionGoalStatus(
        storeOpts(ctx),
        goalId,
        'dispatching',
        `Repair re-dispatch to ${route.selectedProviderId}`,
        {
          providerId: route.selectedProviderId,
          currentStep: `repair_dispatch:${route.selectedProviderId}`,
          nextSafeAction: `Dispatch repair to ${route.selectedProviderId}`,
        },
      );
      return tickResult(goalId, from, updated, `repairing -> dispatching (${route.selectedProviderId})`, {
        providerId: route.selectedProviderId,
      });
    }
    case 'waiting_for_user': {
      return {
        goalId,
        from,
        to: from,
        transitioned: false,
        reason: goal.waitingReason ?? 'Waiting for user decision; daemon will not force progress.',
        waitingReason: goal.waitingReason,
        nextSafeAction: goal.nextSafeAction ?? 'Resolve approval or provide missing configuration',
      };
    }
    case 'handoff_ready': {
      // Ensure a packet exists
      if (goal.handoffPacketIds.length === 0) {
        const packet = attachHandoff(ctx, goal, 'Handoff ready without packet; created on tick', 'chatgpt_handoff');
        return {
          goalId,
          from,
          to: from,
          transitioned: false,
          reason: 'Ensured handoff packet exists.',
          handoffPacketId: packet.packetId,
          nextSafeAction: 'Deliver packet to ChatGPT or another supervisor',
        };
      }
      return {
        goalId,
        from,
        to: from,
        transitioned: false,
        reason: 'Handoff packet available; awaiting supervisor continuation.',
        handoffPacketId: goal.handoffPacketIds[0],
        nextSafeAction: goal.nextSafeAction,
      };
    }
    default:
      return {
        goalId,
        from,
        to: from,
        transitioned: false,
        reason: `No transition defined for status ${from}`,
      };
  }
}

function handleProviderFailure(
  ctx: GoalLoopContext,
  goal: GoalContract,
  providerId: string,
  failureClass: FailureClass,
  message?: string,
): GoalLoopTickResult {
  const classified = classifyFailure({ knownClass: failureClass, message });
  const attempts = goal.repairAttempts + 1;
  const remaining = goal.retryBudget - attempts;

  if (remaining < 0 || attempts >= goal.retryBudget) {
    const packet = attachHandoff(
      ctx,
      { ...goal, lastProviderId: providerId, lastFailureClass: failureClass },
      `Repeated provider failure (${failureClass})`,
      'chatgpt_handoff',
    );
    const updated = updateGoalContract(storeOpts(ctx), goalIdSafe(goal), {
      status: 'handoff_ready',
      currentStep: 'handoff_ready',
      lastProviderId: providerId,
      lastFailureClass: failureClass,
      repairAttempts: attempts,
      nextSafeAction: 'Open handoff packet after repeated provider failure',
      appendTransition: {
        from: goal.status,
        to: 'handoff_ready',
        reason: `Provider failure exhausted retries: ${failureClass}`,
        at: nowIso(ctx),
        providerId,
        failureClass,
      },
    });
    return {
      goalId: goal.goalId,
      from: goal.status,
      to: updated.status,
      transitioned: true,
      reason: 'Repeated provider failure → handoff_ready',
      providerId,
      handoffPacketId: packet.packetId,
    };
  }

  if (classified.requiresApproval) {
    const updated = updateGoalContract(storeOpts(ctx), goal.goalId, {
      status: 'waiting_for_user',
      currentStep: 'waiting_for_user',
      lastProviderId: providerId,
      lastFailureClass: failureClass,
      repairAttempts: attempts,
      waitingReason: classified.summary,
      nextSafeAction: classified.suggestedAction,
      appendTransition: {
        from: goal.status,
        to: 'waiting_for_user',
        reason: classified.summary,
        at: nowIso(ctx),
        providerId,
        failureClass,
      },
    });
    return tickResult(goal.goalId, goal.status, updated, classified.summary, { providerId });
  }

  // Try another provider via repairing path
  const updated = updateGoalContract(storeOpts(ctx), goal.goalId, {
    status: classified.suggestedNextStatus === 'handoff_ready' ? 'repairing' : classified.suggestedNextStatus,
    currentStep: 'provider_failure_recovery',
    lastProviderId: providerId,
    lastFailureClass: failureClass,
    repairAttempts: attempts,
    nextSafeAction: classified.suggestedAction,
    appendTransition: {
      from: goal.status,
      to: classified.suggestedNextStatus === 'handoff_ready' ? 'repairing' : classified.suggestedNextStatus,
      reason: message ?? classified.summary,
      at: nowIso(ctx),
      providerId,
      failureClass,
    },
  });
  return tickResult(goal.goalId, goal.status, updated, message ?? classified.summary, { providerId });
}

function goalIdSafe(goal: GoalContract): string {
  return goal.goalId;
}

function tickResult(
  goalId: string,
  from: GoalStatus,
  updated: GoalContract,
  reason: string,
  extras: Partial<GoalLoopTickResult> = {},
): GoalLoopTickResult {
  return {
    goalId,
    from,
    to: updated.status,
    transitioned: from !== updated.status,
    reason,
    providerId: extras.providerId ?? updated.lastProviderId,
    handoffPacketId: extras.handoffPacketId,
    waitingReason: extras.waitingReason ?? updated.waitingReason,
    nextSafeAction: extras.nextSafeAction ?? updated.nextSafeAction,
  };
}

function attachHandoff(
  ctx: GoalLoopContext,
  goal: GoalContract,
  reason: string,
  recommendedProvider: string,
): GoalHandoffPacket {
  const packet = createGoalHandoffPacket(packetOpts(ctx), {
    goal,
    blockers: [reason],
    recommendedProvider,
    requiredUserDecision: goal.status === 'waiting_for_user' ? goal.waitingReason : undefined,
    nextSafeActions: [
      reason,
      goal.nextSafeAction ?? 'Review goal_status and continue when ready',
    ],
  });
  updateGoalContract(storeOpts(ctx), goal.goalId, {
    appendHandoffPacketId: packet.packetId,
    appendArtifact: {
      kind: 'handoff_packet',
      id: packet.packetId,
      title: 'Continuation handoff packet',
      summary: reason.slice(0, 400),
      createdAt: nowIso(ctx),
    },
  });
  return packet;
}

function inferTaskIntent(goal: GoalContract): TaskIntent {
  const text = `${goal.title} ${goal.objective}`.toLowerCase();
  if (text.includes('typo') || text.includes('rename') || text.includes('one-line')) return 'deterministic_edit';
  if (text.includes('repair') || text.includes('fix test') || text.includes('typecheck')) return 'code_repair';
  if (text.includes('architecture') || text.includes('design')) return 'architecture_planning';
  if (text.includes('ios') || text.includes('simulator') || text.includes('xcode')) return 'ios_build_or_sim';
  if (text.includes('browser') || text.includes('playwright') || text.includes('selector')) return 'browser_automation';
  return 'code_implementation';
}

/**
 * Scan all active goals and advance each by at most one transition.
 */
export function tickActiveGoals(
  ctx: GoalLoopContext,
  options: GoalTickOptions = {},
): GoalLoopTickResult[] {
  const active = listActiveGoalContracts(storeOpts(ctx));
  return active.map((goal) => {
    try {
      return goalTickOnce(ctx, goal.goalId, options);
    } catch (error) {
      return {
        goalId: goal.goalId,
        from: goal.status,
        to: goal.status,
        transitioned: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/**
 * Tick active goals across repositories (daemon entry).
 */
export function tickGoalLoopsForController(
  controllerHome: string,
  repoIds: string[],
  options: ProviderRegistryEnv = {},
): Array<{ repoId: string; results: GoalLoopTickResult[] }> {
  return repoIds.map((repoId) => {
    const ctx: GoalLoopContext = {
      goalStore: { controllerHome, repoId },
      packetStore: { controllerHome, repoId },
      repoId,
      providerEnv: { ...options, configLocation: options.configLocation ?? { controllerHome } },
      configLocation: options.configLocation ?? { controllerHome },
    };
    return { repoId, results: tickActiveGoals(ctx) };
  });
}

export function goalHandoffPacketCreate(
  ctx: GoalLoopContext,
  goalId: string,
  extras: {
    blockers?: string[];
    requiredUserDecision?: string;
    recommendedProvider?: string;
  } = {},
): GoalHandoffPacket {
  const goal = goalGet(ctx, goalId);
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);
  const packet = createGoalHandoffPacket(packetOpts(ctx), {
    goal,
    blockers: extras.blockers,
    requiredUserDecision: extras.requiredUserDecision,
    recommendedProvider: extras.recommendedProvider ?? 'chatgpt_handoff',
  });
  updateGoalContract(storeOpts(ctx), goalId, {
    status: goal.status === 'waiting_for_user' ? goal.status : 'handoff_ready',
    appendHandoffPacketId: packet.packetId,
  });
  return packet;
}

export function goalHandoffPacketGet(ctx: GoalLoopContext, packetId: string): GoalHandoffPacket | undefined {
  return getGoalHandoffPacket(packetOpts(ctx), packetId);
}

export function executorRoutePreview(
  ctx: GoalLoopContext,
  input: {
    goalId?: string;
    taskIntent?: TaskIntent;
    risk?: ExecutorRouteInputRisk;
    objective?: string;
  },
) {
  const goal = input.goalId
    ? goalGet(ctx, input.goalId)
    : {
        goalId: 'preview',
        repoId: ctx.repoId,
        mode: 'autonomous' as const,
        status: 'ready' as const,
        objective: input.objective ?? 'preview',
        constraints: {},
        allowedExecutors: [] as string[],
        forbiddenExecutors: [] as string[],
        lastProviderId: undefined,
        repairAttempts: 0,
        retryBudget: 5,
        lastFailureClass: undefined,
      };
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${input.goalId}`);
  return routeExecutor({
    goal,
    taskIntent: input.taskIntent ?? 'code_implementation',
    risk: input.risk ?? 'workspace_write',
    providers: listProviders(resolvedProviderEnv(ctx)),
    routingConfig: routingFromConfig(ctx),
  });
}

export function executorDispatch(
  ctx: GoalLoopContext,
  input: {
    goalId: string;
    providerId?: string;
    taskIntent?: TaskIntent;
    risk?: ExecutorRouteInputRisk;
    mockResponse?: StructuredProviderOutput | 'unsafe' | 'empty';
    approvalConfirmed?: boolean;
    externalWrite?: boolean;
    strongConfirmationText?: string;
  },
): Record<string, unknown> {
  const goal = goalGet(ctx, input.goalId);
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${input.goalId}`);

  const gate = evaluateGoalPolicyGate({
    effect: effectFromRisk(input.risk ?? 'workspace_write', { externalWrite: input.externalWrite }),
    constraints: goal.constraints,
    approvalConfirmed: input.approvalConfirmed,
    strongConfirmationText: input.strongConfirmationText,
  });
  if (!gate.allowed) {
    return {
      ok: false,
      approvalState: gate.approvalState,
      reason: gate.reason,
      requiredConfirmationText: gate.requiredConfirmationText,
      dispatched: false,
    };
  }

  const providers = listProviders(resolvedProviderEnv(ctx));
  const route = routeExecutor({
    goal,
    taskIntent: input.taskIntent ?? inferTaskIntent(goal),
    risk: input.risk ?? 'workspace_write',
    providers,
    routingConfig: routingFromConfig(ctx),
    userConstraints: input.providerId ? { preferProvider: input.providerId } : undefined,
    externalWrite: input.externalWrite,
  });

  if (route.handoffOnly || !route.directDispatch || !route.selectedProviderId) {
    const packet = goalHandoffPacketCreate(ctx, goal.goalId, {
      blockers: [route.reason],
      recommendedProvider: route.selectedProviderId ?? 'chatgpt_handoff',
    });
    return {
      ok: false,
      dispatched: false,
      handoffOnly: true,
      reason: route.reason,
      handoffPacketId: packet.packetId,
      // Never treat chatgpt as direct
      directDispatch: false,
    };
  }

  if (route.selectedProviderId === 'chatgpt_handoff') {
    return {
      ok: false,
      dispatched: false,
      reason: 'chatgpt_handoff cannot be direct-dispatched',
      directDispatch: false,
    };
  }

  const result = dispatchProvider({
    providerId: route.selectedProviderId,
    objective: goal.objective,
    acceptanceCriteria: goal.acceptanceCriteria,
    allowedPaths: goal.constraints.allowedPaths,
    mockResponse: input.mockResponse,
  });

  if (result.ok) {
    updateGoalContract(storeOpts(ctx), goal.goalId, {
      lastProviderId: route.selectedProviderId,
      lastRunId: `run-${randomUUID().slice(0, 8)}`,
      appendArtifact: {
        kind: 'provider_proposal',
        title: `Dispatch ${route.selectedProviderId}`,
        summary: result.summary.slice(0, 400),
        createdAt: nowIso(ctx),
      },
    });
  }

  return {
    ok: result.ok,
    dispatched: result.ok,
    providerId: route.selectedProviderId,
    directDispatch: true,
    appliedByRepoHarness: true,
    summary: result.summary,
    rejectionReason: result.rejectionReason,
    output: result.output,
    routeReason: route.reason,
  };
}

export function repairPlan(ctx: GoalLoopContext, goalId: string): Record<string, unknown> {
  const goal = goalGet(ctx, goalId);
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);
  const classified = classifyFailure({
    knownClass: goal.lastFailureClass,
    message: goal.waitingReason,
  });
  const route = routeExecutor({
    goal: { ...goal, lastFailureClass: classified.failureClass },
    taskIntent: 'code_repair',
    risk: 'workspace_write',
    providers: listProviders(resolvedProviderEnv(ctx)),
    routingConfig: routingFromConfig(ctx),
  });
  return {
    goalId: goal.goalId,
    failureClass: classified.failureClass,
    summary: classified.summary,
    repairableByModel: classified.repairableByModel,
    requiresApproval: classified.requiresApproval,
    suggestedNextStatus: classified.suggestedNextStatus,
    suggestedAction: classified.suggestedAction,
    recommendedProvider: route.selectedProviderId,
    routeReason: route.reason,
    directDispatch: route.directDispatch,
  };
}

export function repairContinue(ctx: GoalLoopContext, goalId: string, options: GoalTickOptions = {}): GoalLoopTickResult {
  const goal = goalGet(ctx, goalId);
  if (!goal) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);
  if (goal.status !== 'repairing' && goal.status !== 'verifying' && goal.status !== 'failed') {
    updateGoalContract(storeOpts(ctx), goalId, {
      status: 'repairing',
      currentStep: 'repairing',
      lastFailureClass: options.forceFailureClass ?? goal.lastFailureClass ?? 'source_defect',
    });
  }
  return goalTickOnce(ctx, goalId, { ...options, taskIntent: 'code_repair' });
}

export function providerListAction(ctx: GoalLoopContext) {
  return listProviders(resolvedProviderEnv(ctx)).map((p) => ({
    providerId: p.providerId,
    kind: p.kind,
    modelFamily: p.modelFamily,
    status: p.status,
    directDispatch: p.directDispatch,
    capabilities: p.capabilities,
    summary: p.summary,
    lastErrorCode: p.lastErrorCode,
  }));
}

export function providerHealthAction(ctx: GoalLoopContext, providerId?: string) {
  if (providerId) return checkProviderHealth(providerId, resolvedProviderEnv(ctx));
  return listProviderHealth(resolvedProviderEnv(ctx));
}

export function providerConfigStatusAction(ctx: GoalLoopContext) {
  return providerConfigStatus(resolvedProviderEnv(ctx));
}

export { summarizeGoalContract };
