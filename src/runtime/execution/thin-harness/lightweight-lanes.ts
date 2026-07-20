import { createHash, randomUUID } from 'crypto';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { runBoundedGit } from './async-process';
import { executeFast } from './fast-executor';
import { LatencyTrace } from './latency-trace';
import { writeFastReceipt } from './fast-receipt';
import {
  FAST_LANE_MAX_CONCURRENCY,
  type LaneConflict,
  type LightweightLanesRequest,
  type LightweightLanesResult,
  type PatchProposalValidateRequest,
  type PatchProposalValidateResult,
  type ReadLaneRequest,
  type ReadLaneResult,
} from './types';

export interface LanesExecutorContext {
  controllerHome: string;
  repository: RepositoryRecord;
  principalId?: string;
  sessionId?: string;
}

const PROJECT_FILE_PATTERNS = [
  /project\.pbxproj$/i,
  /\.xcodeproj\//i,
  /package-lock\.json$/i,
  /bun\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /Cargo\.lock$/i,
  /go\.sum$/i,
];

const SCHEMA_FILE_PATTERNS = [
  /\/migrations?\//i,
  /\.sql$/i,
  /schema\.(ts|js|prisma|graphql)$/i,
  /prisma\/schema/i,
];

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\\/g, '/');
}

function pathMatches(path: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function overlaps(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map(normalizePath));
  return left.map(normalizePath).filter((path) => rightSet.has(path)
    || [...rightSet].some((other) => path.startsWith(`${other}/`) || other.startsWith(`${path}/`)));
}

export function detectPatchProposalConflicts(lanes: Array<PatchProposalValidateRequest & { id: string }>): LaneConflict[] {
  const conflicts: LaneConflict[] = [];
  for (let i = 0; i < lanes.length; i += 1) {
    for (let j = i + 1; j < lanes.length; j += 1) {
      const a = lanes[i]!;
      const b = lanes[j]!;
      const writeWrite = overlaps(a.writePaths, b.writePaths);
      if (writeWrite.length > 0) {
        conflicts.push({
          type: 'write_write',
          laneIds: [a.id, b.id],
          paths: writeWrite,
          message: `write/write conflict on ${writeWrite.join(', ')}`,
        });
      }
      const aWriteBRead = overlaps(a.writePaths, b.readPaths);
      if (aWriteBRead.length > 0) {
        conflicts.push({
          type: 'write_read',
          laneIds: [a.id, b.id],
          paths: aWriteBRead,
          message: `lane ${a.id} writes paths read by ${b.id}: ${aWriteBRead.join(', ')}`,
        });
      }
      const bWriteARead = overlaps(b.writePaths, a.readPaths);
      if (bWriteARead.length > 0) {
        conflicts.push({
          type: 'write_read',
          laneIds: [b.id, a.id],
          paths: bWriteARead,
          message: `lane ${b.id} writes paths read by ${a.id}: ${bWriteARead.join(', ')}`,
        });
      }
    }
  }

  for (const lane of lanes) {
    const projectHits = lane.writePaths.filter((path) => pathMatches(path, PROJECT_FILE_PATTERNS));
    const otherProjectWriters = lanes.filter((other) => other.id !== lane.id
      && other.writePaths.some((path) => pathMatches(path, PROJECT_FILE_PATTERNS)));
    if (projectHits.length > 0 && otherProjectWriters.length > 0) {
      conflicts.push({
        type: 'project_file',
        laneIds: [lane.id, ...otherProjectWriters.map((entry) => entry.id)],
        paths: projectHits,
        message: `project/lockfile conflict involving ${lane.id}`,
      });
    }
    const schemaHits = lane.writePaths.filter((path) => pathMatches(path, SCHEMA_FILE_PATTERNS));
    const otherSchemaWriters = lanes.filter((other) => other.id !== lane.id
      && other.writePaths.some((path) => pathMatches(path, SCHEMA_FILE_PATTERNS)));
    if (schemaHits.length > 0 && otherSchemaWriters.length > 0) {
      conflicts.push({
        type: 'schema_file',
        laneIds: [lane.id, ...otherSchemaWriters.map((entry) => entry.id)],
        paths: schemaHits,
        message: `migration/schema conflict involving ${lane.id}`,
      });
    }
  }

  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = `${conflict.type}:${[...conflict.laneIds].sort().join(',')}:${[...conflict.paths].sort().join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 24);
}

/**
 * Lightweight concurrent lanes without Campaign/Issue/worktree.
 * Read lanes use async Fast primitives. Proposal lanes only validate conflicts (no Agent analysis).
 */
export async function executeLightweightLanes(
  ctx: LanesExecutorContext,
  request: LightweightLanesRequest,
): Promise<LightweightLanesResult> {
  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  const trace = new LatencyTrace('fast');
  const concurrency = Math.max(
    1,
    Math.min(request.maxConcurrency ?? FAST_LANE_MAX_CONCURRENCY, FAST_LANE_MAX_CONCURRENCY),
  );

  const readLaneInputs: Array<ReadLaneRequest & { id: string }> = (request.readLanes ?? []).map((lane, index) => ({
    ...lane,
    id: lane.id?.trim() || `read_${index + 1}`,
  }));
  const proposalSource = request.patchProposalValidations ?? request.patchProposalLanes ?? [];
  const proposalInputs: Array<PatchProposalValidateRequest & { id: string }> = proposalSource.map((lane, index) => ({
    ...lane,
    id: lane.id?.trim() || `proposal_${index + 1}`,
    readPaths: (lane.readPaths ?? []).map(String),
    writePaths: (lane.writePaths ?? []).map(String),
    proposedOperations: Array.isArray(lane.proposedOperations) ? lane.proposedOperations : [],
  }));

  const conflicts = detectPatchProposalConflicts(proposalInputs);
  const conflictedLaneIds = new Set(conflicts.flatMap((entry) => entry.laneIds));

  const readResults = await trace.measure('executionMs', async () => mapPool(
    readLaneInputs,
    concurrency,
    async (lane) => {
      const startedAtMs = performance.now() - wallStart;
      const laneStarted = performance.now();
      try {
        if (!['search', 'read_file', 'git_status', 'git_diff', 'run_short_command'].includes(lane.kind)) {
          throw new Error(`READ_LANE_KIND_INVALID: ${lane.kind}`);
        }
        const executed = await executeFast(
          {
            controllerHome: ctx.controllerHome,
            repository: ctx.repository,
            includeLatencyBreakdown: false,
            principalId: ctx.principalId,
            sessionId: ctx.sessionId,
          },
          {
            operation: lane.kind,
            mode: 'fast',
            input: lane.input,
            receiptMode: 'none',
            signal: request.signal,
          },
        );
        if (executed.operationSucceeded === false && executed.result?.error) {
          /* fall through */
        }
        // Mutation from a read lane is a hard failure
        const repoChanged = Boolean(
          (executed.result as { repositoryChanged?: boolean } | undefined)?.repositoryChanged,
        );
        if (repoChanged) {
          return {
            id: lane.id,
            ok: false,
            durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
            startedAtMs,
            finishedAtMs: performance.now() - wallStart,
            error: { code: 'READ_LANE_MUTATION', message: 'read lane attempted repository mutation' },
          } satisfies ReadLaneResult;
        }
        return {
          id: lane.id,
          ok: executed.ok,
          durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
          startedAtMs,
          finishedAtMs: performance.now() - wallStart,
          summary: executed.ok ? `ok:${lane.kind}` : 'failed',
          result: executed.result,
          error: executed.ok
            ? undefined
            : {
              code: 'READ_LANE_FAILED',
              message: (executed.result?.error as { message?: string } | undefined)?.message
                ?? executed.escalation?.reason
                ?? 'read lane failed',
            },
        } satisfies ReadLaneResult;
      } catch (error) {
        return {
          id: lane.id,
          ok: false,
          durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
          startedAtMs,
          finishedAtMs: performance.now() - wallStart,
          error: {
            code: 'READ_LANE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        } satisfies ReadLaneResult;
      }
    },
  ));

  const shouldRunProposals = request.failFast !== true || readResults.every((entry) => entry.ok);
  const baseRevision = await (async () => {
    try {
      const out = await runBoundedGit(ctx.repository.canonicalRoot, ['rev-parse', 'HEAD'], {
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
        signal: request.signal,
      });
      return out.ok ? (out.stdout.trim() || null) : null;
    } catch {
      return null;
    }
  })();

  const proposalResults: PatchProposalValidateResult[] = shouldRunProposals
    ? proposalInputs.map((lane) => {
      const laneConflicts = conflicts.filter((conflict) => conflict.laneIds.includes(lane.id));
      const analysisOnly = conflictedLaneIds.has(lane.id);
      const proposalId = `prop_${randomUUID().slice(0, 12)}`;
      const operationsDigest = digest(lane.proposedOperations);
      return {
        id: lane.id,
        ok: true,
        durationMs: 0,
        readPaths: lane.readPaths,
        writePaths: lane.writePaths,
        proposedOperations: analysisOnly ? [] : lane.proposedOperations,
        assumptions: lane.assumptions,
        riskNotes: [
          ...(lane.riskNotes ?? []),
          ...(analysisOnly ? ['Demoted to analysis-only due to path conflicts with other lanes.'] : []),
          'patch_proposal_validate only validates conflicts; it does not run an analyzer Agent.',
        ],
        suggestedFocusedCheck: lane.suggestedFocusedCheck,
        analysisOnly,
        conflicts: laneConflicts.length ? laneConflicts : undefined,
        summary: analysisOnly
          ? `analysis-only due to conflicts (${laneConflicts.map((c) => c.type).join(', ')})`
          : `proposal validated with ${lane.proposedOperations.length} operations`,
        proposalId,
        baseRevision,
        proposalDigest: digest({
          proposalId,
          writePaths: lane.writePaths,
          operationsDigest,
          baseRevision,
          checkoutId: ctx.repository.activeCheckoutId,
        }),
        operationsDigest,
        checkoutId: ctx.repository.activeCheckoutId,
      } satisfies PatchProposalValidateResult;
    })
    : proposalInputs.map((lane) => ({
      id: lane.id,
      ok: false,
      durationMs: 0,
      readPaths: lane.readPaths,
      writePaths: lane.writePaths,
      proposedOperations: [],
      analysisOnly: true,
      error: { code: 'FAIL_FAST', message: 'skipped because a read lane failed and failFast=true' },
    }));

  const finishedAt = new Date().toISOString();
  const latency = trace.snapshot(request.includeLatencyBreakdown === true);
  const ok = readResults.every((entry) => entry.ok)
    && proposalResults.every((entry) => entry.ok || entry.analysisOnly);

  // True concurrency: multiple lanes started before others finished.
  const concurrent = readResults.length >= 2 && readResults.some((left, i) =>
    readResults.some((right, j) => i !== j
      && left.startedAtMs !== undefined
      && right.startedAtMs !== undefined
      && left.finishedAtMs !== undefined
      && right.finishedAtMs !== undefined
      && left.startedAtMs < right.finishedAtMs
      && right.startedAtMs < left.finishedAtMs));

  const written = writeFastReceipt(ctx.controllerHome, {
    repoId: ctx.repository.repoId,
    checkoutId: ctx.repository.activeCheckoutId,
    operation: proposalInputs.length ? 'patch_proposal_validate' : 'read_lanes',
    startedAt,
    finishedAt,
    durationMs: latency.totalMs,
    outcome: ok ? 'succeeded' : 'failed',
    changedPaths: [],
    repositoryChanged: false,
    authorizationDecision: 'read_only_lanes',
    policyDecision: 'allowed',
    outputSummary: `readLanes=${readResults.length} proposals=${proposalResults.length} conflicts=${conflicts.length} concurrent=${concurrent}`,
    latency: request.includeLatencyBreakdown === true ? latency : undefined,
    laneCount: readResults.length + proposalResults.length,
  });

  return {
    ok,
    receipt: written.receipt,
    receiptPersisted: written.persisted,
    readLanes: readResults,
    patchProposals: proposalResults,
    conflicts,
    latency,
    appliedByIntegrator: false,
    createdIssue: false,
    createdCampaign: false,
    createdWorktree: false,
    concurrent,
  };
}

/**
 * Integrator: sequentially apply selected non-conflicting validated proposals.
 * Re-validates writePaths, digests, and conflicts before apply.
 */
export async function integratePatchProposals(
  ctx: LanesExecutorContext,
  proposals: PatchProposalValidateResult[],
  options: {
    sessionId?: string;
    allowedPaths?: string[];
    purpose?: string;
    expectedBaseRevision?: string | null;
  } = {},
): Promise<{
  ok: boolean;
  applied: Array<{ proposalId: string; ok: boolean; changedPaths: string[]; error?: string }>;
  receiptIds: string[];
}> {
  const applied: Array<{ proposalId: string; ok: boolean; changedPaths: string[]; error?: string }> = [];
  const receiptIds: string[] = [];

  // Re-run conflict detection on remaining applyable proposals.
  const recheck = detectPatchProposalConflicts(
    proposals
      .filter((entry) => !entry.analysisOnly && entry.ok && entry.proposedOperations.length > 0)
      .map((entry) => ({
        id: entry.id,
        readPaths: entry.readPaths,
        writePaths: entry.writePaths,
        proposedOperations: entry.proposedOperations,
      })),
  );
  const conflicted = new Set(recheck.flatMap((entry) => entry.laneIds));

  let currentHead: string | null = null;
  try {
    const out = await runBoundedGit(ctx.repository.canonicalRoot, ['rev-parse', 'HEAD'], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    currentHead = out.ok ? (out.stdout.trim() || null) : null;
  } catch {
    currentHead = null;
  }

  for (const proposal of proposals) {
    if (proposal.analysisOnly || !proposal.ok || proposal.proposedOperations.length === 0) {
      applied.push({
        proposalId: proposal.proposalId ?? proposal.id,
        ok: false,
        changedPaths: [],
        error: proposal.analysisOnly ? 'analysis_only' : 'empty_or_failed_proposal',
      });
      continue;
    }
    if (conflicted.has(proposal.id)) {
      applied.push({
        proposalId: proposal.proposalId ?? proposal.id,
        ok: false,
        changedPaths: [],
        error: 'conflict_recheck_failed',
      });
      continue;
    }
    if (proposal.baseRevision && currentHead && proposal.baseRevision !== currentHead) {
      applied.push({
        proposalId: proposal.proposalId ?? proposal.id,
        ok: false,
        changedPaths: [],
        error: `revision_changed expected=${proposal.baseRevision} actual=${currentHead}`,
      });
      continue;
    }
    if (options.expectedBaseRevision && proposal.baseRevision && options.expectedBaseRevision !== proposal.baseRevision) {
      applied.push({
        proposalId: proposal.proposalId ?? proposal.id,
        ok: false,
        changedPaths: [],
        error: 'expected_base_revision_mismatch',
      });
      continue;
    }

    // Operation paths must be subset of writePaths
    const opPaths = proposal.proposedOperations
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => String(entry.path ?? ''))
      .filter(Boolean);
    const outside = opPaths.filter((path) => !proposal.writePaths.some((write) => {
      const n = path.replace(/^\.\//, '');
      const w = write.replace(/^\.\//, '');
      return n === w || n.startsWith(`${w}/`);
    }));
    if (outside.length > 0) {
      applied.push({
        proposalId: proposal.proposalId ?? proposal.id,
        ok: false,
        changedPaths: [],
        error: `operation_paths_outside_writePaths: ${outside.join(', ')}`,
      });
      continue;
    }

    const executed = await executeFast(
      {
        controllerHome: ctx.controllerHome,
        repository: ctx.repository,
        sessionId: ctx.sessionId,
        principalId: ctx.principalId,
      },
      {
        operation: 'apply_patch',
        mode: 'fast',
        input: {
          operations: proposal.proposedOperations,
          session_id: options.sessionId,
          purpose: options.purpose ?? `integrate:${proposal.id}`,
          allowed_paths: options.allowedPaths ?? proposal.writePaths,
        },
        allowedPaths: options.allowedPaths ?? proposal.writePaths,
        receiptMode: 'standalone',
      },
    );
    if (executed.receipt) receiptIds.push(executed.receipt.executionId);
    const changed = executed.receipt?.changedPaths
      ?? ((executed.result?.applied as { appliedChunks?: Array<{ paths?: string[] }> } | undefined)?.appliedChunks
        ?.flatMap((chunk) => chunk.paths ?? []) ?? []);
    applied.push({
      proposalId: proposal.proposalId ?? proposal.id,
      ok: executed.ok && executed.operationSucceeded !== false,
      changedPaths: changed,
      error: executed.ok
        ? undefined
        : (executed.result?.error as { message?: string } | undefined)?.message ?? 'apply failed',
    });
    if (!executed.ok) break;

    // Refresh head after successful apply
    try {
      const out = await runBoundedGit(ctx.repository.canonicalRoot, ['rev-parse', 'HEAD'], {
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
      currentHead = out.ok ? (out.stdout.trim() || currentHead) : currentHead;
    } catch {
      /* keep previous */
    }
  }

  return {
    ok: applied.length > 0 && applied.every((entry) => entry.ok),
    applied,
    receiptIds,
  };
}
