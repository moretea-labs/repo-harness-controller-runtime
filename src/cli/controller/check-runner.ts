import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, normalize, relative, resolve } from 'path';
import {
  capProcessOutput,
  redactProcessOutput,
  runProcess,
  type ProcessRunResult,
} from '../../effects/process-runner';

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
}

function artifactSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'check';
}

function evidencePath(repoRoot: string, id: string): string {
  return join(repoRoot, CHECK_EVIDENCE_ROOT, `latest-${artifactSlug(id)}.json`);
}

function currentCheckRevision(repoRoot: string): string {
  const head = runProcess('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    timeoutMs: 5_000,
    maxOutputBytes: 16 * 1024,
  });
  const status = runProcess('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
  });
  return createHash('sha256')
    .update(`${head.ok ? head.stdout.trim() : 'unknown'}\n${status.ok ? status.stdout : 'unknown'}`)
    .digest('hex')
    .slice(0, 24);
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
  meta: { revision?: string; cacheKey?: string } = {},
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
  };
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf-8');
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
  const revision = currentCheckRevision(repoRoot);
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
  const result: ProcessRunResult = runProcess(check.command[0], check.command.slice(1), {
    cwd: resolve(repoRoot, check.cwd),
    timeoutMs,
    maxOutputBytes: 256 * 1024,
  });
  const withoutPath = {
    check,
    ok: result.ok,
    status: result.status,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr || result.error,
    command: result.command,
    executedAt: new Date().toISOString(),
  };
  return {
    ...withoutPath,
    artifactPath: persistCheckEvidence(repoRoot, withoutPath, { revision, cacheKey }),
  };
}

export interface AsyncControllerCheckOptions {
  requestedTimeoutMs?: number;
  onSpawn?: (pid: number) => void;
}

const activeAsyncChecks = new Map<string, Promise<ControllerCheckResult>>();
const heavyCheckQueues = new Map<string, Promise<void>>();

function isHeavyCheck(id: string): boolean {
  return /(?:^|:)(?:test|test:coverage|check:ci|check:release|check:release-published)$/.test(id);
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

    const finish = (status: number, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      const timeoutMessage = timedOut
        ? `process timed out after ${timeoutMs}ms: ${command.join(' ')}`
        : '';
      const stderrText = [stderr, timeoutMessage || error || ''].filter(Boolean).join('\n');
      resolvePromise({
        ok: status === 0 && !timedOut && !error,
        status,
        timedOut,
        stdout: capProcessOutput(redactProcessOutput(stdout), maxOutputBytes),
        stderr: capProcessOutput(redactProcessOutput(stderrText), maxOutputBytes),
      });
    };

    child.once('error', (error) => finish(1, error.message));
    child.once('close', (code) => finish(code ?? 1));
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
  const revision = currentCheckRevision(repoRoot);
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
  if (existing) return existing;

  const execute = async () => {
    const result = await executeControllerCheckAsync(repoRoot, check, timeoutMs, options.onSpawn);
    const { artifactPath: _artifactPath, ...withoutPath } = result;
    const artifactPath = persistCheckEvidence(repoRoot, withoutPath, { revision, cacheKey });
    return { ...result, artifactPath };
  };
  const promise = isHeavyCheck(id)
    ? (() => {
        const repoKey = resolve(repoRoot);
        const previous = heavyCheckQueues.get(repoKey) ?? Promise.resolve();
        const queued = previous.catch(() => undefined).then(execute);
        heavyCheckQueues.set(repoKey, queued.then(() => undefined, () => undefined));
        return queued;
      })()
    : execute();

  activeAsyncChecks.set(key, promise);
  const cleanup = () => {
    if (activeAsyncChecks.get(key) === promise) activeAsyncChecks.delete(key);
  };
  void promise.then(cleanup, cleanup);
  return promise;
}
