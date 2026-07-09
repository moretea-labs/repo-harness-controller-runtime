import type { SuggestedNextAction, VerificationOutcome } from './types';

export interface CheckDefinitionLike {
  id: string;
}

export interface NormalizedCheckIds {
  validCheckIds: string[];
  invalidCheckIds: string[];
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
}

export interface ClassifyVerificationInput {
  checkId: string;
  available: readonly CheckDefinitionLike[];
  /** True when the check process/runtime itself failed before producing a pass/fail. */
  infrastructureFailed?: boolean;
  /** True when the registered check ran and failed acceptance. */
  checkFailed?: boolean;
  /** True when intentionally skipped. */
  skipped?: boolean;
  /** Prior invalid/infrastructure outcome id that this valid result supersedes. */
  supersedes?: string;
}

export interface ClassifiedVerification {
  checkId: string;
  normalizedCheckId?: string;
  outcome: VerificationOutcome;
  isAcceptanceFailure: boolean;
  isInfrastructureIssue: boolean;
  summary: string;
  warnings: string[];
}

function aliasesFor(availableIds: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const id of availableIds) {
    aliases.set(id, id);
    if (id.startsWith('package:')) aliases.set(id.slice('package:'.length), id);
  }
  const preferred: Array<[string, string[]]> = [
    ['typecheck', ['package:check:type', 'package:typecheck', 'package:check:types']],
    ['type', ['package:check:type', 'package:typecheck']],
    ['test', ['package:test', 'package:test:bun']],
    ['tests', ['package:test', 'package:test:bun']],
    ['lint', ['package:lint', 'package:check:lint']],
    ['controller-v8', ['package:check:controller-v8']],
    ['docs', ['package:check:docs', 'check:docs']],
  ];
  for (const [alias, candidates] of preferred) {
    const match = candidates.find((candidate) => availableIds.includes(candidate));
    if (match) aliases.set(alias, match);
  }
  return aliases;
}

export function normalizeCheckId(input: string, available: readonly CheckDefinitionLike[]): string | undefined {
  const availableIds = available.map((check) => check.id);
  const aliasMap = aliasesFor(availableIds);
  const requestedId = String(input).trim();
  if (!requestedId) return undefined;
  return aliasMap.get(requestedId);
}

export function validateCheckIdAgainstRegistry(
  checkId: string,
  available: readonly CheckDefinitionLike[],
): { valid: boolean; normalizedCheckId?: string; warning?: string } {
  const normalized = normalizeCheckId(checkId, available);
  if (normalized) return { valid: true, normalizedCheckId: normalized };
  return {
    valid: false,
    warning: `invalid_check_id: ${checkId} is not registered; it is classified as verification infrastructure metadata, not an actual check failure.`,
  };
}

export function normalizeCheckIds(
  requested: readonly string[],
  available: readonly CheckDefinitionLike[],
): NormalizedCheckIds {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of requested) {
    const validation = validateCheckIdAgainstRegistry(raw, available);
    if (validation.valid && validation.normalizedCheckId) valid.push(validation.normalizedCheckId);
    else if (String(raw).trim()) invalid.push(String(raw).trim());
  }
  const validCheckIds = [...new Set(valid)];
  const invalidCheckIds = [...new Set(invalid)];
  const warnings = invalidCheckIds.map((id) => `invalid_check_id: ${id} is not registered; it is classified as verification infrastructure metadata, not an actual check failure.`);
  return {
    validCheckIds,
    invalidCheckIds,
    warnings,
    suggestedNextActions: validCheckIds.map((checkId) => ({
      label: `Run ${checkId}`,
      tool: 'rh_work',
      operation: 'verify',
      payload: { check_id: checkId },
      risk: 'workspace_write',
      confidence: 'high',
      reason: 'Check id exists in the repository check registry.',
    })),
  };
}

/**
 * Classify a verification attempt.
 * invalid_check_id and infrastructure_failure must never be treated as acceptance failures.
 * A later valid_pass can supersede prior invalid/infrastructure noise.
 */
export function classifyVerificationOutcome(input: ClassifyVerificationInput): ClassifiedVerification {
  const validation = validateCheckIdAgainstRegistry(input.checkId, input.available);
  if (!validation.valid) {
    return {
      checkId: input.checkId,
      outcome: 'invalid_check_id',
      isAcceptanceFailure: false,
      isInfrastructureIssue: true,
      summary: `Check id ${input.checkId} is not registered.`,
      warnings: validation.warning ? [validation.warning] : [],
    };
  }

  const normalizedCheckId = validation.normalizedCheckId!;
  if (input.skipped) {
    return {
      checkId: input.checkId,
      normalizedCheckId,
      outcome: 'skipped',
      isAcceptanceFailure: false,
      isInfrastructureIssue: false,
      summary: `Check ${normalizedCheckId} was skipped.`,
      warnings: [],
    };
  }

  if (input.infrastructureFailed) {
    return {
      checkId: input.checkId,
      normalizedCheckId,
      outcome: 'infrastructure_failure',
      isAcceptanceFailure: false,
      isInfrastructureIssue: true,
      summary: `Infrastructure failed while running ${normalizedCheckId}; this is not an acceptance failure.`,
      warnings: ['infrastructure_failure is distinct from acceptance failure and should not request task changes by itself.'],
    };
  }

  if (input.supersedes) {
    return {
      checkId: input.checkId,
      normalizedCheckId,
      outcome: input.checkFailed ? 'valid_fail' : 'valid_pass',
      isAcceptanceFailure: input.checkFailed === true,
      isInfrastructureIssue: false,
      summary: input.checkFailed
        ? `Check ${normalizedCheckId} failed acceptance and supersedes prior verification noise.`
        : `Check ${normalizedCheckId} passed and supersedes prior verification noise (${input.supersedes}).`,
      warnings: [],
    };
  }

  if (input.checkFailed) {
    return {
      checkId: input.checkId,
      normalizedCheckId,
      outcome: 'valid_fail',
      isAcceptanceFailure: true,
      isInfrastructureIssue: false,
      summary: `Check ${normalizedCheckId} failed acceptance criteria.`,
      warnings: [],
    };
  }

  return {
    checkId: input.checkId,
    normalizedCheckId,
    outcome: 'valid_pass',
    isAcceptanceFailure: false,
    isInfrastructureIssue: false,
    summary: `Check ${normalizedCheckId} passed.`,
    warnings: [],
  };
}

export function markSupersededOutcome(outcome: VerificationOutcome): VerificationOutcome {
  if (outcome === 'invalid_check_id' || outcome === 'infrastructure_failure' || outcome === 'skipped') {
    return 'superseded';
  }
  return outcome;
}

/**
 * Reconcile verification history: a later valid_pass can supersede older invalid/infrastructure records
 * for the same normalized check id. Invalid check ids never count as acceptance failures.
 */
export function reconcileVerificationHistory(
  records: ReadonlyArray<{ checkId: string; outcome: VerificationOutcome; recordedAt: string }>,
): {
  acceptanceFailures: string[];
  infrastructureIssues: string[];
  invalidCheckIds: string[];
  validPasses: string[];
  effectiveOutcomes: Array<{ checkId: string; outcome: VerificationOutcome }>;
} {
  const byCheck = new Map<string, { checkId: string; outcome: VerificationOutcome; recordedAt: string }>();
  for (const record of [...records].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    const previous = byCheck.get(record.checkId);
    if (
      previous
      && (previous.outcome === 'invalid_check_id' || previous.outcome === 'infrastructure_failure')
      && (record.outcome === 'valid_pass' || record.outcome === 'valid_fail')
    ) {
      byCheck.set(record.checkId, { ...record, outcome: record.outcome });
      continue;
    }
    byCheck.set(record.checkId, record);
  }

  const effectiveOutcomes = [...byCheck.values()].map((entry) => ({ checkId: entry.checkId, outcome: entry.outcome }));
  return {
    acceptanceFailures: effectiveOutcomes.filter((entry) => entry.outcome === 'valid_fail').map((entry) => entry.checkId),
    infrastructureIssues: effectiveOutcomes.filter((entry) => entry.outcome === 'infrastructure_failure').map((entry) => entry.checkId),
    invalidCheckIds: effectiveOutcomes.filter((entry) => entry.outcome === 'invalid_check_id').map((entry) => entry.checkId),
    validPasses: effectiveOutcomes.filter((entry) => entry.outcome === 'valid_pass').map((entry) => entry.checkId),
    effectiveOutcomes,
  };
}
