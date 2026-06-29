import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, normalize, relative, resolve } from 'path';
import {
  capProcessOutput,
  redactProcessOutput,
  runProcess,
  type ProcessRunResult,
} from '../../effects/process-runner';
import { atomicWriteFileSync } from '../installer/shared';
import { listProcessTreeMembers, terminateProcessTree } from '../../runtime/shared/process-tree';

export interface ControllerCheck {
  id: string;
  description: string;
  command: string[];
  cwd: string;
  timeoutMs: number;
  source: 'repo-config' | 'package-script';
}

interface CheckConfig {
  version?: number;
  checks?: Record<string, {
    description?: string;
    command?: unknown;
    cwd?: string;
    timeoutMs?: number;
  }>;
}

const CHECK_CONFIG = '.repo-harness/checks.json';
const CHECK_EVIDENCE_ROOT = '.ai/harness/checks/controller';
const HEAVY_CHECK_LOCK = '.ai/harness/controller/heavy-check.lock';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const SAFE_PACKAGE_SCRIPT = /^(test(?::|$)|check(?::|$)|lint(?::|$)|typecheck(?::|$)|format:check$)/;

function boundedTimeout(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 5_000), MAX_TIMEOUT_MS);
}

function normalizeCwd(repoRoot: string, value: string | undefined): string {
  const rel = normalize((value ?? '.').trim() || '.').replace(/\\/g, '/');
  const absolute = resolve(repoRoot, rel);
  const back = relative(repoRoot, absolute).replace(/\\/g, '/');
  if (back === '..' || back.startsWith('../')) throw new Error(`check cwd escapes repository: ${value}`);
  return back || '.';
}

function configuredChecks(repoRoot: string): ControllerCheck[] {
  const path = join(repoRoot, CHECK_CONFIG);
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, 'utf-8')) as CheckConfig;
  return Object.entries(config.checks ?? {}).flatMap(([id, value]) => {
    if (!Array.isArray(value.command) || value.command.length === 0 || value.command.some((part) => typeof part !== 'string' || part.length === 0)) return [];
    return [{
      id,
      description: value.description?.trim() || `Repository check ${id}`,
      command: value.command as string[],
      cwd: normalizeCwd(repoRoot, value.cwd),
      timeoutMs: boundedTimeout(value.timeoutMs),
      source: 'repo-config' as const,
    }];
  });
}

function packageChecks(repoRoot: string): ControllerCheck[] {
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return [];
  const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { scripts?: Record<string, unknown> };
  return Object.entries(pkg.scripts ?? {}).flatMap(([name, value]) => {
    if (typeof value !== 'string' || !SAFE_PACKAGE_SCRIPT.test(name)) return [];
    return [{
      id: `package:${name}`,
      description: `Run package script ${name}`,
      command: ['bun', 'run', name],
      cwd: '.',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      source: 'package-script' as const,
    }];
  });
}

export function listControllerChecks(repoRoot: string): ControllerCheck[] {
  const byId = new Map<string, ControllerCheck>();
  for (const check of [...packageChecks(repoRoot), ...configuredChecks(repoRoot)]) byId.set(check.id, check);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface ControllerCheckResult {
  check: ControllerCheck;
  ok: boolean;
  status: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  command: readonly string[];
  executedAt: string;
  artifactPath: string;
}

export interface ControllerCheckEvidence {
  schemaVersion: 1;
  checkId: string;
  description: string;
  source: ControllerCheck['source'];
  command: readonly string[];
  cwd: string;
  ok: boolean;
  status: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  executedAt: string;
  revision?: string;
  cacheKey?: string;
  completedRevision?: string;
  stale?: boolean;
}

function artifactSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'check';
}

function evidencePath(repoRoot: string, id: string): string {
  return join(repoRoot, CHECK_EVIDENCE_ROOT, `latest-${artifactSlug(id)}.json`);
}

const CHECK_REVISION_EXCLUDES = [
  '.ai/harness/jobs/**',
  '.ai/harness/local-jobs/**',
  '.ai/harness/checks/controller/**',
  '.ai/harness/edit-sessions/**',
  '.ai/harness/worktrees/**',
  '.ai/harness/controller/**',
  '.ai/harness/artifacts/**',
  '.ai/harness/local-bridge/**',
  '.ai/harness/ephemeral-issues/**',
];

function checkRevisionPathspecs(): string[] {
  return ['.', ...CHECK_REVISION_EXCLUDES.map((path) => `:(exclude)${path}`)];
}

export function currentControllerCheckRevision(repoRoot: string): string {
  const head = runProcess('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
  });
  if (!head.ok) {
    const fallback = createHash('sha256').update('non-git\n');
    for (const relativePath of ['package.json', CHECK_CONFIG]) {
      const path = join(repoRoot, relativePath);
      fallback.update(`${relativePath}\n`);
      if (existsSync(path)) fallback.update(readFileSync(path));
    }
    return fallback.digest('hex').slice(0, 24);
  }

  const diff = runProcess('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', ...checkRevisionPathspecs()], {
    cwd: repoRoot,
    timeoutMs: 15_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  const untracked = runProcess('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...checkRevisionPathspecs()], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const revision = createHash('sha256')
    .update(`${head.stdout.trim()}\n`)
    .update(diff.ok ? diff.stdout : `diff-error:${diff.error || diff.stderr}`);
  if (untracked.ok) {
    const paths = untracked.stdout.split('\0').filter(Boolean).sort();
    for (const relativePath of paths) {
      revision.update(`\n${relativePath}\n`);
      const path = resolve(repoRoot, relativePath);
      try {
        revision.update(readFileSync(path));
      } catch (_error) {
        revision.update('unreadable');
      }
    }
  } else {
    revision.update(`\nuntracked-error:${untracked.error || untracked.stderr}`);
  }
  return revision.digest('hex').slice(0, 24);
}

function checkEnvironmentFingerprint(): string {
  return createHash('sha256')
    .update(JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      bun: typeof Bun !== 'undefined' ? Bun.version : undefined,
    }))
    .digest('hex')
    .slice(0, 16);
}

function buildCheckCacheKey(check: ControllerCheck, timeoutMs: number, revision: string): string {
  return createHash('sha256')
    .update(JSON.stringify({
      id: check.id,
      command: check.command,
      cwd: check.cwd,
      timeoutMs,
      revision,
      environment: checkEnvironmentFingerprint(),
    }))
    .digest('hex')
    .slice(0, 24);
}

function persistCheckEvidence(
  repoRoot: string,
  result: Omit<ControllerCheckResult, 'artifactPath'>,
  meta: { revision?: string; cacheKey?: string; completedRevision?: string; stale?: boolean } = {},
): string {
  const path = evidencePath(repoRoot, result.check.id);
  mkdirSync(dirname(path), { recursive: true });
  const evidence: ControllerCheckEvidence = {
    schemaVersion: 1,
    checkId: result.check.id,
    description: result.check.description,
    source: result.check.source,
    command: result.command,
    cwd: result.check.cwd,
    ok: result.ok,
    status: result.status,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    executedAt: result.executedAt,
    revision: meta.revision,
    cacheKey: meta.cacheKey,
    completedRevision: meta.completedRevision,
    stale: meta.stale,
  };
  atomicWriteFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return relative(repoRoot, path).replace(/\\/g, '/');
}

export function readLatestControllerCheckEvidence(repoRoot: string, id: string): ControllerCheckEvidence | undefined {
  const path = evidencePath(repoRoot, id);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as ControllerCheckEvidence;
    return value.schemaVersion === 1 && value.checkId === id ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

export function runControllerCheck(repoRoot: string, id: string, requestedTimeoutMs?: number): ControllerCheckResult {
  const check = listControllerChecks(repoRoot).find((entry) => entry.id === id);
  if (!check) throw new Error(`check not found: ${id}`);
  const timeoutMs = requestedTimeoutMs === undefined ? check.timeoutMs : Math.min(check.timeoutMs, boundedTimeout(requestedTimeoutMs));
  const revision = currentControllerCheckRevision(repoRoot);
  const cacheKey = buildCheckCacheKey(check, timeoutMs, revision);
  const cached = readLatestControllerCheckEvidence(repoRoot, id);
  if (cached?.cacheKey === cacheKey) {
    return {
      check,
      ok: cached.ok,
      status: cached.status,
      timedOut: cached.timedOut,
      stdout: cached.stdout,
      stderr: cached.stderr,
      command: cached.command,
      executedAt: cached.executedAt,
      artifactPath: relative(repoRoot, evidencePath(repoRoot, id)).replace(/\\/g, '/'),
    };
  }
  const heavy = controllerCheckConcurrencyClass(id) === 'heavy';
  const lease = heavy ? tryAcquireHeavyCheckLock(repoRoot, id) : undefined;
  if (heavy && !lease) throw new Error(`heavy check already running for repository: ${id}`);
  let result: ProcessRunResult;
  try {
    result = runProcess(check.command[0], check.command.slice(1), {
      cwd: resolve(repoRoot, check.cwd),
      timeoutMs,
      maxOutputBytes: 256 * 1024,
    });
  } finally {
    lease?.release();
  }
  const completedRevision = currentControllerCheckRevision(repoRoot);
  const stale = completedRevision !== revision;
  const withoutPath = {
    check,
    ok: result.ok && !stale,
    status: stale ? 1 : result.status,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: [
      result.stderr || result.error,
      stale ? 'repository revision changed while the check was running; evidence is stale and the check must be rerun' : '',
    ].filter(Boolean).join('\n'),
    command: result.command,
    executedAt: new Date().toISOString(),
  };
  return {
    ...withoutPath,
    artifactPath: persistCheckEvidence(repoRoot, withoutPath, {
      revision,
      completedRevision,
      stale,
      cacheKey: stale ? undefined : cacheKey,
    }),
  };
}

export interface AsyncControllerCheckOptions {
  requestedTimeoutMs?: number;
  onSpawn?: (pid: number) => void;
  subscriberId?: string;
}

interface ActiveAsyncCheck {
  promise: Promise<ControllerCheckResult>;
  pid?: number;
  spawnListeners: Set<(pid: number) => void>;
  subscriberIds: Set<string>;
  anonymousSubscribers: number;
  cancelWhenSpawned: boolean;
}

const activeAsyncChecks = new Map<string, ActiveAsyncCheck>();
const activeAsyncCheckSubscriptions = new Map<string, ActiveAsyncCheck>();
const heavyCheckQueues = new Map<string, Promise<void>>();

export function controllerCheckConcurrencyClass(id: string): 'heavy' | 'light' {
  return /(?:^|:)(?:test(?::coverage)?|check:(?:ci|controller-v8|public-export|release(?:-[a-z0-9-]+)?))$/.test(id)
    ? 'heavy'
    : 'light';
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

interface HeavyCheckLockRecord {
  lockId?: string;
  pid?: number;
  controllerPid?: number;
  childPid?: number;
  checkId: string;
  createdAt: string;
}

interface HeavyCheckLease {
  setChildPid(pid: number): void;
  release(): void;
}

function tryAcquireHeavyCheckLock(repoRoot: string, checkId: string): HeavyCheckLease | undefined {
  const path = join(repoRoot, HEAVY_CHECK_LOCK);
  mkdirSync(dirname(path), { recursive: true });
  const lockId = `${process.pid}:${Date.now()}:${checkId}`;
  const record: HeavyCheckLockRecord = {
    lockId,
    controllerPid: process.pid,
    checkId,
    createdAt: new Date().toISOString(),
  };
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf-8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: HeavyCheckLockRecord | undefined;
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as HeavyCheckLockRecord;
    } catch (_readError) {
      existing = undefined;
    }
    const orphaned = !isProcessAlive(existing?.controllerPid ?? existing?.pid) && !isProcessAlive(existing?.childPid);
    if (!existing || orphaned) {
      rmSync(path, { force: true });
      return tryAcquireHeavyCheckLock(repoRoot, checkId);
    }
    return undefined;
  }

  const ownsLock = (): boolean => {
    try {
      return (JSON.parse(readFileSync(path, 'utf-8')) as HeavyCheckLockRecord).lockId === lockId;
    } catch (_error) {
      return false;
    }
  };
  return {
    setChildPid(pid: number): void {
      if (ownsLock()) atomicWriteFileSync(path, `${JSON.stringify({ ...record, childPid: pid })}\n`);
    },
    release(): void {
      if (ownsLock()) rmSync(path, { force: true });
    },
  };
}

async function acquireHeavyCheckLock(repoRoot: string, checkId: string): Promise<HeavyCheckLease> {
  const deadline = Date.now() + MAX_TIMEOUT_MS * 2;
  while (true) {
    const lease = tryAcquireHeavyCheckLock(repoRoot, checkId);
    if (lease) return lease;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for repository heavy-check lock before ${checkId}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (_error) {
      // Fall back to the direct child when the process group is already gone.
    }
  }
  try {
    process.kill(pid, signal);
  } catch (_error) {
    // The child may have exited between the timeout and the signal.
  }
}

async function reapResidualCheckProcessTree(
  pid: number | undefined,
): Promise<string | undefined> {
  if (!pid) return undefined;
  const lingering = listProcessTreeMembers(pid);
  if (lingering.length === 0) return undefined;
  const terminated = await terminateProcessTree(pid, {
    gracePeriodMs: 100,
    killAfterMs: 2_000,
    pollIntervalMs: 25,
  });
  if (!terminated.exited) {
    return `check process tree did not exit cleanly; remaining processes: ${terminated.remainingPids.join(', ')}`;
  }
  return `check process tree remained alive after the main command exited; terminated lingering processes: ${lingering.join(', ')}`;
}

export interface ControllerCheckSubscriptionRelease {
  released: boolean;
  remainingSubscribers: number;
  terminationRequested: boolean;
  pid?: number;
}

export function releaseControllerCheckSubscription(subscriberId: string): ControllerCheckSubscriptionRelease {
  const active = activeAsyncCheckSubscriptions.get(subscriberId);
  if (!active) return { released: false, remainingSubscribers: 0, terminationRequested: false };
  activeAsyncCheckSubscriptions.delete(subscriberId);
  active.subscriberIds.delete(subscriberId);
  const remainingSubscribers = active.subscriberIds.size + active.anonymousSubscribers;
  if (remainingSubscribers > 0) {
    return { released: true, remainingSubscribers, terminationRequested: false, pid: active.pid };
  }
  active.cancelWhenSpawned = true;
  if (active.pid) signalProcessTree(active.pid, 'SIGTERM');
  return {
    released: true,
    remainingSubscribers: 0,
    terminationRequested: true,
    pid: active.pid,
  };
}

async function executeControllerCheckAsync(
  repoRoot: string,
  check: ControllerCheck,
  timeoutMs: number,
  onSpawn?: (pid: number) => void,
): Promise<ControllerCheckResult> {
  const maxOutputBytes = 256 * 1024;
  const command = [check.command[0], ...check.command.slice(1)];
  const result = await new Promise<{
    ok: boolean;
    status: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>((resolvePromise) => {
    const child = spawn(check.command[0], check.command.slice(1), {
      cwd: resolve(repoRoot, check.cwd),
      env: { ...process.env },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) onSpawn?.(child.pid);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') <= maxOutputBytes * 2) return next;
      return Buffer.from(next, 'utf8').subarray(-maxOutputBytes * 2).toString('utf8');
    };
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child.pid, 'SIGTERM');
      hardKillTimer = setTimeout(() => signalProcessTree(child.pid, 'SIGKILL'), 2_000);
      hardKillTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();

    const finish = async (status: number, error?: string): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const processTreeError = await reapResidualCheckProcessTree(child.pid);
      const timeoutMessage = timedOut
        ? `process timed out after ${timeoutMs}ms: ${command.join(' ')}`
        : '';
      const stderrText = [stderr, timeoutMessage || error || '', processTreeError || ''].filter(Boolean).join('\n');
      resolvePromise({
        ok: status === 0 && !timedOut && !error && !processTreeError,
        status: processTreeError && status === 0 ? 1 : status,
        timedOut,
        stdout: capProcessOutput(redactProcessOutput(stdout), maxOutputBytes),
        stderr: capProcessOutput(redactProcessOutput(stderrText), maxOutputBytes),
      });
    };

    child.once('error', (error) => { void finish(1, error.message); });
    child.once('close', (code) => { void finish(code ?? 1); });
  });

  const withoutPath = {
    check,
    ok: result.ok,
    status: result.status,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    command: command.map((part) => redactProcessOutput(part)),
    executedAt: new Date().toISOString(),
  };
  return { ...withoutPath, artifactPath: relative(repoRoot, evidencePath(repoRoot, check.id)).replace(/\\/g, '/') };
}

export function runControllerCheckAsync(
  repoRoot: string,
  id: string,
  options: AsyncControllerCheckOptions = {},
): Promise<ControllerCheckResult> {
  const check = listControllerChecks(repoRoot).find((entry) => entry.id === id);
  if (!check) return Promise.reject(new Error(`check not found: ${id}`));
  const timeoutMs = options.requestedTimeoutMs === undefined
    ? check.timeoutMs
    : Math.min(check.timeoutMs, boundedTimeout(options.requestedTimeoutMs));
  const revision = currentControllerCheckRevision(repoRoot);
  const cacheKey = buildCheckCacheKey(check, timeoutMs, revision);
  const cached = readLatestControllerCheckEvidence(repoRoot, id);
  if (cached?.cacheKey === cacheKey) {
    return Promise.resolve({
      check,
      ok: cached.ok,
      status: cached.status,
      timedOut: cached.timedOut,
      stdout: cached.stdout,
      stderr: cached.stderr,
      command: cached.command,
      executedAt: cached.executedAt,
      artifactPath: relative(repoRoot, evidencePath(repoRoot, id)).replace(/\\/g, '/'),
    });
  }
  const key = `${resolve(repoRoot)}\u0000${id}\u0000${cacheKey}`;
  const existing = activeAsyncChecks.get(key);
  if (existing) {
    if (options.subscriberId) {
      existing.subscriberIds.add(options.subscriberId);
      activeAsyncCheckSubscriptions.set(options.subscriberId, existing);
    } else {
      existing.anonymousSubscribers += 1;
    }
    if (options.onSpawn) {
      if (existing.pid) options.onSpawn(existing.pid);
      else existing.spawnListeners.add(options.onSpawn);
    }
    return existing.promise;
  }

  const active: ActiveAsyncCheck = {
    promise: Promise.resolve(undefined as never),
    spawnListeners: new Set(),
    subscriberIds: new Set(),
    anonymousSubscribers: options.subscriberId ? 0 : 1,
    cancelWhenSpawned: false,
  };
  if (options.subscriberId) {
    active.subscriberIds.add(options.subscriberId);
    activeAsyncCheckSubscriptions.set(options.subscriberId, active);
  }
  if (options.onSpawn) active.spawnListeners.add(options.onSpawn);
  const notifySpawn = (pid: number): void => {
    active.pid = pid;
    if (active.cancelWhenSpawned && active.subscriberIds.size === 0 && active.anonymousSubscribers === 0) {
      signalProcessTree(pid, 'SIGTERM');
    }
    for (const listener of active.spawnListeners) listener(pid);
    active.spawnListeners.clear();
  };
  const hasActiveSubscribers = (): boolean => active.subscriberIds.size + active.anonymousSubscribers > 0;
  const assertExecutionStillRequested = (): void => {
    if (active.cancelWhenSpawned && !hasActiveSubscribers()) {
      throw new Error(`check execution canceled before process start: ${id}`);
    }
  };
  const execute = async (lease?: HeavyCheckLease) => {
    assertExecutionStillRequested();
    const result = await executeControllerCheckAsync(repoRoot, check, timeoutMs, (pid) => {
      lease?.setChildPid(pid);
      notifySpawn(pid);
    });
    const completedRevision = currentControllerCheckRevision(repoRoot);
    const stale = completedRevision !== revision;
    const finalized = stale
      ? {
          ...result,
          ok: false,
          status: 1,
          stderr: [
            result.stderr,
            'repository revision changed while the check was running; evidence is stale and the check must be rerun',
          ].filter(Boolean).join('\n'),
        }
      : result;
    const { artifactPath: _artifactPath, ...withoutPath } = finalized;
    const artifactPath = persistCheckEvidence(repoRoot, withoutPath, {
      revision,
      completedRevision,
      stale,
      cacheKey: stale ? undefined : cacheKey,
    });
    return { ...finalized, artifactPath };
  };
  const executeHeavy = async (): Promise<ControllerCheckResult> => {
    assertExecutionStillRequested();
    const lease = await acquireHeavyCheckLock(repoRoot, id);
    try {
      assertExecutionStillRequested();
      const currentRevision = currentControllerCheckRevision(repoRoot);
      if (currentRevision !== revision) {
        throw new Error(`repository revision changed while heavy check ${id} was queued; resubmit the check`);
      }
      const refreshed = readLatestControllerCheckEvidence(repoRoot, id);
      if (refreshed?.cacheKey === cacheKey) {
        return {
          check,
          ok: refreshed.ok,
          status: refreshed.status,
          timedOut: refreshed.timedOut,
          stdout: refreshed.stdout,
          stderr: refreshed.stderr,
          command: refreshed.command,
          executedAt: refreshed.executedAt,
          artifactPath: relative(repoRoot, evidencePath(repoRoot, id)).replace(/\\/g, '/'),
        };
      }
      return execute(lease);
    } finally {
      lease.release();
    }
  };
  const promise = controllerCheckConcurrencyClass(id) === 'heavy'
    ? (() => {
        const repoKey = resolve(repoRoot);
        const previous = heavyCheckQueues.get(repoKey) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(executeHeavy);
        const tail = queued.then(() => undefined, () => undefined);
        heavyCheckQueues.set(repoKey, tail);
        void tail.then(() => {
          if (heavyCheckQueues.get(repoKey) === tail) heavyCheckQueues.delete(repoKey);
        });
        return queued;
      })()
    : execute();

  active.promise = promise;
  activeAsyncChecks.set(key, active);
  const cleanup = () => {
    if (activeAsyncChecks.get(key) === active) activeAsyncChecks.delete(key);
    for (const subscriberId of active.subscriberIds) {
      if (activeAsyncCheckSubscriptions.get(subscriberId) === active) {
        activeAsyncCheckSubscriptions.delete(subscriberId);
      }
    }
    active.subscriberIds.clear();
    active.spawnListeners.clear();
  };
  void promise.then(cleanup, cleanup);
  return promise;
}
