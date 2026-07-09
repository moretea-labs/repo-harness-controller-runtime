import type { SuggestedNextAction } from './types';

export interface CheckDefinitionLike {
  id: string;
}

export interface NormalizedCheckIds {
  validCheckIds: string[];
  invalidCheckIds: string[];
  warnings: string[];
  suggestedNextActions: SuggestedNextAction[];
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

export function normalizeCheckIds(
  requested: readonly string[],
  available: readonly CheckDefinitionLike[],
): NormalizedCheckIds {
  const availableIds = available.map((check) => check.id).sort();
  const aliasMap = aliasesFor(availableIds);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of requested) {
    const requestedId = String(raw).trim();
    if (!requestedId) continue;
    const normalized = aliasMap.get(requestedId);
    if (normalized) valid.push(normalized);
    else invalid.push(requestedId);
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
