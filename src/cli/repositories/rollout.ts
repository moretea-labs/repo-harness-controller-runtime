import { existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { runInit, type InitCommandResult } from '../commands/init';
import { loadMcpLocalConfig } from '../mcp/auth';
import { runMcpRestart, type McpRestartOptions } from '../mcp/restart';
import { listRepositories, refreshRepository, repositorySummary } from './registry';
import type { RepositoryRecord, RepositorySummary } from './types';

export interface RepositoryRolloutOptions {
  controllerHome?: string;
  repoIds?: string[];
  includeDisabled?: boolean;
  dryRun?: boolean;
  skipAdopt?: boolean;
  skipRestart?: boolean;
  skipCodexSetup?: boolean;
  skipPublicCheck?: boolean;
  skipToolsSmoke?: boolean;
  skipGithubPlugin?: boolean;
}

export interface RepositoryRolloutStep {
  kind: 'adopt' | 'restart';
  status: 'ok' | 'skipped' | 'failed';
  detail: string;
}

export interface RepositoryRolloutRepositoryResult {
  repository: RepositorySummary;
  steps: RepositoryRolloutStep[];
}

export interface RepositoryRolloutResult {
  ok: boolean;
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  repositories: RepositoryRolloutRepositoryResult[];
}

export interface RepositoryRolloutDeps {
  list?: typeof listRepositories;
  refresh?: typeof refreshRepository;
  adopt?: (repoRoot: string) => InitCommandResult;
  restart?: (opts: McpRestartOptions) => Promise<{ status: string }>;
}

interface RestartReadiness {
  ready: boolean;
  reason: string;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (_error) {
    return resolve(path);
  }
}

function getRestartReadiness(repoRoot: string): RestartReadiness {
  if (!existsSync(join(repoRoot, '.repo-harness', 'mcp.local.json'))) {
    return { ready: false, reason: 'no MCP config' };
  }
  const configuredRepo = loadMcpLocalConfig(repoRoot)?.repo?.trim();
  if (configuredRepo && canonicalPath(configuredRepo) !== canonicalPath(repoRoot)) {
    return { ready: false, reason: `stale MCP config points to ${configuredRepo}` };
  }
  return { ready: true, reason: 'ready' };
}

function selectRepositories(
  opts: RepositoryRolloutOptions,
  deps: RepositoryRolloutDeps,
): RepositoryRecord[] {
  const list = deps.list ?? listRepositories;
  const records = list(opts.controllerHome, { includeRemoved: false });
  const requested = new Set((opts.repoIds ?? []).map((value) => value.trim()).filter(Boolean));
  return records.filter((record) => {
    if (requested.size > 0 && !requested.has(record.repoId)) return false;
    if (opts.includeDisabled === true) return true;
    return record.enabled;
  });
}

export async function runRepositoryRollout(
  opts: RepositoryRolloutOptions = {},
  deps: RepositoryRolloutDeps = {},
): Promise<RepositoryRolloutResult> {
  const refresh = deps.refresh ?? refreshRepository;
  const adopt = deps.adopt ?? ((repoRoot: string) => runInit({
    repo: repoRoot,
    apply: true,
    verify: false,
    syncSkill: false,
    hostAdapters: false,
    externalSkills: false,
    configureCodegraphMcp: false,
  }));
  const restart = deps.restart ?? runMcpRestart;
  const repositories = selectRepositories(opts, deps);
  const results: RepositoryRolloutRepositoryResult[] = [];

  for (const repository of repositories) {
    const steps: RepositoryRolloutStep[] = [];
    let current = repository;
    let summary = repositorySummary(repository);

    if (opts.dryRun !== true) {
      try {
        current = refresh(repository.repoId, opts.controllerHome);
        summary = repositorySummary(current);
      } catch (error) {
        steps.push({
          kind: 'adopt',
          status: 'failed',
          detail: `refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        results.push({ repository: summary, steps });
        continue;
      }
    }

    if (opts.skipAdopt === true) {
      steps.push({ kind: 'adopt', status: 'skipped', detail: 'skipped by flag' });
    } else if (opts.dryRun === true) {
      steps.push({ kind: 'adopt', status: 'skipped', detail: 'dry-run' });
    } else {
      const result = adopt(current.canonicalRoot);
      steps.push({
        kind: 'adopt',
        status: result.exitCode === 0 ? 'ok' : 'failed',
        detail: result.lines.at(-1) ?? `exit=${result.exitCode}`,
      });
      if (result.exitCode !== 0) {
        results.push({ repository: summary, steps });
        continue;
      }
    }

    const restartReadiness = getRestartReadiness(current.canonicalRoot);
    if (opts.skipRestart === true) {
      steps.push({ kind: 'restart', status: 'skipped', detail: 'skipped by flag' });
    } else if (!restartReadiness.ready) {
      steps.push({ kind: 'restart', status: 'skipped', detail: restartReadiness.reason });
    } else if (opts.dryRun === true) {
      steps.push({ kind: 'restart', status: 'skipped', detail: 'dry-run' });
    } else {
      try {
        const result = await restart({
          repo: current.canonicalRoot,
          skipCodexSetup: opts.skipCodexSetup,
          skipPublicCheck: opts.skipPublicCheck,
          skipToolsSmoke: opts.skipToolsSmoke,
          skipGithubPlugin: opts.skipGithubPlugin,
        });
        steps.push({
          kind: 'restart',
          status: result.status === 'ok' ? 'ok' : 'failed',
          detail: result.status,
        });
      } catch (error) {
        steps.push({
          kind: 'restart',
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    results.push({ repository: summary, steps });
  }

  const succeeded = results.filter((entry) => entry.steps.some((step) => step.status === 'ok') && entry.steps.every((step) => step.status !== 'failed')).length;
  const failed = results.filter((entry) => entry.steps.some((step) => step.status === 'failed')).length;
  const skipped = results.filter((entry) => entry.steps.every((step) => step.status === 'skipped')).length;
  return {
    ok: failed === 0,
    dryRun: opts.dryRun === true,
    total: results.length,
    succeeded,
    failed,
    skipped,
    repositories: results,
  };
}
