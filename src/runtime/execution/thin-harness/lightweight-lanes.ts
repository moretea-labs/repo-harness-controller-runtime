import type { RepositoryRecord } from '../../../cli/repositories/types';
import { executeFast } from './fast-executor';
import { LatencyTrace } from './latency-trace';
import { recordFastReceiptMetric, writeFastReceipt } from './fast-receipt';
import {
  FAST_LANE_MAX_CONCURRENCY,
  type LaneConflict,
  type LightweightLanesRequest,
  type LightweightLanesResult,
  type PatchProposalLaneRequest,
  type PatchProposalLaneResult,
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

/**
 * Detect write/write, write/read, project-file, and schema conflicts among patch proposal lanes.
 * Conflicting lanes are demoted to analysis-only; no multi-worktree masking.
 */
export function detectPatchProposalConflicts(lanes: Array<PatchProposalLaneRequest & { id: string }>): LaneConflict[] {
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

  // De-dupe by type+sorted lane ids+paths
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

/**
 * Lightweight concurrent lanes without Campaign, Issue Task, or long-lived worktrees.
 * Read lanes share one checkout snapshot semantics; patch proposal lanes never write.
 */
export async function executeLightweightLanes(
  ctx: LanesExecutorContext,
  request: LightweightLanesRequest,
): Promise<LightweightLanesResult> {
  const startedAt = new Date().toISOString();
  const trace = new LatencyTrace('fast');
  const concurrency = Math.max(
    1,
    Math.min(request.maxConcurrency ?? FAST_LANE_MAX_CONCURRENCY, FAST_LANE_MAX_CONCURRENCY),
  );

  const readLaneInputs: Array<ReadLaneRequest & { id: string }> = (request.readLanes ?? []).map((lane, index) => ({
    ...lane,
    id: lane.id?.trim() || `read_${index + 1}`,
  }));
  const proposalInputs: Array<PatchProposalLaneRequest & { id: string }> = (request.patchProposalLanes ?? []).map((lane, index) => ({
    ...lane,
    id: lane.id?.trim() || `proposal_${index + 1}`,
    readPaths: (lane.readPaths ?? []).map(String),
    writePaths: (lane.writePaths ?? []).map(String),
    proposedOperations: Array.isArray(lane.proposedOperations) ? lane.proposedOperations : [],
  }));

  const conflicts = detectPatchProposalConflicts(proposalInputs);
  const conflictedLaneIds = new Set(conflicts.flatMap((entry) => entry.laneIds));

  const readResults = await trace.measure('operationExecutionMs', async () => mapPool(
    readLaneInputs,
    concurrency,
    async (lane) => {
      const laneStarted = performance.now();
      try {
        // Force read-only operations only
        if (!['search', 'read_file', 'git_status', 'git_diff', 'run_short_command'].includes(lane.kind)) {
          throw new Error(`READ_LANE_KIND_INVALID: ${lane.kind}`);
        }
        if (lane.kind === 'run_short_command') {
          // Only allow readonly classification via fast executor precheck
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
          },
        );
        if (executed.receipt?.repositoryChanged) {
          return {
            id: lane.id,
            ok: false,
            durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
            error: {
              code: 'READ_LANE_MUTATION',
              message: 'read lane attempted repository mutation',
            },
          } satisfies ReadLaneResult;
        }
        return {
          id: lane.id,
          ok: executed.ok,
          durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
          summary: executed.receipt?.outputSummary,
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
          error: {
            code: 'READ_LANE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        } satisfies ReadLaneResult;
      }
    },
  ));

  if (request.failFast === true && readResults.some((entry) => !entry.ok)) {
    // Continue patch proposals only when failFast is false; for failFast stop further work.
  }

  const shouldRunProposals = request.failFast !== true || readResults.every((entry) => entry.ok);

  const proposalResults: PatchProposalLaneResult[] = shouldRunProposals
    ? await mapPool(proposalInputs, concurrency, async (lane) => {
      const laneStarted = performance.now();
      const laneConflicts = conflicts.filter((conflict) => conflict.laneIds.includes(lane.id));
      const analysisOnly = conflictedLaneIds.has(lane.id);
      return {
        id: lane.id,
        ok: true,
        durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
        readPaths: lane.readPaths,
        writePaths: lane.writePaths,
        // Never apply — only return the proposal (or empty ops when analysis-only).
        proposedOperations: analysisOnly ? [] : lane.proposedOperations,
        assumptions: lane.assumptions,
        riskNotes: [
          ...(lane.riskNotes ?? []),
          ...(analysisOnly ? ['Demoted to analysis-only due to path conflicts with other lanes.'] : []),
        ],
        suggestedFocusedCheck: lane.suggestedFocusedCheck,
        analysisOnly,
        conflicts: laneConflicts.length ? laneConflicts : undefined,
        summary: analysisOnly
          ? `analysis-only due to conflicts (${laneConflicts.map((c) => c.type).join(', ')})`
          : `proposal ready with ${lane.proposedOperations.length} operations`,
      } satisfies PatchProposalLaneResult;
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

  const receipt = recordFastReceiptMetric(writeFastReceipt(ctx.controllerHome, {
    repoId: ctx.repository.repoId,
    checkoutId: ctx.repository.activeCheckoutId,
    operation: proposalInputs.length ? 'patch_proposal_lanes' : 'read_lanes',
    startedAt,
    finishedAt,
    durationMs: latency.totalMs,
    outcome: ok ? 'succeeded' : 'failed',
    changedPaths: [],
    repositoryChanged: false,
    authorizationDecision: 'read_only_lanes',
    policyDecision: 'allowed',
    outputSummary: `readLanes=${readResults.length} proposals=${proposalResults.length} conflicts=${conflicts.length}`,
    latency: request.includeLatencyBreakdown === true ? latency : undefined,
    laneCount: readResults.length + proposalResults.length,
  }));

  return {
    ok,
    receipt,
    readLanes: readResults,
    patchProposals: proposalResults,
    conflicts,
    latency,
    appliedByIntegrator: false,
    createdIssue: false,
    createdCampaign: false,
    createdWorktree: false,
  };
}

/**
 * Integrator helper: sequentially apply selected non-conflicting proposals
 * through Fast Path apply_patch. Caller chooses which proposals to apply.
 */
export async function integratePatchProposals(
  ctx: LanesExecutorContext,
  proposals: PatchProposalLaneResult[],
  options: {
    sessionId?: string;
    allowedPaths?: string[];
    purpose?: string;
  } = {},
): Promise<{
  ok: boolean;
  applied: Array<{ proposalId: string; ok: boolean; changedPaths: string[]; error?: string }>;
  receiptIds: string[];
}> {
  const applied: Array<{ proposalId: string; ok: boolean; changedPaths: string[]; error?: string }> = [];
  const receiptIds: string[] = [];

  for (const proposal of proposals) {
    if (proposal.analysisOnly || !proposal.ok || proposal.proposedOperations.length === 0) {
      applied.push({
        proposalId: proposal.id,
        ok: false,
        changedPaths: [],
        error: proposal.analysisOnly ? 'analysis_only' : 'empty_or_failed_proposal',
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
      },
    );
    if (executed.receipt) receiptIds.push(executed.receipt.executionId);
    applied.push({
      proposalId: proposal.id,
      ok: executed.ok,
      changedPaths: executed.receipt?.changedPaths ?? [],
      error: executed.ok
        ? undefined
        : (executed.result?.error as { message?: string } | undefined)?.message ?? 'apply failed',
    });
    if (!executed.ok) break;
  }

  return {
    ok: applied.every((entry) => entry.ok),
    applied,
    receiptIds,
  };
}
