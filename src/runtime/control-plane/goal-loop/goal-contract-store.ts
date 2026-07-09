import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import {
  type GoalArtifactRef,
  type GoalContract,
  type GoalContractStore,
  type GoalConstraints,
  type GoalMode,
  type GoalStatus,
  type GoalTransitionEvidence,
  type GoalVerificationPolicy,
  isTerminalGoalStatus,
} from './types';

export interface GoalContractStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface GoalContractStoreOptions extends GoalContractStoreLocation {
  now?: () => string;
}

function nowIso(options: GoalContractStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function goalContractRoot(location: GoalContractStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome || !location.repoId) {
    throw new Error('goal contract store requires either root or controllerHome + repoId');
  }
  const root = join(repositoryControllerRoot(location.controllerHome, location.repoId), 'goal-contracts');
  mkdirSync(root, { recursive: true });
  return root;
}

export function goalContractStorePath(location: GoalContractStoreLocation): string {
  return join(goalContractRoot(location), 'index.json');
}

export function emptyGoalContractStore(updatedAt: string): GoalContractStore {
  return { schemaVersion: 1, updatedAt, goals: [] };
}

export function readGoalContractStore(options: GoalContractStoreOptions): GoalContractStore {
  return readJsonFile<GoalContractStore>(goalContractStorePath(options), emptyGoalContractStore(nowIso(options)));
}

export function writeGoalContractStore(options: GoalContractStoreOptions, store: GoalContractStore): GoalContractStore {
  writeJsonAtomic(goalContractStorePath(options), store);
  return store;
}

function defaultVerificationPolicy(): GoalVerificationPolicy {
  return {
    requiredCheckIds: [],
    requirePassingEvidence: true,
    maxInfrastructureRetries: 3,
  };
}

function defaultConstraints(): GoalConstraints {
  return {
    requireHandoffOnAmbiguity: true,
    allowPush: false,
    allowDestructive: false,
    allowExternalWrite: false,
  };
}

export interface CreateGoalContractInput {
  goalId?: string;
  repoId: string;
  title: string;
  objective: string;
  mode?: GoalMode;
  status?: GoalStatus;
  currentStep?: string;
  issueId?: string;
  taskIds?: string[];
  constraints?: GoalConstraints;
  allowedExecutors?: string[];
  forbiddenExecutors?: string[];
  requiredApprovals?: string[];
  acceptanceCriteria?: string[];
  verificationPolicy?: Partial<GoalVerificationPolicy>;
  retryBudget?: number;
  repairAttempts?: number;
  lastProviderId?: string;
  lastFailureClass?: GoalContract['lastFailureClass'];
  artifacts?: GoalArtifactRef[];
}

function goalIdFor(title: string, explicit?: string): string {
  if (explicit?.trim()) return sanitizeFileComponent(explicit.trim());
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'goal';
  return `goal-${slug}-${randomUUID().slice(0, 8)}`;
}

export function createGoalContract(
  options: GoalContractStoreOptions,
  input: CreateGoalContractInput,
): GoalContract {
  const at = nowIso(options);
  const goalId = goalIdFor(input.title, input.goalId);
  const store = readGoalContractStore(options);
  if (store.goals.some((goal) => goal.goalId === goalId)) {
    throw new Error(`GOAL_ALREADY_EXISTS: ${goalId}`);
  }

  const goal: GoalContract = {
    schemaVersion: 1,
    goalId,
    repoId: input.repoId,
    title: input.title.slice(0, 200),
    objective: input.objective.slice(0, 4_000),
    mode: input.mode ?? 'supervised',
    status: input.status ?? 'created',
    currentStep: input.currentStep ?? 'created',
    issueId: input.issueId,
    taskIds: (input.taskIds ?? []).slice(0, 50),
    constraints: { ...defaultConstraints(), ...input.constraints },
    allowedExecutors: (input.allowedExecutors ?? []).slice(0, 20),
    forbiddenExecutors: (input.forbiddenExecutors ?? []).slice(0, 20),
    requiredApprovals: (input.requiredApprovals ?? []).slice(0, 20),
    acceptanceCriteria: (input.acceptanceCriteria ?? []).slice(0, 30).map((item) => item.slice(0, 500)),
    verificationPolicy: { ...defaultVerificationPolicy(), ...input.verificationPolicy },
    retryBudget: input.retryBudget ?? 5,
    repairAttempts: input.repairAttempts ?? 0,
    lastProviderId: input.lastProviderId,
    lastFailureClass: input.lastFailureClass,
    artifacts: (input.artifacts ?? []).slice(0, 50),
    handoffPacketIds: [],
    transitionHistory: [
      {
        from: 'created',
        to: input.status ?? 'created',
        reason: 'GoalContract created',
        at,
      },
    ],
    createdAt: at,
    updatedAt: at,
  };

  store.goals = [goal, ...store.goals.filter((entry) => entry.goalId !== goalId)];
  store.updatedAt = at;
  writeGoalContractStore(options, store);
  return goal;
}

export function getGoalContract(options: GoalContractStoreOptions, goalId: string): GoalContract | undefined {
  const id = sanitizeFileComponent(goalId);
  return readGoalContractStore(options).goals.find((goal) => goal.goalId === id);
}

export interface ListGoalOptions extends GoalContractStoreOptions {
  status?: GoalStatus | 'active' | 'all';
  limit?: number;
}

export function listGoalContracts(options: ListGoalOptions): GoalContract[] {
  const store = readGoalContractStore(options);
  let goals = store.goals;
  if (options.status === 'active') {
    goals = goals.filter((goal) => !isTerminalGoalStatus(goal.status));
  } else if (options.status && options.status !== 'all') {
    goals = goals.filter((goal) => goal.status === options.status);
  }
  const limit = options.limit ?? 50;
  return goals.slice(0, limit);
}

export function listActiveGoalContracts(options: GoalContractStoreOptions): GoalContract[] {
  return listGoalContracts({ ...options, status: 'active' });
}

export type UpdateGoalContractPatch = Partial<
  Omit<GoalContract, 'schemaVersion' | 'goalId' | 'repoId' | 'createdAt'>
> & {
  appendTransition?: GoalTransitionEvidence;
  appendArtifact?: GoalArtifactRef;
  appendHandoffPacketId?: string;
  appendVerification?: GoalContract['verificationEvidence'] extends (infer U)[] | undefined ? U : never;
};

export function updateGoalContract(
  options: GoalContractStoreOptions,
  goalId: string,
  patch: UpdateGoalContractPatch,
): GoalContract {
  const store = readGoalContractStore(options);
  const id = sanitizeFileComponent(goalId);
  const index = store.goals.findIndex((goal) => goal.goalId === id);
  if (index < 0) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);

  const existing = store.goals[index]!;
  const at = nowIso(options);
  const {
    appendTransition,
    appendArtifact,
    appendHandoffPacketId,
    appendVerification,
    transitionHistory,
    artifacts,
    handoffPacketIds,
    verificationEvidence,
    ...rest
  } = patch;

  const next: GoalContract = {
    ...existing,
    ...rest,
    transitionHistory: [
      ...(transitionHistory ?? existing.transitionHistory),
      ...(appendTransition ? [appendTransition] : []),
    ].slice(-100),
    artifacts: [
      ...(artifacts ?? existing.artifacts),
      ...(appendArtifact ? [appendArtifact] : []),
    ].slice(0, 100),
    handoffPacketIds: [
      ...(handoffPacketIds ?? existing.handoffPacketIds),
      ...(appendHandoffPacketId ? [appendHandoffPacketId] : []),
    ].slice(0, 50),
    verificationEvidence: [
      ...((verificationEvidence ?? existing.verificationEvidence) ?? []),
      ...(appendVerification ? [appendVerification] : []),
    ].slice(-50),
    updatedAt: at,
  };

  store.goals[index] = next;
  store.updatedAt = at;
  writeGoalContractStore(options, store);
  return next;
}

export function transitionGoalStatus(
  options: GoalContractStoreOptions,
  goalId: string,
  to: GoalStatus,
  reason: string,
  extras: {
    providerId?: string;
    failureClass?: GoalContract['lastFailureClass'];
    currentStep?: string;
    waitingReason?: string;
    nextSafeAction?: string;
    lastRunId?: string;
  } = {},
): GoalContract {
  const existing = getGoalContract(options, goalId);
  if (!existing) throw new Error(`GOAL_NOT_FOUND: ${goalId}`);
  const at = nowIso(options);
  return updateGoalContract(options, goalId, {
    status: to,
    currentStep: extras.currentStep ?? to,
    lastProviderId: extras.providerId ?? existing.lastProviderId,
    lastFailureClass: extras.failureClass ?? existing.lastFailureClass,
    waitingReason: extras.waitingReason,
    nextSafeAction: extras.nextSafeAction,
    lastRunId: extras.lastRunId ?? existing.lastRunId,
    appendTransition: {
      from: existing.status,
      to,
      reason: reason.slice(0, 500),
      at,
      providerId: extras.providerId,
      failureClass: extras.failureClass,
    },
  });
}

export function summarizeGoalContract(goal: GoalContract): Record<string, unknown> {
  return {
    goalId: goal.goalId,
    repoId: goal.repoId,
    title: goal.title,
    status: goal.status,
    mode: goal.mode,
    currentStep: goal.currentStep,
    lastProviderId: goal.lastProviderId,
    repairAttempts: goal.repairAttempts,
    retryBudget: goal.retryBudget,
    waitingReason: goal.waitingReason,
    nextSafeAction: goal.nextSafeAction,
    handoffPacketCount: goal.handoffPacketIds.length,
    verificationCount: goal.verificationEvidence?.length ?? 0,
    updatedAt: goal.updatedAt,
  };
}
