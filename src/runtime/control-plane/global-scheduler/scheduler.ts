import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { cpus, freemem, loadavg } from 'os';
import { listRepositories } from '../../../cli/repositories/registry';
import { ensureControllerHome } from '../../../cli/repositories/controller-home';
import { withControllerLock } from '../../../cli/repositories/locks';
import { attachExecutionWorker, getExecutionJob, listActiveExecutionJobs, transitionExecutionJob } from '../../execution/jobs/store';
import { releaseExecutionLeases } from '../../resources/leases/store';
import { RepoActorRegistry } from '../repo-actor/registry';
import { reconcileExecutionJobsAsync } from './reconciliation';
import { tickSchedules } from '../../workflow/schedules/engine';
import { tickPortfolioWorkflows } from '../../workflow/portfolio/engine';
import { readJsonFile, writeJsonAtomic } from '../../shared/json-files';
import { isProcessAlive, terminateProcessTree } from '../../shared/process-tree';
import { readSchedulerWakeSignal, waitForSchedulerWakeSignal } from './wake-signal';
import { cleanupControllerRuntimeState } from '../runtime-cleanup';

const DARWIN_MEMORY_SAMPLE_TTL_MS = 5_000;
const RUNTIME_CLEANUP_INTERVAL_MS = Math.max(30_000, Number(process.env.REPO_HARNESS_RUNTIME_CLEANUP_INTERVAL_MS ?? 60_000));
const DARWIN_RECLAIMABLE_PAGE_LABELS = new Set([
  'Pages free',
  'Pages inactive',
  'Pages speculative',
  'Pages purgeable',
]);

export function parseDarwinAvailableMemoryMb(output: string): number | undefined {
  const pageSizeMatch = /page size of\s+(\d+)\s+bytes/i.exec(output);
  const pageSize = Number(pageSizeMatch?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return undefined;

  let reclaimablePages = 0;
  let matched = false;
  for (const rawLine of output.split('\n')) {
    const match = /^([^:]+):\s+(\d+)\.?$/.exec(rawLine.trim());
    if (!match || !DARWIN_RECLAIMABLE_PAGE_LABELS.has(match[1])) continue;
    reclaimablePages += Number(match[2]);
    matched = true;
  }
  if (!matched) return undefined;
  return reclaimablePages * pageSize / (1024 * 1024);
}

export function isSchedulerResourcePressured(
  snapshot: { freeMemoryMb: number; loadPerCpu: number },
  limits: { minFreeMemoryMb: number; maxLoadPerCpu: number },
): boolean {
  return snapshot.freeMemoryMb < limits.minFreeMemoryMb || snapshot.loadPerCpu > limits.maxLoadPerCpu;
}

interface SchedulerState {
  schemaVersion: 1;
  updatedAt: string;
  loopStartedAt?: string;
  lastTickAt?: string;
  lastDispatchAt?: string;
  lastReconcileAt?: string;
  lastRepoDispatch: Record<string, number>;
}

function schedulerStatePath(controllerHome: string): string {
  return join(ensureControllerHome(controllerHome), 'scheduler', 'state.json');
}

export interface SchedulerHealthSnapshot {
  schemaVersion: 1;
  updatedAt: string;
  loopStartedAt?: string;
  lastTickAt?: string;
  lastDispatchAt?: string;
  lastReconcileAt?: string;
  lastRepoDispatch: Record<string, number>;
}

export function readSchedulerHealthSnapshot(controllerHome: string): SchedulerHealthSnapshot {
  return readJsonFile<SchedulerHealthSnapshot>(schedulerStatePath(controllerHome), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    lastRepoDispatch: {},
  });
}

export interface SchedulerConfig {
  maxWorkers: number;
  maxConcurrentRepositories: number;
  pollIntervalMs: number;
  idleBackoffMaxMs: number;
  maxHeavyChecks: number;
  maxAgentProcesses: number;
  maxCodexProcesses: number;
  maxClaudeProcesses: number;
  maxGitHubProcesses: number;
  minFreeMemoryMb: number;
  maxLoadPerCpu: number;
}

export interface SchedulerRuntimeBinding {
  controllerPid?: number;
  controllerStartedAt?: string;
}

export class GlobalScheduler {
  private readonly controllerHome: string;
  private readonly actors: RepoActorRegistry;
  private readonly children = new Map<string, ChildProcess>();
  private readonly config: SchedulerConfig;
  private readonly controllerPid: number;
  private readonly controllerStartedAt?: string;
  private lastScheduleTick = 0;
  private lastPortfolioTick = 0;
  private lastReconcile = 0;
  private lastPersistedAt = 0;
  private readonly lastRepoDispatch = new Map<string, number>();
  private readonly loopStartedAt = new Date().toISOString();
  private lastTickAt = this.loopStartedAt;
  private lastDispatchAt: string | undefined;
  private lastReconcileAt: string | undefined;
  private lastCleanupAt = 0;
  private runtimeCleanup = cleanupControllerRuntimeState;
  private lastDarwinMemorySampleAt = 0;
  private cachedDarwinAvailableMemoryMb: number | undefined;

  constructor(
    controllerHome: string,
    config: Partial<SchedulerConfig> = {},
    runtime: SchedulerRuntimeBinding = {},
  ) {
    this.controllerHome = controllerHome;
    this.actors = new RepoActorRegistry(controllerHome);
    this.config = {
      maxWorkers: Math.max(1, config.maxWorkers ?? Number(process.env.REPO_HARNESS_MAX_WORKERS ?? 4)),
      maxConcurrentRepositories: Math.max(1, config.maxConcurrentRepositories ?? Number(process.env.REPO_HARNESS_MAX_ACTIVE_REPOS ?? 4)),
      pollIntervalMs: Math.max(50, config.pollIntervalMs ?? 250),
      idleBackoffMaxMs: Math.max(250, config.idleBackoffMaxMs ?? Number(process.env.REPO_HARNESS_IDLE_BACKOFF_MAX_MS ?? 2_000)),
      maxHeavyChecks: Math.max(1, config.maxHeavyChecks ?? Number(process.env.REPO_HARNESS_MAX_HEAVY_CHECKS ?? 2)),
      maxAgentProcesses: Math.max(1, config.maxAgentProcesses ?? Number(process.env.REPO_HARNESS_MAX_AGENT_PROCESSES ?? 4)),
      maxCodexProcesses: Math.max(1, config.maxCodexProcesses ?? Number(process.env.REPO_HARNESS_MAX_CODEX_PROCESSES ?? 3)),
      maxClaudeProcesses: Math.max(1, config.maxClaudeProcesses ?? Number(process.env.REPO_HARNESS_MAX_CLAUDE_PROCESSES ?? 2)),
      maxGitHubProcesses: Math.max(1, config.maxGitHubProcesses ?? Number(process.env.REPO_HARNESS_MAX_GITHUB_PROCESSES ?? 2)),
      minFreeMemoryMb: Math.max(64, config.minFreeMemoryMb ?? Number(process.env.REPO_HARNESS_MIN_FREE_MEMORY_MB ?? 512)),
      maxLoadPerCpu: Math.max(0.25, config.maxLoadPerCpu ?? Number(process.env.REPO_HARNESS_MAX_LOAD_PER_CPU ?? 1.5)),
    };
    this.controllerPid = runtime.controllerPid ?? process.pid;
    this.controllerStartedAt = runtime.controllerStartedAt;
    const state = readJsonFile<SchedulerState>(schedulerStatePath(controllerHome), { schemaVersion: 1, updatedAt: new Date().toISOString(), lastRepoDispatch: {} });
    for (const [repoId, timestamp] of Object.entries(state.lastRepoDispatch)) {
      if (Number.isFinite(timestamp)) this.lastRepoDispatch.set(repoId, timestamp);
    }
  }

  private persistState(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPersistedAt < 1_000) return;
    this.lastPersistedAt = now;
    writeJsonAtomic(schedulerStatePath(this.controllerHome), {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      loopStartedAt: this.loopStartedAt,
      lastTickAt: this.lastTickAt,
      lastDispatchAt: this.lastDispatchAt,
      lastReconcileAt: this.lastReconcileAt,
      lastRepoDispatch: Object.fromEntries(this.lastRepoDispatch),
    } satisfies SchedulerState);
  }

  private pidAlive(pid: number | undefined): boolean {
    return isProcessAlive(pid);
  }

  private async cleanupSpawnedWorkers(): Promise<void> {
    const workers = [...this.children.values()];
    this.children.clear();
    await Promise.all(workers.map((child) => terminateProcessTree(child.pid)));
  }

  private spawnWorker(repoId: string, jobId: string): boolean {
    const tracked = this.children.get(jobId);
    if (tracked?.pid && this.pidAlive(tracked.pid)) return false;
    const current = getExecutionJob(this.controllerHome, repoId, jobId);
    if (!['dispatched', 'running'].includes(current.status)) return false;
    if (current.workerPid && this.pidAlive(current.workerPid)) return false;
    const entry = fileURLToPath(new URL('../../execution/workers/worker-entry.ts', import.meta.url));
    const bun = Boolean(process.versions.bun);
    const loader = fileURLToPath(new URL('../../shared/node-ts-loader.mjs', import.meta.url));
    const workerArgs = [
      '--controller-home', this.controllerHome,
      '--repo-id', repoId,
      '--job-id', jobId,
      '--controller-pid', String(this.controllerPid),
    ];
    if (this.controllerStartedAt) workerArgs.push('--controller-started-at', this.controllerStartedAt);
    const args = bun
      ? [entry, ...workerArgs]
      : ['--loader', loader, entry, ...workerArgs];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
      env: { ...process.env, REPO_HARNESS_EXECUTION_WORKER: '1' },
    });
    let activated = false;
    child.once('error', (error) => {
      this.children.delete(jobId);
      if (!activated || !child.pid) return;
      try {
        const current = getExecutionJob(this.controllerHome, repoId, jobId);
        if (current.status !== 'running' || current.workerPid !== child.pid) return;
        releaseExecutionLeases(this.controllerHome, repoId, jobId, current.leaseRefs);
      } catch { /* job may already be terminal or replaced */ }
      try {
        transitionExecutionJob(this.controllerHome, repoId, jobId, 'failed', {
          error: { code: 'WORKER_SPAWN_FAILED', message: error.message, retryable: true },
          leaseRefs: [],
        });
      } catch { /* job may already be terminal */ }
    });
    child.once('exit', () => this.children.delete(jobId));
    if (!child.pid) {
      child.unref();
      return false;
    }
    const attached = attachExecutionWorker(this.controllerHome, repoId, jobId, child.pid);
    if (!attached) {
      void terminateProcessTree(child.pid);
      child.unref();
      return false;
    }
    activated = true;
    this.children.set(jobId, child);
    child.unref();
    return true;
  }

  private availableMemoryMb(now = Date.now()): number {
    const fallback = freemem() / (1024 * 1024);
    if (process.platform !== 'darwin') return fallback;
    if (
      this.cachedDarwinAvailableMemoryMb !== undefined
      && now - this.lastDarwinMemorySampleAt < DARWIN_MEMORY_SAMPLE_TTL_MS
    ) {
      return this.cachedDarwinAvailableMemoryMb;
    }

    this.lastDarwinMemorySampleAt = now;
    try {
      const output = execFileSync('vm_stat', [], {
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      });
      this.cachedDarwinAvailableMemoryMb = parseDarwinAvailableMemoryMb(output) ?? fallback;
    } catch {
      this.cachedDarwinAvailableMemoryMb = fallback;
    }
    return this.cachedDarwinAvailableMemoryMb;
  }

  private resourcePressure(): { pressured: boolean; freeMemoryMb: number; loadPerCpu: number } {
    const freeMemoryMb = this.availableMemoryMb();
    const loadPerCpu = loadavg()[0] / Math.max(1, cpus().length);
    return {
      pressured: isSchedulerResourcePressured(
        { freeMemoryMb, loadPerCpu },
        { minFreeMemoryMb: this.config.minFreeMemoryMb, maxLoadPerCpu: this.config.maxLoadPerCpu },
      ),
      freeMemoryMb,
      loadPerCpu,
    };
  }

  private agentProvider(job: { payload: { arguments?: Record<string, unknown> } }): 'codex' | 'claude' | 'github-copilot' {
    const agent = job.payload.arguments?.agent;
    if (agent === 'claude' || agent === 'github-copilot') return agent;
    return 'codex';
  }

  async tick(): Promise<{ activeJobs: number }> {
    const now = Date.now();
    this.lastTickAt = new Date(now).toISOString();
    if (now - this.lastCleanupAt >= RUNTIME_CLEANUP_INTERVAL_MS) {
      // Advance the interval before cleanup so a failing pass cannot create a
      // tight retry loop on every scheduler tick.
      this.lastCleanupAt = now;
      try {
        this.runtimeCleanup(this.controllerHome, {
          reason: 'periodic',
          nowMs: now,
          protectedControllerPid: this.controllerPid,
        });
      } catch (error) {
        console.error('[repo-harness cleanup] periodic cleanup failed:', error);
      }
    }
    if (now - this.lastReconcile >= 5_000) {
      await reconcileExecutionJobsAsync(this.controllerHome);
      this.lastReconcile = now;
      this.lastReconcileAt = new Date(now).toISOString();
    }
    const repositories = listRepositories(this.controllerHome).filter((repo) => repo.enabled && !repo.removedAt);
    if (now - this.lastScheduleTick >= 30_000) {
      await tickSchedules(this.controllerHome, repositories.map((repo) => repo.repoId));
      this.lastScheduleTick = now;
    }
    if (now - this.lastPortfolioTick >= 1_000) {
      tickPortfolioWorkflows(this.controllerHome);
      this.lastPortfolioTick = now;
    }
    let activeJobs = 0;
    try {
      activeJobs = withControllerLock(
        this.controllerHome,
        {
          scope: 'task',
          repoId: '__controller__',
          taskId: 'global-scheduler-dispatch',
        },
        `global-scheduler:${this.controllerPid}`,
        () => {
          const active = listActiveExecutionJobs(this.controllerHome);
          const reserved = active.filter((job) => job.status === 'running' || job.status === 'dispatched');
          let capacity = this.config.maxWorkers - reserved.length;
          if (capacity <= 0) return active.length;

          let heavyCapacity = this.config.maxHeavyChecks
            - reserved.filter((job) => job.type === 'check' || job.type === 'verify-edit').length;
          const reservedAgents = reserved.filter((job) => job.type === 'agent-run' || job.type === 'dispatch-task');
          let agentCapacity = this.config.maxAgentProcesses - reservedAgents.length;
          const providerCapacity = new Map([
            ['codex', this.config.maxCodexProcesses - reservedAgents.filter((job) => this.agentProvider(job) === 'codex').length],
            ['claude', this.config.maxClaudeProcesses - reservedAgents.filter((job) => this.agentProvider(job) === 'claude').length],
            ['github-copilot', this.config.maxGitHubProcesses - reservedAgents.filter((job) => this.agentProvider(job) === 'github-copilot').length],
          ] as const);
          const pressure = this.resourcePressure();
          if (pressure.pressured) {
            // Under host pressure, keep one recovery slot available so queued read-only
            // or bounded repository work does not stall forever behind a global stop.
            capacity = Math.min(capacity, 1);
            heavyCapacity = Math.min(heavyCapacity, 1);
            agentCapacity = 0;
            providerCapacity.set('codex', 0);
            providerCapacity.set('claude', 0);
            providerCapacity.set('github-copilot', 0);
          }
          if (capacity <= 0) return active.length;

          const priorityWeight: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
          const agingWindowMs = 30 * 60_000;
          const effectivePriority = (job: (typeof active)[number], at = Date.now()): number => {
            const age = Math.max(0, at - Date.parse(job.queuedAt));
            return Math.max(0, priorityWeight[job.priority] - Math.floor(age / agingWindowMs));
          };
          const compareWaiting = (left: (typeof active)[number], right: (typeof active)[number]): number => {
            const at = Date.now();
            return effectivePriority(left, at) - effectivePriority(right, at)
              || left.queuedAt.localeCompare(right.queuedAt)
              || left.jobId.localeCompare(right.jobId);
          };
          const waiting = active.filter((job) => job.status !== 'running' && job.status !== 'dispatched');
          const topByRepo = new Map<string, (typeof active)[number]>();
          for (const job of waiting.slice().sort(compareWaiting)) {
            if (!topByRepo.has(job.repoId)) topByRepo.set(job.repoId, job);
          }
          const repoIds = [...topByRepo.keys()].sort((left, right) => {
            const leftTop = topByRepo.get(left)!;
            const rightTop = topByRepo.get(right)!;
            const priority = effectivePriority(leftTop) - effectivePriority(rightTop);
            if (priority !== 0) return priority;
            const fairness = (this.lastRepoDispatch.get(left) ?? 0) - (this.lastRepoDispatch.get(right) ?? 0);
            return fairness || leftTop.queuedAt.localeCompare(rightTop.queuedAt) || left.localeCompare(right);
          });
          const reservedRepos = new Set(reserved.map((job) => job.repoId));
          for (const repoId of repoIds) {
            if (capacity <= 0) break;
            if (!reservedRepos.has(repoId) && reservedRepos.size >= this.config.maxConcurrentRepositories) continue;
            const top = topByRepo.get(repoId);
            if (top && (top.type === 'check' || top.type === 'verify-edit') && heavyCapacity <= 0) continue;
            if (top && (top.type === 'agent-run' || top.type === 'dispatch-task')) {
              if (agentCapacity <= 0) continue;
              if ((providerCapacity.get(this.agentProvider(top)) ?? 0) <= 0) continue;
            }

            const dispatch = this.actors.get(repoId).tryClaimNext();
            if (!dispatch) continue;

            // A successful claim is the capacity reservation. Count it immediately,
            // before the worker PID is spawned or attached, so concurrent schedulers
            // cannot over-dispatch through the dispatched -> running window.
            capacity -= 1;
            reservedRepos.add(repoId);
            if (dispatch.job.type === 'check' || dispatch.job.type === 'verify-edit') heavyCapacity -= 1;
            if (dispatch.job.type === 'agent-run' || dispatch.job.type === 'dispatch-task') {
              agentCapacity -= 1;
              const provider = this.agentProvider(dispatch.job);
              providerCapacity.set(provider, (providerCapacity.get(provider) ?? 0) - 1);
            }
            const dispatchedAt = Date.now();
            this.lastRepoDispatch.set(repoId, dispatchedAt);
            this.lastDispatchAt = new Date(dispatchedAt).toISOString();
            this.persistState(true);
            this.spawnWorker(repoId, dispatch.job.jobId);
          }
          return active.length;
        },
        5_000,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('LOCK_HELD:')) throw error;
      // Another scheduler owns the global dispatch reservation. Fail closed and
      // leave all jobs queued for the next wake/tick rather than risking overrun.
      activeJobs = listActiveExecutionJobs(this.controllerHome).length;
    }
    this.persistState();
    return { activeJobs };
  }

  async run(signal?: AbortSignal): Promise<void> {
    this.persistState(true);
    let idleStreak = 0;
    try {
      while (!signal?.aborted) {
        try {
          const { activeJobs } = await this.tick();
          idleStreak = activeJobs === 0 ? idleStreak + 1 : 0;
        } catch (error) {
          idleStreak = 0;
          this.lastTickAt = new Date().toISOString();
          this.persistState(true);
          console.error('[repo-harness scheduler] tick failed:', error);
        }
        const delayMs = idleStreak > 0
          ? Math.min(
            this.config.idleBackoffMaxMs,
            this.config.pollIntervalMs * (2 ** Math.min(idleStreak, 6)),
          )
          : this.config.pollIntervalMs;
        const wakeRevision = readSchedulerWakeSignal(this.controllerHome).revision;
        const waitResult = await waitForSchedulerWakeSignal(this.controllerHome, wakeRevision, delayMs, signal);
        if (waitResult === 'aborted') break;
      }
    } finally {
      await this.cleanupSpawnedWorkers();
    }
  }
}
