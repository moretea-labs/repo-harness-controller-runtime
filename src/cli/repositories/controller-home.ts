import { mkdirSync } from 'fs';
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

export function ensureControllerHome(explicit?: string): string {
  const home = resolveControllerHome(explicit);
  for (const child of ['', 'repositories', 'locks', 'indexes', 'audit']) {
    mkdirSync(join(home, child), { recursive: true });
  }
  return home;
}

export function repositoryControllerRoot(controllerHome: string, repoId: string): string {
  return join(resolveControllerHome(controllerHome), 'repositories', repoId);
}

export function ensureRepositoryControllerLayout(controllerHome: string, repoId: string): string {
  const root = repositoryControllerRoot(controllerHome, repoId);
  for (const child of ['', 'runs', 'worktrees', 'artifacts', 'locks', 'indexes', 'jobs']) {
    mkdirSync(join(root, child), { recursive: true });
  }
  return root;
}
