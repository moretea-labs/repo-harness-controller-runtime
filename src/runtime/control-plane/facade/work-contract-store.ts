import { mkdirSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  type EvidenceRef,
  type PolicyDecision,
  type SuggestedNextAction,
  type VerificationRecord,
  type WorkContract,
  type WorkContractStatus,
  type WorkContractStore,
  isTerminalWorkContractStatus,
} from './types';

export interface WorkContractStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface WorkContractStoreOptions extends WorkContractStoreLocation {
  now?: () => string;
}

export type CreateWorkContractInput = Omit<
  WorkContract,
  'schemaVersion' | 'status' | 'createdAt' | 'updatedAt' | 'evidenceRefs' | 'handoffRefs' | 'suggestedNextActions' | 'policyDecisions' | 'checkRefs'
> & {
  status?: WorkContractStatus;
  createdAt?: string;
  updatedAt?: string;
  evidenceRefs?: EvidenceRef[];
  handoffRefs?: string[];
  suggestedNextActions?: SuggestedNextAction[];
  policyDecisions?: PolicyDecision[];
  checkRefs?: VerificationRecord[];
};

export interface ListWorkContractOptions extends WorkContractStoreOptions {
  status?: WorkContractStatus | 'active' | 'all';
  limit?: number;
  detailLevel?: 'summary' | 'detail' | 'raw';
}

export interface WorkContractSummary {
  workId: string;
  repoId: string;
  mode: WorkContract['mode'];
  status: WorkContractStatus;
  objective: string;
  updatedAt: string;
  handoffCount: number;
  evidenceCount: number;
  checkCount: number;
}

function nowIso(options: WorkContractStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function workContractRoot(location: WorkContractStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome || !location.repoId) {
    throw new Error('work contract store requires either root or controllerHome + repoId');
  }
  const root = join(repositoryControllerRoot(location.controllerHome, location.repoId), 'work-contracts');
  mkdirSync(root, { recursive: true });
  return root;
}

export function workContractStorePath(location: WorkContractStoreLocation): string {
  return join(workContractRoot(location), 'index.json');
}

export function emptyWorkContractStore(updatedAt: string): WorkContractStore {
  return { schemaVersion: 1, updatedAt, contracts: [] };
}

export function readWorkContractStore(options: WorkContractStoreOptions): WorkContractStore {
  return readJsonFile<WorkContractStore>(workContractStorePath(options), emptyWorkContractStore(nowIso(options)));
}

export function writeWorkContractStore(options: WorkContractStoreOptions, store: WorkContractStore): WorkContractStore {
  writeJsonAtomic(workContractStorePath(options), store);
  return store;
}

function defaultDriver(mode: WorkContract['mode']): WorkContract['driver'] {
  if (mode === 'direct_control') {
    return { preferred: 'direct_edit', allowWorker: false, allowDirectEdit: true };
  }
  if (mode === 'handoff_only') {
    return { preferred: 'handoff_only', allowWorker: false, allowDirectEdit: false };
  }
  return { preferred: 'isolated_worktree', allowWorker: true, allowDirectEdit: false };
}

export function createWorkContract(options: WorkContractStoreOptions, input: CreateWorkContractInput): WorkContract {
  const at = input.createdAt ?? input.updatedAt ?? nowIso(options);
  const workId = sanitizeFileComponent(input.workId);
  const contract: WorkContract = {
    schemaVersion: 1,
    workId,
    repoId: input.repoId,
    mode: input.mode,
    objective: input.objective.slice(0, 2_000),
    acceptanceCriteria: (input.acceptanceCriteria ?? []).slice(0, 20).map((item) => item.slice(0, 500)),
    constraints: input.constraints ?? { requireHandoffOnAmbiguity: true },
    status: input.status ?? 'pending',
    createdAt: at,
    updatedAt: input.updatedAt ?? at,
    issueId: input.issueId,
    taskId: input.taskId,
    scopeSummary: input.scopeSummary?.slice(0, 1_000),
    allowedPaths: (input.allowedPaths ?? []).slice(0, 50),
    forbiddenPaths: (input.forbiddenPaths ?? []).slice(0, 50),
    checks: (input.checks ?? []).slice(0, 30),
    driver: input.driver ?? defaultDriver(input.mode),
    worktreePolicy: input.worktreePolicy ?? {
      required: input.mode === 'goal_workloop',
      reason: input.mode === 'goal_workloop' ? 'Goal workloop defaults to isolated worktree execution.' : undefined,
    },
    evidencePolicy: input.evidencePolicy ?? {
      defaultDetailLevel: 'summary',
      allowRawOptIn: true,
      maxEvidenceRefs: 20,
    },
    approvalPolicy: input.approvalPolicy ?? { required: false, reasons: [], confirmed: false },
    recoveryPolicy: input.recoveryPolicy ?? {
      allowSelfHealing: true,
      maxInfrastructureRetries: 3,
      handoffOnAmbiguity: true,
    },
    requestedBy: input.requestedBy ?? 'chatgpt',
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, 20),
    handoffRefs: (input.handoffRefs ?? []).slice(0, 20),
    suggestedNextActions: (input.suggestedNextActions ?? []).slice(0, 8),
    policyDecisions: (input.policyDecisions ?? []).slice(0, 20),
    checkRefs: (input.checkRefs ?? []).slice(0, 50),
    continuationPrompt: input.continuationPrompt?.slice(0, 2_000),
    worktreeRef: input.worktreeRef,
    workerRef: input.workerRef,
  };

  const store = readWorkContractStore(options);
  if (store.contracts.some((existing) => existing.workId === contract.workId)) {
    throw new Error(`work contract already exists: ${contract.workId}`);
  }
  const nextStore: WorkContractStore = {
    schemaVersion: 1,
    updatedAt: contract.updatedAt,
    contracts: [contract, ...store.contracts],
  };
  writeWorkContractStore(options, nextStore);
  return contract;
}

export function listWorkContracts(options: ListWorkContractOptions): WorkContract[] {
  const store = readWorkContractStore(options);
  const status = options.status ?? 'active';
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 100));
  return store.contracts
    .filter((contract) => {
      if (status === 'all') return true;
      if (status === 'active') return !isTerminalWorkContractStatus(contract.status);
      return contract.status === status;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export function getWorkContract(options: WorkContractStoreOptions, workId: string): WorkContract | undefined {
  const sanitizedId = sanitizeFileComponent(workId);
  return readWorkContractStore(options).contracts.find((contract) => contract.workId === sanitizedId);
}

export function summarizeWorkContract(contract: WorkContract): WorkContractSummary {
  return {
    workId: contract.workId,
    repoId: contract.repoId,
    mode: contract.mode,
    status: contract.status,
    objective: contract.objective.slice(0, 240),
    updatedAt: contract.updatedAt,
    handoffCount: contract.handoffRefs.length,
    evidenceCount: contract.evidenceRefs.length,
    checkCount: contract.checkRefs.length,
  };
}

export function updateWorkContract(
  options: WorkContractStoreOptions,
  workId: string,
  patch: Partial<Omit<WorkContract, 'schemaVersion' | 'workId' | 'repoId' | 'createdAt'>>,
): WorkContract {
  const sanitizedId = sanitizeFileComponent(workId);
  const store = readWorkContractStore(options);
  const index = store.contracts.findIndex((contract) => contract.workId === sanitizedId);
  if (index < 0) throw new Error(`work contract not found: ${sanitizedId}`);
  const at = nowIso(options);
  const current = store.contracts[index];
  const next: WorkContract = {
    ...current,
    ...patch,
    workId: current.workId,
    repoId: current.repoId,
    createdAt: current.createdAt,
    updatedAt: at,
    evidenceRefs: (patch.evidenceRefs ?? current.evidenceRefs).slice(0, current.evidencePolicy.maxEvidenceRefs),
    handoffRefs: (patch.handoffRefs ?? current.handoffRefs).slice(0, 20),
    suggestedNextActions: (patch.suggestedNextActions ?? current.suggestedNextActions).slice(0, 8),
    policyDecisions: (patch.policyDecisions ?? current.policyDecisions).slice(0, 20),
    checkRefs: (patch.checkRefs ?? current.checkRefs).slice(0, 50),
    objective: (patch.objective ?? current.objective).slice(0, 2_000),
    continuationPrompt: (patch.continuationPrompt ?? current.continuationPrompt)?.slice(0, 2_000),
  };
  const contracts = [...store.contracts];
  contracts[index] = next;
  writeWorkContractStore(options, { schemaVersion: 1, updatedAt: at, contracts });
  return next;
}

export function appendWorkEvidence(
  options: WorkContractStoreOptions,
  workId: string,
  evidence: EvidenceRef,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  return updateWorkContract(options, workId, {
    evidenceRefs: [evidence, ...current.evidenceRefs].slice(0, current.evidencePolicy.maxEvidenceRefs),
  });
}

export function appendWorkHandoffRef(
  options: WorkContractStoreOptions,
  workId: string,
  handoffId: string,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  const handoffRefs = [sanitizeFileComponent(handoffId), ...current.handoffRefs.filter((id) => id !== sanitizeFileComponent(handoffId))].slice(0, 20);
  return updateWorkContract(options, workId, { handoffRefs });
}

export function appendVerificationRecord(
  options: WorkContractStoreOptions,
  workId: string,
  record: VerificationRecord,
): WorkContract {
  const current = getWorkContract(options, workId);
  if (!current) throw new Error(`work contract not found: ${workId}`);
  const checkRefs = [record, ...current.checkRefs].slice(0, 50);
  return updateWorkContract(options, workId, { checkRefs });
}
