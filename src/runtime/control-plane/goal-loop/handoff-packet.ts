import { mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../../shared/json-files';
import { redactProviderSummary } from './provider-registry';
import type {
  GoalContract,
  GoalHandoffPacket,
  GoalHandoffPacketStore,
} from './types';

export interface HandoffPacketStoreLocation {
  controllerHome?: string;
  repoId?: string;
  root?: string;
}

export interface HandoffPacketStoreOptions extends HandoffPacketStoreLocation {
  now?: () => string;
}

function nowIso(options: HandoffPacketStoreOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

export function handoffPacketRoot(location: HandoffPacketStoreLocation): string {
  if (location.root) {
    mkdirSync(location.root, { recursive: true });
    return location.root;
  }
  if (!location.controllerHome || !location.repoId) {
    throw new Error('handoff packet store requires either root or controllerHome + repoId');
  }
  const root = join(repositoryControllerRoot(location.controllerHome, location.repoId), 'goal-handoff-packets');
  mkdirSync(root, { recursive: true });
  return root;
}

export function handoffPacketStorePath(location: HandoffPacketStoreLocation): string {
  return join(handoffPacketRoot(location), 'index.json');
}

export function emptyHandoffPacketStore(updatedAt: string): GoalHandoffPacketStore {
  return { schemaVersion: 1, updatedAt, packets: [] };
}

export function readHandoffPacketStore(options: HandoffPacketStoreOptions): GoalHandoffPacketStore {
  return readJsonFile<GoalHandoffPacketStore>(
    handoffPacketStorePath(options),
    emptyHandoffPacketStore(nowIso(options)),
  );
}

export function writeHandoffPacketStore(
  options: HandoffPacketStoreOptions,
  store: GoalHandoffPacketStore,
): GoalHandoffPacketStore {
  writeJsonAtomic(handoffPacketStorePath(options), store);
  return store;
}

export interface CreateHandoffPacketInput {
  goal: GoalContract;
  blockers?: string[];
  lastEvidence?: Array<{ title: string; summary?: string }>;
  currentDiffSummary?: string;
  nextSafeActions?: string[];
  recommendedProvider?: string;
  requiredUserDecision?: string;
  exactToolCallsSuggested?: GoalHandoffPacket['exactToolCallsSuggested'];
  completedSteps?: string[];
}

export function createGoalHandoffPacket(
  options: HandoffPacketStoreOptions,
  input: CreateHandoffPacketInput,
): GoalHandoffPacket {
  const at = nowIso(options);
  const goal = input.goal;
  const packetId = `pkt-${sanitizeFileComponent(goal.goalId).slice(0, 24)}-${randomUUID().slice(0, 8)}`;

  const completedSteps =
    input.completedSteps
    ?? goal.transitionHistory
      .filter((entry) => entry.to !== entry.from)
      .map((entry) => `${entry.from}->${entry.to}: ${entry.reason}`)
      .slice(-20);

  const packet: GoalHandoffPacket = {
    schemaVersion: 1,
    packetId,
    goalId: goal.goalId,
    repoId: goal.repoId,
    objective: goal.objective.slice(0, 2_000),
    currentState: {
      status: goal.status,
      currentStep: goal.currentStep,
      lastProviderId: goal.lastProviderId,
      waitingReason: goal.waitingReason,
    },
    completedSteps: completedSteps.slice(0, 30),
    blockers: (input.blockers ?? (goal.waitingReason ? [goal.waitingReason] : [])).slice(0, 20),
    lastEvidence: (input.lastEvidence
      ?? goal.artifacts.map((artifact) => ({
        title: artifact.title,
        summary: artifact.summary,
      }))).slice(0, 20),
    currentDiffSummary: input.currentDiffSummary?.slice(0, 1_000),
    nextSafeActions: (input.nextSafeActions
      ?? (goal.nextSafeAction ? [goal.nextSafeAction] : ['Review goal status', 'Approve or continue with an invokable provider']))
      .slice(0, 15),
    recommendedProvider: input.recommendedProvider ?? 'chatgpt_handoff',
    requiredUserDecision: input.requiredUserDecision,
    exactToolCallsSuggested: (input.exactToolCallsSuggested ?? [
      {
        tool: 'goal_status',
        payload: { goal_id: goal.goalId },
        risk: 'readonly',
      },
      {
        tool: 'goal_continue',
        payload: { goal_id: goal.goalId },
        risk: 'workspace_write',
      },
    ]).slice(0, 10),
    constraints: goal.constraints,
    acceptanceCriteria: goal.acceptanceCriteria.slice(0, 20),
    timestamp: at,
    redacted: true,
  };

  // Defense-in-depth: never persist secret-like substrings.
  const sanitized = redactProviderSummary(packet) as GoalHandoffPacket;
  sanitized.redacted = true;

  const store = readHandoffPacketStore(options);
  store.packets = [sanitized, ...store.packets].slice(0, 100);
  store.updatedAt = at;
  writeHandoffPacketStore(options, store);
  return sanitized;
}

export function getGoalHandoffPacket(
  options: HandoffPacketStoreOptions,
  packetId: string,
): GoalHandoffPacket | undefined {
  const id = sanitizeFileComponent(packetId);
  return readHandoffPacketStore(options).packets.find((packet) => packet.packetId === id || packet.packetId === packetId);
}

export function listGoalHandoffPackets(
  options: HandoffPacketStoreOptions & { goalId?: string; limit?: number },
): GoalHandoffPacket[] {
  let packets = readHandoffPacketStore(options).packets;
  if (options.goalId) {
    packets = packets.filter((packet) => packet.goalId === options.goalId);
  }
  return packets.slice(0, options.limit ?? 20);
}
