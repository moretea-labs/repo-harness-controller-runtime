import type { EvidenceRef, FacadeDetailLevel, FacadeResult, FacadeStatus, SuggestedNextAction } from './types';
import { validateSuggestedNextActions } from './suggested-actions';

export interface BuildFacadeResultOptions<TData = Record<string, unknown>> {
  status?: FacadeStatus;
  summary: string;
  data: TData;
  evidenceRefs?: EvidenceRef[];
  warnings?: string[];
  suggestedNextActions?: SuggestedNextAction[];
  rawAvailable?: boolean;
  detailLevel?: FacadeDetailLevel;
}

function boundText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function boundRecord(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return boundText(value, depth === 0 ? 4_000 : 1_000);
  if (!value || typeof value !== 'object') return value;
  if (depth >= 5) return '[bounded-depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => boundRecord(entry, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
  return Object.fromEntries(entries.map(([key, entry]) => [key, boundRecord(entry, depth + 1)]));
}

export function buildFacadeResult<TData = Record<string, unknown>>(options: BuildFacadeResultOptions<TData>): FacadeResult<TData> {
  const suggestedNextActions = validateSuggestedNextActions(options.suggestedNextActions ?? []);
  return {
    schemaVersion: 1,
    status: options.status ?? 'ok',
    summary: boundText(options.summary, 1_000),
    data: boundRecord(options.data) as TData,
    evidenceRefs: options.evidenceRefs ?? [],
    warnings: options.warnings ?? [],
    suggestedNextActions: suggestedNextActions.actions,
    rawAvailable: options.rawAvailable ?? false,
    detailLevel: options.detailLevel ?? 'summary',
  };
}
