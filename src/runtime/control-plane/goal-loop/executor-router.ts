import { evaluateGoalPolicyGate, effectFromRisk } from './policy-gates';
import type { RoutingIntentKey } from './config-types';
import type {
  ExecutorRouteDecision,
  ExecutorRouteInput,
  ProviderDescriptor,
  ProviderStatus,
  TaskIntent,
} from './types';

function isReadyDirect(provider: ProviderDescriptor | undefined): boolean {
  return Boolean(
    provider
    && provider.directDispatch
    && provider.status === 'ready'
    && provider.kind !== 'handoff_only'
    && provider.providerId !== 'chatgpt_handoff',
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
  // Disabled providers must never be selected for direct dispatch.
  const provider = input.providers.find((entry) => entry.providerId === providerId);
  if (provider?.status === 'disabled') return false;
  return true;
}

function firstReady(
  providers: ProviderDescriptor[],
  candidates: string[],
  input: ExecutorRouteInput,
): ProviderDescriptor | undefined {
  for (const id of candidates) {
    if (!allowedByGoal(id, input)) continue;
    // Handoff-only ids in order lists are skipped for direct dispatch.
    if (id === 'chatgpt_handoff') continue;
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
    directDispatch: provider.directDispatch && provider.kind !== 'handoff_only' && provider.providerId !== 'chatgpt_handoff',
    handoffOnly: provider.kind === 'handoff_only' || provider.status === 'handoff_only' || provider.providerId === 'chatgpt_handoff',
    waitForUser: extras.waitForUser ?? false,
    approvalState: extras.approvalState ?? 'approval_not_required',
    alternatives,
  };
}

const BUILTIN_ORDERS: Record<RoutingIntentKey, string[]> = {
  deterministic_edit: ['direct_edit', 'codex_cli', 'chatgpt_handoff'],
  implementation: ['codex_cli', 'grok_api', 'claude_cli', 'openai_api', 'deepseek_api', 'github_copilot_cloud', 'chatgpt_handoff'],
  repair: ['grok_api', 'claude_cli', 'codex_cli', 'deepseek_api', 'openai_api', 'chatgpt_handoff'],
  planning: ['chatgpt_handoff', 'grok_api', 'openai_api', 'deepseek_api', 'claude_cli'],
  review: ['codex_cli', 'claude_cli', 'grok_api', 'openai_api', 'chatgpt_handoff'],
  browser_planning: ['codex_cli', 'claude_cli', 'grok_api', 'openai_api', 'chatgpt_handoff'],
  ios_analysis: ['codex_cli', 'claude_cli', 'grok_api', 'openai_api', 'chatgpt_handoff'],
  fallback: ['direct_edit', 'codex_cli', 'claude_cli', 'grok_api', 'openai_api', 'deepseek_api', 'github_copilot_cloud', 'chatgpt_handoff'],
};

export function intentToRoutingKey(intent: TaskIntent): RoutingIntentKey {
  switch (intent) {
    case 'deterministic_edit':
      return 'deterministic_edit';
    case 'code_repair':
    case 'verification_repair':
      return 'repair';
    case 'architecture_planning':
      return 'planning';
    case 'review':
      return 'review';
    case 'browser_automation':
      return 'browser_planning';
    case 'ios_build_or_sim':
      return 'ios_analysis';
    case 'code_implementation':
    case 'unknown':
    default:
      return 'implementation';
  }
}

function orderFor(input: ExecutorRouteInput, key: RoutingIntentKey): string[] {
  const configured = input.routingConfig?.orders?.[key];
  if (Array.isArray(configured) && configured.length > 0) return configured.map(String);
  return BUILTIN_ORDERS[key];
}

function preferredDefault(input: ExecutorRouteInput, key: RoutingIntentKey): string | undefined {
  const cfg = input.routingConfig;
  if (!cfg) return undefined;
  if (key === 'implementation') return cfg.defaultImplementationProvider;
  if (key === 'repair') return cfg.defaultRepairProvider;
  if (key === 'planning') return cfg.defaultPlanningProvider;
  if (key === 'review') return cfg.defaultReviewProvider;
  if (key === 'browser_planning') return cfg.defaultBrowserPlanningProvider;
  if (key === 'ios_analysis') return cfg.defaultIosAnalysisProvider;
  return undefined;
}

/**
 * Select a provider for the next goal action.
 * Never selects chatgpt_handoff for direct dispatch.
 * Respects routing config order, disabled providers, and tool disable flags (via provider status).
 */
export function routeExecutor(input: ExecutorRouteInput): ExecutorRouteDecision {
  const providers = input.providers;
  const chatHandoff = providers.find((p) => p.providerId === 'chatgpt_handoff');
  const alternatives = providers
    .filter((p) => p.directDispatch && p.status === 'ready' && p.kind !== 'handoff_only')
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
  const routingKey = intentToRoutingKey(intent);

  // Repair path also when last failure classes indicate source issues.
  const forceRepair =
    routingKey === 'repair'
    || failure === 'test_failure'
    || failure === 'typecheck_failure'
    || failure === 'source_defect'
    || (lastProvider === 'codex_cli' && (failure === 'provider_unavailable' || failure === 'unknown'));

  const key: RoutingIntentKey = forceRepair && routingKey !== 'deterministic_edit' ? 'repair' : routingKey;
  let order = orderFor(input, key);

  // Put explicit default at front when configured and not handoff-only for direct intents.
  const def = preferredDefault(input, key);
  if (def && def !== 'chatgpt_handoff') {
    order = [def, ...order.filter((id) => id !== def)];
  }

  const selected = firstReady(providers, order, input);
  if (selected) {
    return decision(
      selected,
      `Routed via ${key} preference order (selected ${selected.providerId}).`,
      {},
      alternatives,
    );
  }

  // Planning without invokable planner → handoff packet.
  if (key === 'planning' && chatHandoff) {
    return decision(chatHandoff, 'No invokable planner ready; ChatGPT handoff packet required.', {
      handoffOnly: true,
      directDispatch: false,
    }, alternatives);
  }

  // Fallback order
  const fallback = firstReady(providers, orderFor(input, 'fallback'), input);
  if (fallback) {
    return decision(fallback, `Fallback order selected ${fallback.providerId}.`, {}, alternatives);
  }

  // No invokable provider → handoff_ready path (chatgpt_handoff is never directDispatch).
  if (chatHandoff) {
    return {
      selectedProviderId: 'chatgpt_handoff',
      selectedProvider: chatHandoff,
      reason: 'No invokable provider available; produce ChatGPT handoff continuation packet instead of dispatching.',
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

/** Validate routing config: handoff-only must not be the only non-fallback direct default. */
export function validateRoutingOrder(order: string[], options: { allowHandoffOnlyAsLast?: boolean } = {}): {
  ok: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const direct = order.filter((id) => id !== 'chatgpt_handoff');
  if (direct.length === 0) {
    warnings.push('Order contains only handoff-only providers; direct dispatch will not run.');
  }
  if (order.includes('chatgpt_handoff') && order[0] === 'chatgpt_handoff' && options.allowHandoffOnlyAsLast !== true) {
    // Allowed for planning; warn for implementation-like orders.
    warnings.push('chatgpt_handoff is first; no direct provider will be tried before handoff.');
  }
  return { ok: true, warnings };
}
