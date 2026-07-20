import { createHash, randomUUID } from 'crypto';
import type { RepositoryRecord } from '../../../cli/repositories/types';
import { runBoundedGit } from './async-process';
import { routeExecution } from './execution-router';
import { executeFast } from './fast-executor';
import { LatencyTrace } from './latency-trace';
import { writeFastReceipt } from './fast-receipt';
import {
  createServerPatchProposal,
  markServerPatchProposalApplied,
  readServerPatchProposal,
  validateServerPatchProposalForApply,
  type ServerPatchProposal,
} from './proposal-store';
import { withCheckoutMutationGate } from './mutation-gate';
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
        // Strict readonly gate: mutatesWorkspace/mutatesGitRefs/remoteWrite must all be false.
        // Focused tests / package scripts / workspace-write commands are rejected.
        const decision = routeExecution({
          operation: lane.kind,
          mode: 'auto',
          command: lane.input.command as string | string[] | undefined,
          defaultBranch: ctx.repository.defaultBranch,
        });
        const effects = decision.effects;
        if (
          decision.mode !== 'fast'
          || effects.mutatesWorkspace
          || effects.mutatesGitRefs
          || effects.remoteWrite
          || decision.risk !== 'readonly'
        ) {
          return {
            id: lane.id,
            ok: false,
            durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
            startedAtMs,
            finishedAtMs: performance.now() - wallStart,
            error: {
              code: 'READ_LANE_NOT_READONLY',
              message: `read lane rejected non-readonly effect: ${decision.reasons.join('; ') || decision.risk}`,
            },
          } satisfies ReadLaneResult;
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
        const repoChanged = executed.repositoryChanged === true || Boolean(
          (executed.result as { repositoryChanged?: boolean } | undefined)?.repositoryChanged,
        );
        if (repoChanged) {
          return {
            id: lane.id,
            ok: false,
            durationMs: Math.round((performance.now() - laneStarted) * 100) / 100,
            startedAtMs,
            finishedAtMs: performance.now() - wallStart,
            error: { code: 'READ_LANE_MUTATION', message: 'read lane mutated repository (no automatic rollback)' },
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

  const proposalResults: PatchProposalValidateResult[] = [];
  if (shouldRunProposals) {
    for (const lane of proposalInputs) {
      const laneConflicts = conflicts.filter((conflict) => conflict.laneIds.includes(lane.id));
      const analysisOnly = conflictedLaneIds.has(lane.id);
      try {
        const stored = await createServerPatchProposal({
          controllerHome: ctx.controllerHome,
          repoId: ctx.repository.repoId,
          checkoutId: ctx.repository.activeCheckoutId,
          repoRoot: ctx.repository.canonicalRoot,
          readPaths: lane.readPaths,
          writePaths: lane.writePaths,
          operations: analysisOnly ? [] : lane.proposedOperations,
          owner: ctx.sessionId,
          assumptions: lane.assumptions,
          riskNotes: [
            ...(lane.riskNotes ?? []),
            ...(analysisOnly ? ['Demoted to analysis-only due to path conflicts with other lanes.'] : []),
            'patch_proposal_validate only validates conflicts; it does not run an analyzer Agent.',
          ],
          suggestedFocusedCheck: lane.suggestedFocusedCheck,
          analysisOnly,
          signal: request.signal,
        });
        proposalResults.push({
          id: lane.id,
          ok: true,
          durationMs: 0,
          readPaths: lane.readPaths,
          writePaths: lane.writePaths,
          proposedOperations: analysisOnly ? [] : lane.proposedOperations,
          assumptions: lane.assumptions,
          riskNotes: stored.riskNotes,
          suggestedFocusedCheck: lane.suggestedFocusedCheck,
          analysisOnly,
          conflicts: laneConflicts.length ? laneConflicts : undefined,
          summary: analysisOnly
            ? `analysis-only due to conflicts (${laneConflicts.map((c) => c.type).join(', ')})`
            : `proposal validated with ${lane.proposedOperations.length} operations (server:${stored.proposalId})`,
          proposalId: stored.proposalId,
          baseRevision: stored.baseSnapshot.head ?? baseRevision,
          proposalDigest: digest({
            proposalId: stored.proposalId,
            writePaths: lane.writePaths,
            operationsDigest: stored.operationsDigest,
            baseRevision: stored.baseSnapshot.head,
            checkoutId: ctx.repository.activeCheckoutId,
          }),
          operationsDigest: stored.operationsDigest.slice(0, 24),
          checkoutId: ctx.repository.activeCheckoutId,
        });
      } catch (error) {
        proposalResults.push({
          id: lane.id,
          ok: false,
          durationMs: 0,
          readPaths: lane.readPaths,
          writePaths: lane.writePaths,
          proposedOperations: [],
          analysisOnly: true,
          error: {
            code: 'PROPOSAL_PERSIST_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  } else {
    for (const lane of proposalInputs) {
      proposalResults.push({
        id: lane.id,
        ok: false,
        durationMs: 0,
        readPaths: lane.readPaths,
        writePaths: lane.writePaths,
        proposedOperations: [],
        analysisOnly: true,
        error: { code: 'FAIL_FAST', message: 'skipped because a read lane failed and failFast=true' },
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const latency = trace.snapshot(request.includeLatencyBreakdown === true);
  const ok = readResults.every((entry) => entry.ok)
    && proposalResults.every((entry) => entry.ok || entry.analysisOnly);

  // Overlap heuristic for benchmarks only — not a proof of offloaded concurrency.
  // Do not treat this as production "true concurrent" evidence when inspector fallback is sync.
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
 * Integrator: apply selected server-side proposals under one Mutation Ownership.
 * Trusts proposalId / server record — revalidates fingerprints, snapshot, conflicts.
 * One parent receipt; stop on first failure unless continueOnError.
 */
export async function integratePatchProposals(
  ctx: LanesExecutorContext,
  proposals: PatchProposalValidateResult[],
  options: {
    sessionId?: string;
    allowedPaths?: string[];
    purpose?: string;
    expectedBaseRevision?: string | null;
    requestId?: string;
    continueOnError?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{
  ok: boolean;
  applied: Array<{ proposalId: string; ok: boolean; changedPaths: string[]; error?: string }>;
  receiptIds: string[];
  parentReceiptId?: string;
  reconciliationRequired?: boolean;
}> {
  const applied: Array<{ proposalId: string; ok: boolean; changedPaths: string[]; error?: string }> = [];
  const receiptIds: string[] = [];
  const continueOnError = options.continueOnError === true;

  const requested = proposals.filter(
    (entry) => !entry.analysisOnly && entry.ok && entry.proposalId,
  );
  const serverCandidates = requested.map((entry) => ({
    entry,
    server: readServerPatchProposal(
      ctx.controllerHome,
      ctx.repository.repoId,
      entry.proposalId!,
    ),
  }));
  const applyable = serverCandidates.filter(
    (candidate): candidate is { entry: PatchProposalValidateResult; server: ServerPatchProposal } =>
      Boolean(candidate.server && candidate.server.operations.length > 0),
  );
  const serverByProposalId = new Map(
    serverCandidates
      .filter((candidate): candidate is { entry: PatchProposalValidateResult; server: ServerPatchProposal } => Boolean(candidate.server))
      .map((candidate) => [candidate.entry.proposalId!, candidate.server]),
  );

  // Re-run conflict detection from trusted server records, not caller-supplied paths.
  const recheck = detectPatchProposalConflicts(
    applyable.map(({ entry, server }) => ({
      id: entry.id,
      readPaths: server.readPaths,
      writePaths: server.writePaths,
      proposedOperations: server.operations,
    })),
  );
  const conflicted = new Set(recheck.flatMap((entry) => entry.laneIds));

  const writePaths = [...new Set(applyable.flatMap(({ server }) => server.writePaths))];
  if (requested.length === 0) {
    return { ok: false, applied: [], receiptIds: [] };
  }

  const requestId = options.requestId ?? `integrate-${randomUUID().slice(0, 10)}`;
  let parentReceiptId: string | undefined;
  let reconciliationRequired = false;

  const gated = await withCheckoutMutationGate(
    {
      controllerHome: ctx.controllerHome,
      repoId: ctx.repository.repoId,
      checkoutId: ctx.repository.activeCheckoutId,
      repoRoot: ctx.repository.canonicalRoot,
      owner: `fast:integrate:${requestId}`,
      ttlMs: 45_000,
      signal: options.signal,
      ownership: {
        writePaths,
        mutatesGitIndex: true,
        mutatesGitRefs: false,
      },
    },
    async (gate, helpers) => {
      // Validate every candidate against the same full workspace snapshot before
      // the first mutation. Later sequential applies recheck only relevant paths,
      // so one non-conflicting proposal does not invalidate the next via statusHash.
      const prevalidated = new Map<string, Awaited<ReturnType<typeof validateServerPatchProposalForApply>>>();
      for (const { entry } of applyable) {
        helpers.assert();
        prevalidated.set(entry.proposalId!, await validateServerPatchProposalForApply({
          controllerHome: ctx.controllerHome,
          repoId: ctx.repository.repoId,
          checkoutId: ctx.repository.activeCheckoutId,
          repoRoot: ctx.repository.canonicalRoot,
          proposalId: entry.proposalId!,
          signal: helpers.signal,
        }));
      }

      for (const proposal of proposals) {
        if (proposal.analysisOnly || !proposal.ok || !proposal.proposalId) {
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
            proposalId: proposal.proposalId,
            ok: false,
            changedPaths: [],
            error: 'conflict_recheck_failed',
          });
          if (!continueOnError) break;
          continue;
        }

        const stored = serverByProposalId.get(proposal.proposalId);
        if (!stored) {
          applied.push({
            proposalId: proposal.proposalId,
            ok: false,
            changedPaths: [],
            error: 'PROPOSAL_NOT_FOUND: server proposal record missing',
          });
          if (!continueOnError) break;
          continue;
        }
        const initialValidation = prevalidated.get(proposal.proposalId);
        if (!initialValidation?.ok) {
          applied.push({
            proposalId: proposal.proposalId,
            ok: false,
            changedPaths: [],
            error: initialValidation
              ? `${initialValidation.code}: ${initialValidation.message}`
              : 'PROPOSAL_NOT_PREVALIDATED',
          });
          if (!continueOnError) break;
          continue;
        }

        helpers.assert();
        const validation = await validateServerPatchProposalForApply({
          controllerHome: ctx.controllerHome,
          repoId: ctx.repository.repoId,
          checkoutId: ctx.repository.activeCheckoutId,
          repoRoot: ctx.repository.canonicalRoot,
          proposalId: proposal.proposalId,
          signal: helpers.signal,
          skipWorkspaceSnapshot: true,
        });
        if (!validation.ok) {
          applied.push({
            proposalId: proposal.proposalId,
            ok: false,
            changedPaths: [],
            error: `${validation.code}: ${validation.message}`,
          });
          if (!continueOnError) break;
          continue;
        }
        const serverProposal: ServerPatchProposal = validation.proposal;
        if (
          options.expectedBaseRevision
          && serverProposal.baseSnapshot.head
          && options.expectedBaseRevision !== serverProposal.baseSnapshot.head
        ) {
          applied.push({
            proposalId: proposal.proposalId,
            ok: false,
            changedPaths: [],
            error: 'expected_base_revision_mismatch',
          });
          if (!continueOnError) break;
          continue;
        }

        const opPaths = serverProposal.operations
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .map((entry) => String(entry.path ?? ''))
          .filter(Boolean);
        const outside = opPaths.filter((path) => !serverProposal.writePaths.some((write) => {
          const n = path.replace(/^\.\//, '');
          const w = write.replace(/^\.\//, '');
          return n === w || n.startsWith(`${w}/`);
        }));
        if (outside.length > 0) {
          applied.push({
            proposalId: proposal.proposalId,
            ok: false,
            changedPaths: [],
            error: `operation_paths_outside_writePaths: ${outside.join(', ')}`,
          });
          if (!continueOnError) break;
          continue;
        }

        helpers.assert();
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
              operations: serverProposal.operations,
              session_id: options.sessionId,
              purpose: options.purpose ?? `integrate:${proposal.id}`,
              allowed_paths: options.allowedPaths ?? serverProposal.writePaths,
            },
            allowedPaths: options.allowedPaths ?? serverProposal.writePaths,
            receiptMode: 'none',
            requestId: `${requestId}:${proposal.proposalId}`,
            signal: helpers.signal,
            externalMutation: true,
            externalGate: gate,
            externalHelpers: helpers,
          },
        );
        if (executed.receipt) receiptIds.push(executed.receipt.executionId);
        const changed = executed.changedPaths
          ?? ((executed.result?.applied as { appliedChunks?: Array<{ paths?: string[] }> } | undefined)?.appliedChunks
            ?.flatMap((chunk) => chunk.paths ?? []) ?? []);
        const stepOk = executed.ok && executed.operationSucceeded !== false;
        if (stepOk) {
          markServerPatchProposalApplied(ctx.controllerHome, ctx.repository.repoId, proposal.proposalId);
        } else if (executed.reconciliationRequired) {
          reconciliationRequired = true;
        }
        applied.push({
          proposalId: proposal.proposalId,
          ok: stepOk,
          changedPaths: changed,
          error: stepOk
            ? undefined
            : (executed.result?.error as { message?: string } | undefined)?.message ?? 'apply failed',
        });
        if (!stepOk && !continueOnError) break;
      }

      const allOk = applied.length > 0 && applied.every((entry) => entry.ok);
      const allChanged = [...new Set(applied.flatMap((entry) => entry.changedPaths))];
      const written = writeFastReceipt(ctx.controllerHome, {
        repoId: ctx.repository.repoId,
        checkoutId: ctx.repository.activeCheckoutId,
        operation: 'patch_proposal_integrate',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        outcome: allOk ? 'succeeded' : 'failed',
        changedPaths: allChanged,
        repositoryChanged: allChanged.length > 0,
        authorizationDecision: 'integrator',
        policyDecision: allOk ? 'allowed' : 'failed',
        outputSummary: `integrated=${applied.filter((a) => a.ok).length}/${applied.length}`,
        requestId,
        fencingToken: gate.fencingToken,
        baseHead: gate.baseHead,
      });
      if (written.receipt) {
        parentReceiptId = written.receipt.executionId;
        receiptIds.push(written.receipt.executionId);
      }
      return { allOk };
    },
  );

  if (!gated.ok) {
    return {
      ok: false,
      applied: [{
        proposalId: 'batch',
        ok: false,
        changedPaths: [],
        error: `mutation_busy: ${gated.busy.reason}`,
      }],
      receiptIds: [],
      reconciliationRequired: false,
    };
  }

  return {
    ok: gated.value.allOk,
    applied,
    receiptIds,
    parentReceiptId,
    reconciliationRequired: reconciliationRequired || undefined,
  };
}
