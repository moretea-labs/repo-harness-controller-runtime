import { FACADE_TOOLS, type EvidenceRef, type FacadeTool, type SuggestedNextAction } from './types';

function expectedActionRisk(action: SuggestedNextAction): SuggestedNextAction['risk'] | undefined {
  if (action.tool !== 'rh_work') return undefined;
  switch (action.operation) {
    case 'start':
    case 'continue':
    case 'verify':
    case 'repair':
    case 'stop':
    case 'delegate':
      return 'workspace_write';
    case 'finalize':
      return 'local_repo_write';
    default:
      return undefined;
  }
}

const ALLOWED_FACADE_OPERATIONS: Record<FacadeTool, readonly string[]> = {
  rh_access: ['get', 'preview', 'set'],
  rh_status: ['list', 'get', 'repair'],
  rh_inbox: ['list', 'get', 'ack', 'resolve', 'dismiss', 'create'],
  rh_context: ['list', 'get'],
  rh_work: ['start', 'continue', 'verify', 'repair', 'finalize', 'stop', 'delegate'],
};

export interface SuggestedActionValidationOptions {
  validCheckIds?: readonly string[];
  evidenceRefs?: readonly EvidenceRef[];
  validHandoffIds?: readonly string[];
  validWorkIds?: readonly string[];
}

export interface SuggestedActionValidationResult {
  actions: SuggestedNextAction[];
  warnings: string[];
}

function actionUsesKnownCheck(action: SuggestedNextAction, validCheckIds: readonly string[] | undefined): boolean {
  if (!validCheckIds || validCheckIds.length === 0) return true;
  const checkId = action.payload && typeof action.payload.check_id === 'string' ? action.payload.check_id : undefined;
  return !checkId || validCheckIds.includes(checkId);
}

function actionUsesKnownHandoff(action: SuggestedNextAction, validHandoffIds: readonly string[] | undefined): boolean {
  if (!validHandoffIds || validHandoffIds.length === 0) return true;
  const handoffId = action.payload && typeof action.payload.handoff_id === 'string' ? action.payload.handoff_id : undefined;
  return !handoffId || validHandoffIds.includes(handoffId);
}

function actionUsesKnownWork(action: SuggestedNextAction, validWorkIds: readonly string[] | undefined): boolean {
  if (!validWorkIds || validWorkIds.length === 0) return true;
  const workId = action.payload && typeof action.payload.work_id === 'string' ? action.payload.work_id : undefined;
  return !workId || validWorkIds.includes(workId);
}

export function allowedFacadeOperations(tool: FacadeTool): readonly string[] {
  return ALLOWED_FACADE_OPERATIONS[tool];
}

export function validateSuggestedNextActions(
  actions: readonly SuggestedNextAction[],
  options: SuggestedActionValidationOptions = {},
): SuggestedActionValidationResult {
  const warnings: string[] = [];
  const valid = actions.filter((action) => {
    if (!FACADE_TOOLS.includes(action.tool)) {
      warnings.push(`Dropped suggested action ${action.label}: unsupported facade tool ${String(action.tool)}.`);
      return false;
    }
    if (!ALLOWED_FACADE_OPERATIONS[action.tool].includes(action.operation)) {
      warnings.push(`Dropped suggested action ${action.label}: unsupported ${action.tool}.${action.operation}.`);
      return false;
    }
    if (!actionUsesKnownCheck(action, options.validCheckIds)) {
      warnings.push(`Dropped suggested action ${action.label}: invalid check_id ${String(action.payload?.check_id)}.`);
      return false;
    }
    if (!actionUsesKnownHandoff(action, options.validHandoffIds)) {
      warnings.push(`Dropped suggested action ${action.label}: invalid handoff_id ${String(action.payload?.handoff_id)}.`);
      return false;
    }
    if (!actionUsesKnownWork(action, options.validWorkIds)) {
      warnings.push(`Dropped suggested action ${action.label}: invalid work_id ${String(action.payload?.work_id)}.`);
      return false;
    }
    return true;
  });
  return { actions: valid.slice(0, 8), warnings };
}
