import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, normalize, relative, resolve } from 'path';
import { runProcess, type ProcessRunResult } from '../../effects/process-runner';

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
}

function artifactSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'check';
}

function evidencePath(repoRoot: string, id: string): string {
  return join(repoRoot, CHECK_EVIDENCE_ROOT, `latest-${artifactSlug(id)}.json`);
}

function persistCheckEvidence(repoRoot: string, result: Omit<ControllerCheckResult, 'artifactPath'>): string {
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
  return { ...withoutPath, artifactPath: persistCheckEvidence(repoRoot, withoutPath) };
}
