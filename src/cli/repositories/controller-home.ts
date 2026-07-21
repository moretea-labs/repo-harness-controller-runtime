import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export function resolveControllerHome(explicit?: string): string {
  const configured = explicit?.trim()
    || process.env.REPO_HARNESS_CONTROLLER_HOME?.trim()
    || (process.env.XDG_STATE_HOME?.trim()
      ? join(process.env.XDG_STATE_HOME.trim(), 'repo-harness', 'controller')
      : join(homedir(), '.repo-harness', 'controller'));
  return resolve(configured);
}

/**
 * Prefer env, then repo-local self-host layout (`_ops/controller-home`) used by
 * `bun run controller:restart`, then the user-global default.
 */
export function resolveRepoPreferredControllerHome(repoRoot?: string, explicit?: string): string {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) return resolveControllerHome(trimmedExplicit);
  const configured = process.env.REPO_HARNESS_CONTROLLER_HOME?.trim();
  if (configured) return resolveControllerHome(configured);
  if (repoRoot?.trim()) {
    const opsHome = join(resolve(repoRoot.trim()), '_ops', 'controller-home');
    if (existsSync(join(opsHome, 'mcp', 'mcp.local.json')) || existsSync(opsHome)) {
      return resolve(opsHome);
    }
  }
  return resolveControllerHome();
}

export function ensureControllerHome(explicit?: string): string {
  const home = resolveControllerHome(explicit);
  for (const child of ['', 'repositories', 'system', 'locks', 'indexes', 'audit', 'mcp', 'sessions', 'work-handles']) {
    mkdirSync(join(home, child), { recursive: true });
  }
  return home;
}

export function ensureRepoPreferredControllerHome(repoRoot?: string, explicit?: string): string {
  return ensureControllerHome(resolveRepoPreferredControllerHome(repoRoot, explicit));
}

export const CONTROLLER_SCOPE_REPO_ID = '__controller__';

export function controllerSystemRoot(controllerHome: string): string {
  return join(resolveControllerHome(controllerHome), 'system');
}

export function repositoryControllerRoot(controllerHome: string, repoId: string): string {
  return repoId === CONTROLLER_SCOPE_REPO_ID
    ? controllerSystemRoot(controllerHome)
    : join(resolveControllerHome(controllerHome), 'repositories', repoId);
}

export function ensureRepositoryControllerLayout(controllerHome: string, repoId: string): string {
  const root = repositoryControllerRoot(controllerHome, repoId);
  for (const child of [
    '',
    'runs',
    'jobs',
    'worktrees',
    'artifacts',
    'locks',
    'indexes',
    'edit-sessions',
    'controller',
    'local-bridge',
    'ephemeral-issues',
    'work-handles',
    'results',
    'audit',
    'processes',
    'leases',
    'workflows',
    'projections',
  ]) {
    mkdirSync(join(root, child), { recursive: true });
  }
  return root;
}
