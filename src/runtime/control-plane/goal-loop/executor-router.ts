import { evaluateGoalPolicyGate, effectFromRisk } from './policy-gates';
import type {
  ExecutorRouteDecision,
  ExecutorRouteInput,
  ProviderDescriptor,
  ProviderStatus,
} from './types';

function isReadyDirect(provider: ProviderDescriptor | undefined): boolean {
  return Boolean(
    provider
    && provider.directDispatch
    && provider.status === 'ready'
    && provider.kind !== 'handoff_only',
  );
}

function findReady(
  providers: ProviderDescriptor[],
  providerId: string,
): ProviderDescriptor | undefined {
  const provider = providers.find((entry) => entry.providerId === providerId);
  return isReadyDirect(provider) ? provider : undefined;
}

function allowedByGoal(providerId: string, input: ExecutorRouteInput): boolean {
  if (input.goal.forbiddenExecutors.includes(providerId)) return false;
  if (input.userConstraints?.forbidProvider?.includes(providerId)) return false;
  if (input.goal.allowedExecutors.length > 0 && !input.goal.allowedExecutors.includes(providerId)) {
    return false;
  }
  return true;
}

function firstReady(
  providers: ProviderDescriptor[],
  candidates: string[],
  input: ExecutorRouteInput,
): ProviderDescriptor | undefined {
  for (const id of candidates) {
    if (!allowedByGoal(id, input)) continue;
    const ready = findReady(providers, id);
    if (ready) return ready;
  }
  return undefined;
}

function decision(
  provider: ProviderDescriptor | null,
  reason: string,
  extras: Partial<ExecutorRouteDecision> = {},
  alternatives: string[] = [],
): ExecutorRouteDecision {
  if (!provider) {
    return {
      selectedProviderId: null,
      reason,
      directDispatch: false,
      handoffOnly: extras.handoffOnly ?? true,
      waitForUser: extras.waitForUser ?? false,
      approvalState: extras.approvalState ?? 'approval_not_required',
      alternatives,
    };
  }
  return {
    selectedProviderId: provider.providerId,
    selectedProvider: provider,
    reason,
    directDispatch: provider.directDispatch && provider.kind !== 'handoff_only',
    handoffOnly: provider.kind === 'handoff_only' || provider.status === 'handoff_only',
    waitForUser: extras.waitForUser ?? false,
    approvalState: extras.approvalState ?? 'approval_not_required',
    alternatives,
  };
}

/**
 * Select a provider for the next goal action.
 * Never selects chatgpt_handoff for direct dispatch.
 */
export function routeExecutor(input: ExecutorRouteInput): ExecutorRouteDecision {
  const providers = input.providers;
  const chatHandoff = providers.find((p) => p.providerId === 'chatgpt_handoff');
  const alternatives = providers
    .filter((p) => p.directDispatch && p.status === 'ready')
    .map((p) => p.providerId);

  if (input.policyBlocked) {
    return decision(null, 'Policy blocked; waiting for user authorization.', {
      waitForUser: true,
      approvalState: 'blocked_by_policy',
      handoffOnly: false,
    }, alternatives);
  }

  const policy = evaluateGoalPolicyGate({
    effect: effectFromRisk(input.risk, { externalWrite: input.externalWrite }),
    constraints: input.goal.constraints,
    approvalConfirmed: input.requiresApproval === false ? true : undefined,
    expectedChangedFiles: input.goal.constraints.maxChangedFiles,
    expectedChangedLines: input.goal.constraints.maxChangedLines,
  });

  if (!policy.allowed && policy.approvalState !== 'approval_not_required') {
    return decision(null, policy.reason, {
      waitForUser: true,
      approvalState: policy.approvalState,
      handoffOnly: false,
    }, alternatives);
  }

  if (input.requiresApproval) {
    return decision(null, 'Explicit user approval required before dispatch.', {
      waitForUser: true,
      approvalState: 'normal_authorization_required',
    }, alternatives);
  }

  if (input.userConstraints?.preferProvider) {
    const preferred = firstReady(providers, [input.userConstraints.preferProvider], input);
    if (preferred) {
      return decision(preferred, `User preferred provider ${preferred.providerId}.`, {}, alternatives);
    }
  }

  const failure = input.goal.lastFailureClass;
  const lastProvider = input.goal.lastProviderId;
  const intent = input.taskIntent;

  // Repair after Codex (or primary CLI) failure → try Grok / Claude.
  if (
    intent === 'code_repair'
    || intent === 'verification_repair'
    || failure === 'test_failure'
    || failure === 'typecheck_failure'
    || failure === 'source_defect'
    || (lastProvider === 'codex_cli' && (failure === 'provider_unavailable' || failure === 'unknown'))
  ) {
    const repair = firstReady(providers, ['grok_api', 'claude_cli', 'codex_cli', 'deepseek_api', 'openai_api'], input);
    if (repair) {
      return decision(
        repair,
        `Repair-capable provider selected after failure class ${failure ?? 'repair_intent'}.`,
        {},
        alternatives,
      );
    }
  }

  if (intent === 'deterministic_edit') {
    const direct = firstReady(providers, ['direct_edit'], input);
    if (direct) {
      return decision(direct, 'Deterministic low-risk edit routes to direct_edit.', {}, alternatives);
    }
  }

  if (intent === 'architecture_planning') {
    // Prefer invokable planners when configured; otherwise handoff packet.
    const planner = firstReady(providers, ['openai_api', 'grok_api', 'deepseek_api', 'claude_cli'], input);
    if (planner) {
      return decision(planner, 'Architecture planning uses a configured invokable planner.', {}, alternatives);
    }
    if (chatHandoff) {
      return decision(chatHandoff, 'No invokable planner; ChatGPT handoff packet required.', {
        handoffOnly: true,
        directDispatch: false,
      }, alternatives);
    }
  }

  if (intent === 'ios_build_or_sim' || intent === 'browser_automation') {
    // Models only analyze/plan; local tooling executes. Prefer repair/analysis providers.
    const analyzer = firstReady(providers, ['codex_cli', 'claude_cli', 'grok_api', 'openai_api'], input);
    if (analyzer) {
      return decision(
        analyzer,
        `${intent} uses models for analysis only; local tooling executes side effects.`,
        {},
        alternatives,
      );
    }
  }

  if (intent === 'code_implementation' || intent === 'unknown' || intent === 'review') {
    const primary = firstReady(providers, ['codex_cli', 'claude_cli', 'grok_api', 'openai_api', 'deepseek_api', 'github_copilot_cloud'], input);
    if (primary) {
      return decision(
        primary,
        intent === 'code_implementation'
          ? 'Normal code implementation prefers codex_cli when ready.'
          : `Task intent ${intent} routed to first ready invokable provider.`,
        {},
        alternatives,
      );
    }
  }

  // Fallback: any ready direct provider except chatgpt_handoff.
  const anyReady = firstReady(
    providers,
    providers.filter((p) => p.kind !== 'handoff_only').map((p) => p.providerId),
    input,
  );
  if (anyReady) {
    return decision(anyReady, 'Fallback to first ready invokable provider.', {}, alternatives);
  }

  // No invokable provider → handoff_ready path (chatgpt_handoff is never directDispatch).
  if (chatHandoff) {
    return {
      selectedProviderId: 'chatgpt_handoff',
      selectedProvider: chatHandoff,
      reason: 'No invokable provider available; produce ChatGPT handoff continuation packet.',
      directDispatch: false,
      handoffOnly: true,
      waitForUser: false,
      approvalState: 'approval_not_required',
      alternatives,
    };
  }

  return decision(null, 'No providers available.', { handoffOnly: true }, alternatives);
}

export function previewExecutorRoute(input: ExecutorRouteInput): ExecutorRouteDecision {
  return routeExecutor(input);
}

export function providerReadyForDirectDispatch(
  status: ProviderStatus,
  kind: ProviderDescriptor['kind'],
  directDispatch: boolean,
): boolean {
  return directDispatch && status === 'ready' && kind !== 'handoff_only';
}
