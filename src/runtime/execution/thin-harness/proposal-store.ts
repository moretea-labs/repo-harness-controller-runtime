/**
 * Server-side persistent Patch Proposal store.
 * Integrator trusts proposalId / server record — not client-recomputable digests alone.
 */
import { createHash, randomUUID } from 'crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../../cli/repositories/controller-home';
import { runBoundedGit } from './async-process';
import {
  computePathFingerprintsAsync,
  MAX_DIRTY_PATHS_FOR_FINGERPRINT,
  MAX_FINGERPRINT_FILE_BYTES,
  MAX_FINGERPRINT_TOTAL_BYTES,
} from './fingerprint-worker';

export interface ServerPatchProposal {
  schemaVersion: 1;
  proposalId: string;
  repoId: string;
  checkoutId: string;
  baseSnapshot: {
    head: string | null;
    statusHash: string;
    refsHash?: string;
  };
  readPaths: string[];
  writePaths: string[];
  readPathFingerprints: Record<string, string>;
  writePathFingerprints: Record<string, string>;
  operations: unknown[];
  operationsDigest: string;
  createdAt: string;
  expiresAt: string;
  owner?: string;
  assumptions?: string[];
  riskNotes?: string[];
  suggestedFocusedCheck?: string | string[];
  analysisOnly?: boolean;
  status: 'active' | 'applied' | 'expired' | 'revoked';
}

export interface CreateProposalInput {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  readPaths: string[];
  writePaths: string[];
  operations: unknown[];
  ttlMs?: number;
  owner?: string;
  assumptions?: string[];
  riskNotes?: string[];
  suggestedFocusedCheck?: string | string[];
  analysisOnly?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_PROPOSAL_TTL_MS = 30 * 60_000;
const MAX_PROPOSAL_TTL_MS = 24 * 60 * 60_000;

function proposalDir(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'patch-proposals');
}

function proposalPath(controllerHome: string, repoId: string, proposalId: string): string {
  return join(proposalDir(controllerHome, repoId), `${proposalId}.json`);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\\/g, '/');
}

function writeAtomic(path: string, value: ServerPatchProposal): void {
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readProposalFile(path: string): ServerPatchProposal | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ServerPatchProposal;
  } catch {
    return undefined;
  }
}

async function pathFingerprints(
  repoRoot: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const unique = [...new Set(paths.map(normalizePath).filter(Boolean))].sort();
  if (unique.length === 0) return {};
  if (unique.length > MAX_DIRTY_PATHS_FOR_FINGERPRINT) {
    throw new Error(`PROPOSAL_TOO_MANY_PATHS: ${unique.length} exceeds ${MAX_DIRTY_PATHS_FOR_FINGERPRINT}`);
  }
  const statusByPath = Object.fromEntries(unique.map((path) => [path, [`  ${path}`]]));
  const result = await computePathFingerprintsAsync(
    {
      root: repoRoot,
      paths: unique,
      statusByPath,
      maxFileBytes: MAX_FINGERPRINT_FILE_BYTES,
      maxTotalBytes: MAX_FINGERPRINT_TOTAL_BYTES,
    },
    { signal, timeoutMs: 5_000 },
  );
  return result.pathFingerprints;
}

async function workspaceSnapshot(repoRoot: string, signal?: AbortSignal): Promise<{
  head: string | null;
  statusHash: string;
  refsHash: string;
  status: string;
}> {
  const [headResult, statusResult, refsResult] = await Promise.all([
    runBoundedGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      signal,
    }),
    runBoundedGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).ai/harness/**',
    ], {
      timeoutMs: 8_000,
      maxOutputBytes: 256 * 1024,
      signal,
    }),
    runBoundedGit(repoRoot, ['show-ref'], {
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1024,
      signal,
    }),
  ]);
  if (statusResult.cancelled || headResult.cancelled || refsResult.cancelled) {
    throw new Error('CANCELLED: proposal snapshot aborted');
  }
  if (!statusResult.ok) {
    throw new Error(`PROPOSAL_SNAPSHOT_FAILED: git status ${statusResult.stderr || statusResult.exitCode}`);
  }
  let head: string | null = null;
  if (headResult.ok) {
    head = headResult.stdout.trim() || null;
  } else {
    const unborn = headResult.exitCode === 128
      && /unknown revision|bad revision|Needed a single revision|ambiguous argument|not a valid object name/i.test(headResult.stderr);
    if (!unborn) {
      throw new Error(`PROPOSAL_SNAPSHOT_FAILED: git rev-parse ${headResult.stderr || headResult.exitCode}`);
    }
  }
  let refs = '';
  if (refsResult.ok) {
    refs = refsResult.stdout;
  } else if (refsResult.exitCode === 1 && !refsResult.stderr.trim()) {
    refs = refsResult.stdout;
  } else {
    throw new Error(`PROPOSAL_SNAPSHOT_FAILED: git show-ref ${refsResult.stderr || refsResult.exitCode}`);
  }
  return {
    head,
    statusHash: createHash('sha256').update(statusResult.stdout).digest('hex'),
    refsHash: createHash('sha256').update(refs).digest('hex'),
    status: statusResult.stdout,
  };
}

export async function createServerPatchProposal(input: CreateProposalInput): Promise<ServerPatchProposal> {
  const dir = proposalDir(input.controllerHome, input.repoId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ttlMs = Math.max(30_000, Math.min(input.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS, MAX_PROPOSAL_TTL_MS));
  const beforeSnapshot = await workspaceSnapshot(input.repoRoot, input.signal);
  const [readPathFingerprints, writePathFingerprints] = await Promise.all([
    pathFingerprints(input.repoRoot, input.readPaths, input.signal),
    pathFingerprints(input.repoRoot, input.writePaths, input.signal),
  ]);
  const afterSnapshot = await workspaceSnapshot(input.repoRoot, input.signal);
  if (
    beforeSnapshot.head !== afterSnapshot.head
    || beforeSnapshot.statusHash !== afterSnapshot.statusHash
    || beforeSnapshot.refsHash !== afterSnapshot.refsHash
  ) {
    throw new Error('PROPOSAL_WORKSPACE_CHANGED_DURING_CAPTURE: retry against a stable workspace snapshot');
  }
  const snap = afterSnapshot;
  const proposalId = `prop_${Date.now().toString(36)}_${randomUUID().slice(0, 10)}`;
  const operationsDigest = digest(input.operations);
  const now = new Date().toISOString();
  const proposal: ServerPatchProposal = {
    schemaVersion: 1,
    proposalId,
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    baseSnapshot: {
      head: snap.head,
      statusHash: snap.statusHash,
      refsHash: snap.refsHash,
    },
    readPaths: input.readPaths.map(normalizePath),
    writePaths: input.writePaths.map(normalizePath),
    readPathFingerprints,
    writePathFingerprints,
    operations: input.operations,
    operationsDigest,
    createdAt: now,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    owner: input.owner,
    assumptions: input.assumptions,
    riskNotes: input.riskNotes,
    suggestedFocusedCheck: input.suggestedFocusedCheck,
    analysisOnly: input.analysisOnly === true,
    status: 'active',
  };
  const path = proposalPath(input.controllerHome, input.repoId, proposalId);
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  return proposal;
}

export function readServerPatchProposal(
  controllerHome: string,
  repoId: string,
  proposalId: string,
): ServerPatchProposal | undefined {
  return readProposalFile(proposalPath(controllerHome, repoId, proposalId));
}

export function listServerPatchProposals(
  controllerHome: string,
  repoId: string,
  limit = 50,
): ServerPatchProposal[] {
  const dir = proposalDir(controllerHome, repoId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readProposalFile(join(dir, name)))
    .filter((entry): entry is ServerPatchProposal => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export function markServerPatchProposalApplied(
  controllerHome: string,
  repoId: string,
  proposalId: string,
): ServerPatchProposal | undefined {
  const path = proposalPath(controllerHome, repoId, proposalId);
  const current = readProposalFile(path);
  if (!current) return undefined;
  const next = { ...current, status: 'applied' as const };
  writeAtomic(path, next);
  return next;
}

export function revokeServerPatchProposal(
  controllerHome: string,
  repoId: string,
  proposalId: string,
): void {
  const path = proposalPath(controllerHome, repoId, proposalId);
  if (existsSync(path)) rmSync(path, { force: true });
}

export type ProposalValidateFailure =
  | { ok: true; proposal: ServerPatchProposal; currentHead: string | null }
  | {
    ok: false;
    code:
      | 'PROPOSAL_NOT_FOUND'
      | 'PROPOSAL_EXPIRED'
      | 'PROPOSAL_CHECKOUT_MISMATCH'
      | 'PROPOSAL_STALE_WORKSPACE'
      | 'PROPOSAL_PATH_FINGERPRINT_MISMATCH'
      | 'PROPOSAL_TAMPERED'
      | 'PROPOSAL_ANALYSIS_ONLY'
      | 'PROPOSAL_ALREADY_APPLIED';
    message: string;
    proposal?: ServerPatchProposal;
  };

/**
 * Re-validate a server proposal immediately before apply.
 */
export async function validateServerPatchProposalForApply(input: {
  controllerHome: string;
  repoId: string;
  checkoutId: string;
  repoRoot: string;
  proposalId: string;
  signal?: AbortSignal;
  /** After an initial full validation under one mutation gate, recheck only the
   * server record and relevant path fingerprints between sequential proposals. */
  skipWorkspaceSnapshot?: boolean;
}): Promise<ProposalValidateFailure> {
  const proposal = readServerPatchProposal(input.controllerHome, input.repoId, input.proposalId);
  if (!proposal) {
    return { ok: false, code: 'PROPOSAL_NOT_FOUND', message: `proposal ${input.proposalId} not found` };
  }
  if (proposal.checkoutId !== input.checkoutId) {
    return {
      ok: false,
      code: 'PROPOSAL_CHECKOUT_MISMATCH',
      message: `proposal bound to checkout ${proposal.checkoutId}, not ${input.checkoutId}`,
      proposal,
    };
  }
  if (proposal.status === 'applied') {
    return {
      ok: false,
      code: 'PROPOSAL_ALREADY_APPLIED',
      message: `proposal ${proposal.proposalId} already applied`,
      proposal,
    };
  }
  if (proposal.analysisOnly) {
    return {
      ok: false,
      code: 'PROPOSAL_ANALYSIS_ONLY',
      message: 'analysis-only proposal cannot be applied',
      proposal,
    };
  }
  if (Date.parse(proposal.expiresAt) <= Date.now() || proposal.status === 'expired') {
    return {
      ok: false,
      code: 'PROPOSAL_EXPIRED',
      message: `proposal expired at ${proposal.expiresAt}`,
      proposal,
    };
  }
  if (digest(proposal.operations) !== proposal.operationsDigest) {
    return {
      ok: false,
      code: 'PROPOSAL_TAMPERED',
      message: 'operations digest mismatch — proposal record may be tampered',
      proposal,
    };
  }

  let currentHead = proposal.baseSnapshot.head;
  if (!input.skipWorkspaceSnapshot) {
    const snap = await workspaceSnapshot(input.repoRoot, input.signal);
    currentHead = snap.head;
    if (proposal.baseSnapshot.head !== snap.head) {
      return {
        ok: false,
        code: 'PROPOSAL_STALE_WORKSPACE',
        message: `HEAD changed expected=${proposal.baseSnapshot.head ?? 'unborn'} actual=${snap.head ?? 'unborn'}`,
        proposal,
      };
    }
    if (proposal.baseSnapshot.statusHash !== snap.statusHash
      || proposal.baseSnapshot.refsHash !== snap.refsHash) {
      return {
        ok: false,
        code: 'PROPOSAL_STALE_WORKSPACE',
        message: 'workspace status or refs changed since proposal creation',
        proposal,
      };
    }
  }

  const paths = [...new Set([...proposal.readPaths, ...proposal.writePaths])];
  const current = await pathFingerprints(input.repoRoot, paths, input.signal);
  for (const path of proposal.readPaths) {
    if ((proposal.readPathFingerprints[path] ?? '') !== (current[path] ?? '')) {
      return {
        ok: false,
        code: 'PROPOSAL_PATH_FINGERPRINT_MISMATCH',
        message: `read path fingerprint changed: ${path}`,
        proposal,
      };
    }
  }
  for (const path of proposal.writePaths) {
    if ((proposal.writePathFingerprints[path] ?? '') !== (current[path] ?? '')) {
      return {
        ok: false,
        code: 'PROPOSAL_PATH_FINGERPRINT_MISMATCH',
        message: `write path fingerprint changed: ${path}`,
        proposal,
      };
    }
  }

  return { ok: true, proposal, currentHead };
}
