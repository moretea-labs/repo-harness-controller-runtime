import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { listActiveLeases } from '../../resources/leases/store';
import { runBoundedGit } from './async-process';

export interface CheckoutMutationGate {
  gateId: string;
  repoId: string;
  checkoutId: string;
  owner: string;
  fencingToken: number;
  baseHead: string | null;
  baseStatusHash: string | null;
  acquiredAt: string;
  expiresAt: string;
  path: string;
}

export interface MutationGateBusy {
  busy: true;
  reason: string;
  blockers: Array<{ kind: 'fast_gate' | 'durable_lease'; owner: string; resourceKey?: string }>;
}

export type MutationGateAcquireResult =
  | { acquired: true; gate: CheckoutMutationGate }
  | MutationGateBusy;

const DEFAULT_TTL_MS = 30_000;

function gateDir(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'mutation-gates');
}

function gatePath(controllerHome: string, repoId: string, checkoutId: string): string {
  const safe = checkoutId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'default';
  return join(gateDir(controllerHome, repoId), `${safe}.json`);
}

async function snapshotHash(repoRoot: string): Promise<{ head: string | null; statusHash: string | null }> {
  const [headResult, statusResult] = await Promise.all([
    runBoundedGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }),
    runBoundedGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**',
    ], {
      timeoutMs: 5_000,
      maxOutputBytes: 128 * 1024,
    }),
  ]);
  const head = headResult.ok ? (headResult.stdout.trim() || null) : null;
  const status = statusResult.ok ? statusResult.stdout : '';
  return {
    head,
    statusHash: createHash('sha256').update(status).digest('hex'),
  };
}

function readGate(path: string): CheckoutMutationGate | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const gate = JSON.parse(readFileSync(path, 'utf8')) as CheckoutMutationGate;
    if (Date.parse(gate.expiresAt) <= Date.now()) {
      rmSync(path, { force: true });
      return undefined;
    }
    return gate;
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }
}

function durableWriteBlockers(controllerHome: string, repoId: string, checkoutId: string): MutationGateBusy['blockers'] {
  const active = listActiveLeases(controllerHome, repoId);
  const blockers: MutationGateBusy['blockers'] = [];
  for (const lease of active) {
    const key = lease.resourceKey;
    const writeMode = lease.mode === 'write' || lease.mode === 'exclusive';
    if (!writeMode) continue;
    const hitsCheckout = key === `workspace:${checkoutId}`
      || key === 'repo-content:*'
      || key.startsWith('path:')
      || key.startsWith('workspace:')
      || key.startsWith('git-ref:');
    if (hitsCheckout) {
      blockers.push({
        kind: 'durable_lease',
        owner: lease.ownerJobId,
        resourceKey: key,
      });
    }
  }
  return blockers;
}

/**
 * Shared checkout mutation ownership for Fast Path and coordination with Durable leases.
 * Does not create ExecutionJob; uses the same conceptual resource keys as durable workspace writes.
 */
export async function acquireCheckoutMutationGate(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  owner: string;
  ttlMs?: number;
}): Promise<MutationGateAcquireResult> {
  const path = gatePath(input.controllerHome, input.repoId, input.checkoutId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const durable = durableWriteBlockers(input.controllerHome, input.repoId, input.checkoutId);
  if (durable.length > 0) {
    return {
      busy: true,
      reason: 'durable_writer_active',
      blockers: durable,
    };
  }

  const existing = readGate(path);
  if (existing && existing.owner !== input.owner) {
    return {
      busy: true,
      reason: 'fast_mutation_active',
      blockers: [{ kind: 'fast_gate', owner: existing.owner }],
    };
  }

  const snap = await snapshotHash(input.repoRoot);
  const acquiredAt = new Date().toISOString();
  const ttl = Math.max(1_000, input.ttlMs ?? DEFAULT_TTL_MS);
  const gate: CheckoutMutationGate = {
    gateId: `mg_${Date.now()}_${randomUUID().slice(0, 8)}`,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    owner: input.owner,
    fencingToken: Date.now(),
    baseHead: snap.head,
    baseStatusHash: snap.statusHash,
    acquiredAt,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    path,
  };

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(gate, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    // Exclusive create when possible
    if (existsSync(path) && !existing) {
      const raced = readGate(path);
      if (raced && raced.owner !== input.owner) {
        rmSync(temporary, { force: true });
        return {
          busy: true,
          reason: 'fast_mutation_active',
          blockers: [{ kind: 'fast_gate', owner: raced.owner }],
        };
      }
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* ignore */
    }
    const raced = readGate(path);
    if (raced && raced.owner !== input.owner) {
      return {
        busy: true,
        reason: 'fast_mutation_active',
        blockers: [{ kind: 'fast_gate', owner: raced.owner }],
      };
    }
    throw error;
  }

  // Re-check durable after acquire to reduce race window.
  const durableAfter = durableWriteBlockers(input.controllerHome, input.repoId, input.checkoutId);
  if (durableAfter.length > 0) {
    releaseCheckoutMutationGate(input.controllerHome, input.repoId, input.checkoutId, gate.gateId);
    return {
      busy: true,
      reason: 'durable_writer_active',
      blockers: durableAfter,
    };
  }

  return { acquired: true, gate };
}

export function releaseCheckoutMutationGate(
  controllerHome: string,
  repoId: string,
  checkoutId: string,
  gateId?: string,
): void {
  const path = gatePath(controllerHome, repoId, checkoutId);
  const current = readGate(path);
  if (!current) return;
  if (gateId && current.gateId !== gateId) return;
  rmSync(path, { force: true });
}

export async function withCheckoutMutationGate<T>(
  input: {
    controllerHome: string;
    repoId: string;
    checkoutId: string;
    repoRoot: string;
    owner: string;
    ttlMs?: number;
  },
  operation: (gate: CheckoutMutationGate) => Promise<T>,
): Promise<{ ok: true; value: T; gate: CheckoutMutationGate } | { ok: false; busy: MutationGateBusy }> {
  const acquired = await acquireCheckoutMutationGate(input);
  if (!('acquired' in acquired) || !acquired.acquired) {
    return { ok: false, busy: acquired as MutationGateBusy };
  }
  try {
    const value = await operation(acquired.gate);
    return { ok: true, value, gate: acquired.gate };
  } finally {
    releaseCheckoutMutationGate(input.controllerHome, input.repoId, input.checkoutId, acquired.gate.gateId);
  }
}

export function mutationGateBusyMessage(busy: MutationGateBusy): string {
  const owners = busy.blockers.map((entry) => entry.owner).join(', ');
  return `${busy.reason}: active writers=[${owners}]`;
}
