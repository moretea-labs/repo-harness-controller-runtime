import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { runProcess } from '../../effects/process-runner';
import { resolveMcpRepoRoot } from '../mcp/repo';
import { resolveRepoPreferredControllerHome } from '../repositories/controller-home';
import { listControllerChecks, runControllerCheck } from './check-runner';
import {
  controllerServiceStatus,
  type ControllerServiceStatus,
} from './lifecycle';
import {
  readControllerRestartState,
  requestControllerServiceRestart,
  type ControllerRestartScheduledResult,
  type ControllerRestartState,
} from './restart-coordinator';
import {
  compositeFailed,
  compositeRunning,
  compositeSucceeded,
  usefulTail,
  type CompositeToolResult,
} from './composite-result';
import { validatePatchSuccess, validateRestartSuccess } from './postcondition';
import { gitSnapshot } from '../repository/inspector';
import {
  ensureSlotHome,
  readActiveSlotAuthority,
  type RuntimeSlotId,
} from './runtime-slots';
import { controllerRollout } from './bluegreen-rollout';

function fileSha(repoRoot: string, relativePath: string): string | null {
  const absolute = join(repoRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function git(repoRoot: string, args: string[]) {
  return runProcess('git', ['-C', repoRoot, ...args], {
    timeoutMs: 20_000,
    maxOutputBytes: 512 * 1024,
  });
}

export interface RepositoryChangeVerifyInput {
  repo?: string;
  expectedBranch?: string;
  expectedHead?: string;
  /** Relative path -> expected pre-patch sha256. */
  expectedFileShas?: Record<string, string>;
  /** Unified diff or multi-file patch text applied with `git apply`. */
  patch?: string;
  /** Optional allow-list for changed paths after patch. */
  allowedPaths?: string[];
  /** Check ids from listControllerChecks / package scripts. */
  checks?: string[];
  checkTimeoutMs?: number;
}

/**
 * One-shot: validate checkout, apply bounded patch, run checks, return first failure inline.
 */
export function repositoryChangeVerify(input: RepositoryChangeVerifyInput): CompositeToolResult {
  const repoRoot = resolveMcpRepoRoot(input.repo ?? '.');
  const snapshot = gitSnapshot(repoRoot);
  const evidenceRefs: string[] = [];

  if (input.expectedBranch && snapshot.branch !== input.expectedBranch) {
    return compositeFailed({
      phase: 'preflight',
      summary: `branch mismatch: ${snapshot.branch ?? 'detached'} != ${input.expectedBranch}`,
      failedCheck: 'branch',
      keyOutput: snapshot.status,
      nextAction: 'switch to the expected branch before retrying',
    });
  }
  if (input.expectedHead && snapshot.head !== input.expectedHead) {
    return compositeFailed({
      phase: 'preflight',
      summary: `HEAD mismatch: ${snapshot.head ?? 'unknown'} != ${input.expectedHead}`,
      failedCheck: 'head',
      keyOutput: `branch=${snapshot.branch} head=${snapshot.head}`,
      nextAction: 'rebase or re-checkout the expected commit',
    });
  }

  if (input.expectedFileShas) {
    for (const [path, expected] of Object.entries(input.expectedFileShas)) {
      const actual = fileSha(repoRoot, path);
      if (actual !== expected) {
        return compositeFailed({
          phase: 'preflight',
          summary: `file SHA mismatch for ${path}`,
          failedCheck: 'file_sha',
          keyOutput: `expected=${expected}\nactual=${actual ?? 'missing'}`,
          nextAction: 'refresh fingerprints and regenerate the patch',
        });
      }
    }
  }

  let changedFiles: string[] = [];
  if (input.patch?.trim()) {
    const apply = runProcess('git', ['-C', repoRoot, 'apply', '--whitespace=nowarn', '-'], {
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024,
      input: input.patch,
    });
    if (!apply.ok) {
      return compositeFailed({
        phase: 'patch',
        summary: 'failed to apply patch',
        failedCheck: 'git_apply',
        exitCode: apply.status,
        keyOutput: usefulTail(apply.stdout, apply.stderr || apply.error || ''),
        nextAction: 'fix patch context against current file SHAs',
      });
    }
  }

  const nameOnly = git(repoRoot, ['diff', '--name-only']);
  const nameOnlyCached = git(repoRoot, ['diff', '--cached', '--name-only']);
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  changedFiles = [
    ...new Set([
      ...nameOnly.stdout.split(/\n/).filter(Boolean),
      ...nameOnlyCached.stdout.split(/\n/).filter(Boolean),
      ...untracked.stdout.split(/\n/).filter(Boolean),
    ]),
  ];
  const diffStat = git(repoRoot, ['diff', '--stat']);

  const patchPost = validatePatchSuccess({
    repoRoot,
    expectedFileShas: undefined, // post-patch content intentionally differs
    allowedPaths: input.allowedPaths,
    changedFiles,
  });
  if (!patchPost.ok) {
    return compositeFailed({
      phase: 'patch-postcondition',
      summary: 'patch postcondition failed',
      failedCheck: 'patch_postcondition',
      changedFiles,
      keyOutput: patchPost.failures.join('\n'),
      nextAction: 'revert unexpected paths or conflict markers',
      details: { ...patchPost },
    });
  }

  const checkIds = input.checks?.length
    ? input.checks
    : [];
  const available = new Set(listControllerChecks(repoRoot).map((c) => c.id));
  for (const id of checkIds) {
    if (!available.has(id)) {
      return compositeFailed({
        phase: 'checks',
        summary: `check not found: ${id}`,
        failedCheck: id,
        changedFiles,
        keyOutput: `known checks: ${[...available].slice(0, 20).join(', ')}`,
        nextAction: 'use list_checks and pass valid check ids',
      });
    }
    const result = runControllerCheck(repoRoot, id, input.checkTimeoutMs);
    evidenceRefs.push(result.artifactPath);
    if (!result.ok) {
      return compositeFailed({
        phase: 'checks',
        summary: `check failed: ${id}`,
        failedCheck: id,
        exitCode: result.status,
        changedFiles,
        keyOutput: usefulTail(result.stdout, result.stderr),
        evidenceRefs,
        retryable: result.failureClass === 'infrastructure_failure',
        nextAction: result.failureClass === 'infrastructure_failure'
          ? 'retry the same check after infrastructure recovers'
          : 'fix the failing assertion and re-run repository_change_verify',
        details: {
          timedOut: result.timedOut,
          failureClass: result.failureClass,
          command: result.command,
        },
      });
    }
  }

  const after = gitSnapshot(repoRoot);
  return compositeSucceeded({
    phase: 'complete',
    summary: checkIds.length
      ? `patch applied and ${checkIds.length} check(s) passed`
      : 'patch applied (no checks requested)',
    changedFiles,
    keyOutput: [
      `branch=${after.branch}`,
      `head=${after.head}`,
      `changed=${changedFiles.join(', ') || '(none)'}`,
      diffStat.stdout || snapshot.diffStat,
    ].join('\n'),
    evidenceRefs,
    nextAction: 'review diff, commit when ready; do not push unless requested',
    details: {
      checks: checkIds,
      revision: after.head,
      dirty: after.dirty,
    },
    exitCode: 0,
  });
}

export interface ControllerRestartVerifyInput {
  repo?: string;
  controllerHome?: string;
  /** Active slot by default; tests may target a specific slot home. */
  slot?: RuntimeSlotId;
  requestId?: string;
  reason?: string;
  mode?: 'auto' | 'sync' | 'detached';
  /** When set, only poll an existing durable request. */
  pollOnly?: boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  expectedSourceCommit?: string;
  expectedToolFingerprint?: string;
}

function resolveSlotHome(repoRoot: string, controllerHome: string | undefined, slot?: RuntimeSlotId): string {
  const root = resolveRepoPreferredControllerHome(repoRoot, controllerHome);
  if (!slot) {
    // Prefer active slot home when runtime-slots exist; fall back to root.
    const authority = readActiveSlotAuthority(root);
    const slotHome = ensureSlotHome(root, authority.activeSlot);
    if (existsSync(join(slotHome, 'mcp')) || existsSync(join(root, 'runtime-slots'))) {
      return slotHome;
    }
    return root;
  }
  return ensureSlotHome(root, slot);
}

export interface ControllerRestartWaitDependencies {
  now?: () => number;
  read?: (slotHome: string, requestId: string) => ControllerRestartState | undefined;
  sleep?: (ms: number) => Promise<void>;
}

function restartStateIsTerminal(state: ControllerRestartState): boolean {
  return state.phase === 'succeeded' || state.phase === 'failed';
}

export async function waitForControllerRestartState(
  slotHome: string,
  initial: ControllerRestartState,
  options: Pick<ControllerRestartVerifyInput, 'waitTimeoutMs' | 'pollIntervalMs'> = {},
  dependencies: ControllerRestartWaitDependencies = {},
): Promise<ControllerRestartState> {
  const now = dependencies.now ?? Date.now;
  const read = dependencies.read ?? readControllerRestartState;
  const sleep = dependencies.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + Math.max(5_000, options.waitTimeoutMs ?? 90_000);
  let state = initial;
  while (!restartStateIsTerminal(state) && now() < deadline) {
    await sleep(Math.max(0, options.pollIntervalMs ?? 500));
    state = read(slotHome, state.requestId) ?? state;
  }
  return state;
}

/**
 * Persist restart request, wait for generation, verify all surfaces, allow resume by requestId.
 */
export async function controllerRestartVerify(input: ControllerRestartVerifyInput = {}): Promise<CompositeToolResult> {
  const repoRoot = resolveMcpRepoRoot(input.repo ?? '.');
  const slotHome = resolveSlotHome(repoRoot, input.controllerHome, input.slot);
  const evidenceRefs: string[] = [];

  if (input.pollOnly && input.requestId) {
    const state = readControllerRestartState(slotHome, input.requestId);
    if (!state) {
      return compositeFailed({
        phase: 'poll',
        summary: `restart request not found: ${input.requestId}`,
        failedCheck: 'request_missing',
        retryable: false,
        nextAction: 'submit controller_restart_verify without pollOnly',
      });
    }
    return formatRestartState(repoRoot, slotHome, state, input, evidenceRefs);
  }

  if (input.requestId) {
    const existing = readControllerRestartState(slotHome, input.requestId);
    if (existing) {
      // Always prefer resume over double-submit for the same durable request id.
      if (existing.phase !== 'failed' || input.pollOnly) {
        const resumed = !input.pollOnly && !restartStateIsTerminal(existing)
          ? await waitForControllerRestartState(slotHome, existing, input)
          : existing;
        return formatRestartState(repoRoot, slotHome, resumed, input, evidenceRefs);
      }
    }
  }

  const before = await controllerServiceStatus({ repo: repoRoot, controllerHome: slotHome });
  const oldPids = [
    before.supervisor.pid,
    before.daemon.pid,
    before.mcpRuntime?.server.pid,
  ].filter((pid): pid is number => Number.isInteger(pid) && Number(pid) > 0);

  const requested = await requestControllerServiceRestart({
    repo: repoRoot,
    controllerHome: slotHome,
    requestId: input.requestId,
    reason: input.reason ?? 'controller_restart_verify',
    requestedBy: 'composite-controller-restart-verify',
    mode: input.mode ?? 'auto',
  });

  if (requested.action === 'restart_scheduled') {
    const scheduled = requested as ControllerRestartScheduledResult;
    evidenceRefs.push(scheduled.statePath, scheduled.logPath);
    const state = await waitForControllerRestartState(slotHome, scheduled.state, input);
    return formatRestartState(repoRoot, slotHome, state, input, evidenceRefs, oldPids);
  }

  // Sync restart completed inline.
  const status = requested.status as ControllerServiceStatus;
  const synthetic: ControllerRestartState = {
    schemaVersion: 1,
    requestId: input.requestId ?? `sync-${Date.now()}`,
    repoRoot,
    controllerHome: slotHome,
    phase: 'succeeded',
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestedBy: 'composite-controller-restart-verify',
    delayMs: 0,
    previousGeneration: before.runtimeGeneration,
    runtimeGeneration: status.runtimeGeneration,
    completedAt: new Date().toISOString(),
  };
  const post = validateRestartSuccess({
    state: synthetic,
    status,
    oldManagedPids: oldPids,
    expectedSourceCommit: input.expectedSourceCommit,
    expectedToolFingerprint: input.expectedToolFingerprint,
  });
  if (!post.ok) {
    return compositeFailed({
      phase: 'postcondition',
      summary: 'restart completed but postcondition failed',
      failedCheck: 'restart_postcondition',
      keyOutput: post.failures.join('\n'),
      evidenceRefs,
      details: { status, post },
    });
  }
  return compositeSucceeded({
    phase: 'succeeded',
    summary: 'controller restart verified',
    keyOutput: [
      `generation=${status.runtimeGeneration}`,
      `gateway=${status.health.mcp}`,
      `daemon=${status.daemon.status}`,
      `local=${status.health.localController}`,
      `source=${status.runtimeSource?.commit ?? 'unknown'}`,
    ].join('\n'),
    evidenceRefs,
    nextAction: 'continue work on the active controller',
    details: { status, oldPids },
  });
}

async function formatRestartState(
  repoRoot: string,
  slotHome: string,
  state: ControllerRestartState,
  input: ControllerRestartVerifyInput,
  evidenceRefs: string[],
  oldPids: number[] = [],
): Promise<CompositeToolResult> {
  evidenceRefs.push(
    join(slotHome, 'restart', 'current.json'),
    join(slotHome, 'restart', 'requests', `${state.requestId}.json`),
  );
  if (state.phase === 'failed') {
    return compositeFailed({
      phase: state.phase,
      summary: 'controller restart failed',
      failedCheck: 'restart',
      keyOutput: state.error ?? state.verification?.failures.join('; ') ?? 'unknown failure',
      evidenceRefs,
      retryable: true,
      nextAction: 'inspect restart coordinator log and retry with a new request id only after failure is terminal',
      details: { state },
    });
  }
  if (state.phase !== 'succeeded') {
    return compositeRunning({
      phase: state.phase,
      summary: `controller restart in progress (${state.phase})`,
      keyOutput: `requestId=${state.requestId} phase=${state.phase}`,
      evidenceRefs,
      nextAction: 'poll controller_restart_verify with the same requestId and pollOnly=true',
      details: { state },
    });
  }

  const status = await controllerServiceStatus({ repo: repoRoot, controllerHome: slotHome });
  const post = validateRestartSuccess({
    state,
    status,
    oldManagedPids: oldPids,
    expectedSourceCommit: input.expectedSourceCommit,
    expectedToolFingerprint: input.expectedToolFingerprint,
  });
  if (!post.ok) {
    return compositeFailed({
      phase: 'postcondition',
      summary: 'restart state succeeded but live postcondition failed',
      failedCheck: 'restart_postcondition',
      keyOutput: post.failures.join('\n'),
      evidenceRefs,
      details: { state, status, post },
    });
  }
  return compositeSucceeded({
    phase: 'succeeded',
    summary: 'controller restart verified',
    keyOutput: [
      `requestId=${state.requestId}`,
      `generation=${status.runtimeGeneration}`,
      `gateway=${status.health.mcp}`,
      `daemon=${status.daemon.status}`,
      `scheduler=${status.readiness.scheduler}`,
      `local=${status.health.localController}`,
      `public=${status.readiness.public}`,
      `fingerprint=${status.mcpRuntime?.server.toolSurfaceFingerprint ?? 'n/a'}`,
      `source=${status.runtimeSource?.commit ?? 'unknown'}`,
    ].join('\n'),
    evidenceRefs,
    nextAction: 'continue; do not resubmit the same requestId',
    details: { state, status },
  });
}

export interface ControllerFeatureVerifyInput {
  repo?: string;
  unitTestArgs?: string[];
  lifecycleTestArgs?: string[];
  skipLifecycle?: boolean;
  timeoutMs?: number;
}

/**
 * Feature-branch gate: unit tests + isolated lifecycle suite + dirty check.
 * Does not push and does not touch the real controller home.
 */
export function controllerFeatureVerify(input: ControllerFeatureVerifyInput = {}): CompositeToolResult {
  const repoRoot = resolve(resolveMcpRepoRoot(input.repo ?? '.'));
  const snapshot = gitSnapshot(repoRoot);
  const evidenceRefs: string[] = [];
  const timeoutMs = Math.max(30_000, input.timeoutMs ?? 180_000);

  const unitArgs = input.unitTestArgs?.length
    ? input.unitTestArgs
    : [
      'test',
      'tests/cli/controller-lifecycle-authority.test.ts',
      'tests/cli/runtime-slots.test.ts',
      'tests/cli/composite-operations.test.ts',
      'tests/cli/session-cache.test.ts',
    ];
  const unit = runProcess('bun', unitArgs, {
    cwd: repoRoot,
    timeoutMs,
    maxOutputBytes: 512 * 1024,
  });
  if (!unit.ok) {
    return compositeFailed({
      phase: 'unit',
      summary: 'unit tests failed; green rollout not allowed',
      failedCheck: 'unit_tests',
      exitCode: unit.status,
      keyOutput: usefulTail(unit.stdout, unit.stderr || unit.error || ''),
      retryable: false,
      nextAction: 'fix Level 1 failures before lifecycle suite',
      details: { branch: snapshot.branch, head: snapshot.head },
    });
  }

  if (!input.skipLifecycle) {
    const lifeArgs = input.lifecycleTestArgs?.length
      ? input.lifecycleTestArgs
      : ['test', 'tests/cli/controller-bluegreen-isolated.test.ts'];
    const life = runProcess('bun', lifeArgs, {
      cwd: repoRoot,
      timeoutMs: Math.max(timeoutMs, 240_000),
      maxOutputBytes: 512 * 1024,
      env: {
        ...process.env,
        // Force isolation — never inherit real controller home.
        REPO_HARNESS_CONTROLLER_HOME: '',
        REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER: '',
      },
    });
    if (!life.ok) {
      return compositeFailed({
        phase: 'lifecycle',
        summary: 'isolated lifecycle suite failed; green rollout not allowed',
        failedCheck: 'lifecycle_isolated',
        exitCode: life.status,
        keyOutput: usefulTail(life.stdout, life.stderr || life.error || ''),
        retryable: false,
        nextAction: 'fix Level 2 isolation failures; do not run real rollout',
      });
    }
  }

  const dirty = git(repoRoot, ['status', '--porcelain']);
  const dirtyLines = dirty.stdout.split(/\n/).filter(Boolean);
  // Feature verify allows dirty tree but reports it; green rollout decision is explicit.
  const allowRollout = unit.ok;
  return compositeSucceeded({
    phase: 'feature-gate',
    summary: allowRollout
      ? 'feature branch passed unit/lifecycle gates; green rollout allowed'
      : 'feature branch not ready for green rollout',
    keyOutput: [
      `branch=${snapshot.branch}`,
      `head=${snapshot.head}`,
      `dirty=${dirtyLines.length}`,
      `allowGreenRollout=${allowRollout}`,
      dirtyLines.length ? `dirtyFiles=${dirtyLines.slice(0, 20).join(' | ')}` : 'worktree clean',
    ].join('\n'),
    evidenceRefs,
    nextAction: allowRollout
      ? 'run controller rollout (green) when ready; do not push automatically'
      : 'fix remaining failures',
    details: {
      branch: snapshot.branch,
      head: snapshot.head,
      dirtyFiles: dirtyLines,
      allowGreenRollout: allowRollout,
    },
  });
}

export { controllerRollout };
