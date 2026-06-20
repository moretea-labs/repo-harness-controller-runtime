import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runProcess as runBoundedProcess } from '../../effects/process-runner';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
const PACKAGE_HELPERS_ROOT = join(PACKAGE_ROOT, 'assets', 'templates', 'helpers');
const PACKAGE_CONTRACT = join(PACKAGE_ROOT, 'assets', 'workflow-contract.v1.json');

export type HelperSource = 'env' | 'repo-pin' | 'package' | 'repo-fallback';

export interface ResolvedHelper {
  id: string;
  fileName: string;
  path: string;
  source: HelperSource;
  repoRoot: string;
}

export interface RunHelperOptions {
  helper: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe' | 'ignore';
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunHelperResult {
  exitCode: number;
  reason: 'missing-helper' | 'spawn-error' | 'timeout' | 'ok';
  helper: string;
  resolved?: ResolvedHelper;
  stdout?: string;
  stderr?: string;
}

function helperId(fileName: string): string {
  const ext = extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

function readContractHelpers(): string[] {
  try {
    const contract = JSON.parse(readFileSync(PACKAGE_CONTRACT, 'utf-8')) as {
      helpers?: { scripts?: unknown };
    };
    if (Array.isArray(contract.helpers?.scripts)) {
      return contract.helpers.scripts.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch (_error) {
    // Fall through to directory discovery for development checkouts.
  }

  if (!existsSync(PACKAGE_HELPERS_ROOT)) return [];
  return readdirSync(PACKAGE_HELPERS_ROOT).filter((entry) => entry.endsWith('.sh') || entry.endsWith('.ts')).sort();
}

export function listHelperFiles(): string[] {
  return readContractHelpers();
}

export function listHelperIds(): string[] {
  return listHelperFiles().map(helperId);
}

function candidateFileNames(helper: string): string[] {
  if (extname(helper)) return [helper];
  const files = listHelperFiles();
  const matches = files.filter((fileName) => helperId(fileName) === helper);
  return matches.length > 0 ? matches : [`${helper}.sh`, `${helper}.ts`];
}

function resolveRepoRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  const result = runBoundedProcess('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    env,
    timeoutMs: 5000,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function repoPinsHelperSource(repoRoot: string): boolean {
  try {
    const policy = JSON.parse(readFileSync(join(repoRoot, '.ai', 'harness', 'policy.json'), 'utf-8')) as {
      helper_source?: unknown;
      harness?: { helper_source?: unknown };
    };
    return policy.helper_source === 'repo' || policy.harness?.helper_source === 'repo';
  } catch (_error) {
    return false;
  }
}

function resolveFromDir(
  helper: string,
  dir: string,
  source: HelperSource,
  repoRoot: string,
): ResolvedHelper | null {
  for (const fileName of candidateFileNames(helper)) {
    const filePath = join(dir, fileName);
    if (existsSync(filePath)) {
      return { id: helperId(fileName), fileName, path: filePath, source, repoRoot };
    }
  }
  return null;
}

export function resolveHelper(helper: string, cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): ResolvedHelper | null {
  const repoRoot = resolveRepoRoot(cwd, env);
  const repoHelpersRoot = join(repoRoot, '.ai', 'harness', 'scripts');
  const override = env.REPO_HARNESS_HELPER_SOURCE?.trim();

  if (override === 'repo') return resolveFromDir(helper, repoHelpersRoot, 'env', repoRoot);
  if (override === 'package') return resolveFromDir(helper, PACKAGE_HELPERS_ROOT, 'env', repoRoot);
  if (override && resolve(override) === override) return resolveFromDir(helper, override, 'env', repoRoot);

  if (repoPinsHelperSource(repoRoot)) {
    const repoPinned = resolveFromDir(helper, repoHelpersRoot, 'repo-pin', repoRoot);
    if (repoPinned) return repoPinned;
  }

  return (
    resolveFromDir(helper, PACKAGE_HELPERS_ROOT, 'package', repoRoot) ??
    resolveFromDir(helper, repoHelpersRoot, 'repo-fallback', repoRoot)
  );
}

export function runHelper(opts: RunHelperOptions): RunHelperResult {
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...process.env, ...(opts.env ?? {}) };
  const resolved = resolveHelper(opts.helper, cwd, env);
  if (!resolved) {
    return {
      exitCode: 2,
      reason: 'missing-helper',
      helper: opts.helper,
      stderr: `repo-harness run: unknown helper "${opts.helper}"`,
    };
  }

  const args = [...(opts.args ?? [])];
  const command = resolved.fileName.endsWith('.sh') ? 'bash' : process.execPath;
  const child = runBoundedProcess(command, [resolved.path, ...args], {
    cwd: resolved.repoRoot,
    env: { ...env, REPO_HARNESS_HELPER_SOURCE_PATH: resolved.path },
    stdio: opts.stdio ?? 'inherit',
    timeoutMs: opts.timeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
  });

  if (child.error) {
    return {
      exitCode: 1,
      reason: child.timedOut ? 'timeout' : 'spawn-error',
      helper: opts.helper,
      resolved,
      stderr: child.stderr || child.error,
    };
  }

  return {
    exitCode: child.status ?? 1,
    reason: 'ok',
    helper: opts.helper,
    resolved,
    stdout: child.stdout || undefined,
    stderr: child.stderr || undefined,
  };
}
