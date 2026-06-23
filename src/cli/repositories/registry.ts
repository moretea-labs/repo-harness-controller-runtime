import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { ensureControllerHome, ensureRepositoryControllerLayout, resolveControllerHome } from './controller-home';
import {
  inferDisplayName,
  newLocalRepoId,
  normalizeRemoteUrl,
  parseGitHubRemote,
  stableCheckoutId,
  stableRemoteRepoId,
} from './identity';
import type {
  RepositoryCheckout,
  RepositoryRecord,
  RepositoryRegistry,
  RepositoryStateStorageStrategy,
  RepositorySummary,
  RepositoryType,
  RepositoryValidation,
} from './types';

const REGISTRY_FILE = 'repositories.json';
const FOCUS_FILE = 'focus.json';
const LOCAL_CONFIG = '.ai/harness/repository.json';
const LEGACY_GITHUB_PLUGIN_CONFIG = '.repo-harness/plugins/github.json';

interface RegisterRepositoryInput {
  path: string;
  controllerHome?: string;
  displayName?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  repositoryType?: RepositoryType;
  enabled?: boolean;
  stateStorageStrategy?: RepositoryStateStorageStrategy;
}

interface UpdateRepositoryInput {
  displayName?: string;
  enabled?: boolean;
  defaultBranch?: string;
  stateStorageStrategy?: RepositoryStateStorageStrategy;
  github?: RepositoryRecord['github'];
}

function now(): string {
  return new Date().toISOString();
}

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function registryPath(controllerHome?: string): string {
  return join(resolveControllerHome(controllerHome), REGISTRY_FILE);
}

function focusPath(controllerHome?: string): string {
  return join(resolveControllerHome(controllerHome), FOCUS_FILE);
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

function defaultRegistry(): RepositoryRegistry {
  return { schemaVersion: 1, repositories: [], updatedAt: now() };
}

export function loadRepositoryRegistry(controllerHome?: string): RepositoryRegistry {
  const path = registryPath(controllerHome);
  if (!existsSync(path)) return defaultRegistry();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RepositoryRegistry>;
    return {
      schemaVersion: 1,
      repositories: Array.isArray(parsed.repositories) ? parsed.repositories : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
    };
  } catch (error) {
    throw new Error(`repository registry is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveRepositoryRegistry(registry: RepositoryRegistry, controllerHome?: string): RepositoryRegistry {
  const home = ensureControllerHome(controllerHome);
  const next = { ...registry, schemaVersion: 1 as const, updatedAt: now() };
  atomicJson(join(home, REGISTRY_FILE), next);
  return next;
}

function resolveGitRoot(inputPath: string): string {
  const candidate = resolve(inputPath);
  if (!existsSync(candidate)) throw new Error(`repository path does not exist: ${candidate}`);
  const topLevel = git(candidate, ['rev-parse', '--show-toplevel']);
  if (!topLevel) throw new Error(`path is not a Git repository: ${candidate}`);
  return realpathSync(topLevel);
}

function readLocalIdentity(canonicalRoot: string): { repoId?: string } {
  const path = join(canonicalRoot, LOCAL_CONFIG);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { repoId?: unknown };
    return typeof parsed.repoId === 'string' && parsed.repoId.trim()
      ? { repoId: parsed.repoId.trim() }
      : {};
  } catch (_error) {
    return {};
  }
}

function readLegacyGitHubPluginConfig(canonicalRoot: string): Partial<RepositoryRecord['github']> | undefined {
  const path = join(canonicalRoot, LEGACY_GITHUB_PLUGIN_CONFIG);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      enabled?: unknown;
      repository?: unknown;
      syncMode?: unknown;
      includeTasks?: unknown;
      projectOwner?: unknown;
      projectNumber?: unknown;
    };
    const repository = typeof raw.repository === 'string' && raw.repository.trim() ? raw.repository.trim() : undefined;
    const [owner, repo] = repository?.includes('/') ? repository.split('/', 2) : [undefined, undefined];
    return repository && owner && repo ? {
      owner,
      repo,
      repository,
      pluginEnabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
      syncMode: raw.syncMode === 'checkpoint' ? 'checkpoint' : 'manual',
      includeTasks: raw.includeTasks !== false,
      projectOwner: typeof raw.projectOwner === 'string' && raw.projectOwner.trim() ? raw.projectOwner.trim() : undefined,
      projectNumber: Number.isInteger(raw.projectNumber) && Number(raw.projectNumber) > 0 ? Number(raw.projectNumber) : undefined,
    } : undefined;
  } catch (_error) {
    return undefined;
  }
}

function writeLocalIdentity(record: RepositoryRecord): void {
  const path = join(record.canonicalRoot, LOCAL_CONFIG);
  atomicJson(path, {
    schemaVersion: 1,
    repoId: record.repoId,
    checkoutId: record.activeCheckoutId,
    stateStorageStrategy: record.stateStorageStrategy,
  });
}

function repositoryType(root: string, remoteUrl: string | undefined): RepositoryType {
  const bare = git(root, ['rev-parse', '--is-bare-repository']);
  if (bare === 'true') return 'bare';
  return remoteUrl ? 'git' : 'local-git';
}

function defaultBranch(root: string): string | undefined {
  const originHead = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead?.startsWith('origin/')) return originHead.slice('origin/'.length);
  const current = git(root, ['branch', '--show-current']);
  return current || undefined;
}

function activeCheckout(record: RepositoryRecord): RepositoryCheckout {
  return record.checkouts.find((checkout) => checkout.checkoutId === record.activeCheckoutId)
    ?? record.checkouts[0]
    ?? {
      checkoutId: record.activeCheckoutId,
      localRoot: record.localRoot,
      canonicalRoot: record.canonicalRoot,
      worktree: false,
      branch: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastSeenAt: record.lastSeenAt,
    };
}

function defaultGitHubMapping(
  canonicalRemote: string | undefined,
  existing?: RepositoryRecord['github'],
  legacy?: Partial<RepositoryRecord['github']>,
): RepositoryRecord['github'] {
  if (existing) return existing;
  if (legacy?.owner && legacy?.repo) {
    return {
      owner: legacy.owner,
      repo: legacy.repo,
      repository: legacy.repository ?? `${legacy.owner}/${legacy.repo}`,
      pluginEnabled: legacy.pluginEnabled ?? true,
      syncMode: legacy.syncMode ?? 'manual',
      includeTasks: legacy.includeTasks ?? true,
      labels: legacy.labels,
      projectOwner: legacy.projectOwner,
      projectNumber: legacy.projectNumber,
      issueSyncEnabled: legacy.issueSyncEnabled,
      cloudAgentSupported: legacy.cloudAgentSupported,
      authenticationCapability: legacy.authenticationCapability ?? 'unknown',
    };
  }
  const parsed = parseGitHubRemote(canonicalRemote);
  if (!parsed) return undefined;
  return {
    ...parsed,
    repository: `${parsed.owner}/${parsed.repo}`,
    pluginEnabled: true,
    syncMode: 'manual',
    includeTasks: true,
    authenticationCapability: 'unknown',
  };
}

export function repositorySummary(record: RepositoryRecord): RepositorySummary {
  const checkout = activeCheckout(record);
  return {
    repoId: record.repoId,
    displayName: record.displayName,
    enabled: record.enabled,
    localRoot: checkout.localRoot,
    canonicalRoot: checkout.canonicalRoot,
    checkoutId: checkout.checkoutId,
    remoteUrl: record.remoteUrl,
    github: record.github,
    defaultBranch: record.defaultBranch,
    repositoryType: record.repositoryType,
    lastSeenAt: record.lastSeenAt,
    removedAt: record.removedAt,
  };
}

export function listRepositories(controllerHome?: string, options: { includeRemoved?: boolean } = {}): RepositoryRecord[] {
  return loadRepositoryRegistry(controllerHome).repositories
    .filter((record) => options.includeRemoved === true || !record.removedAt)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.repoId.localeCompare(b.repoId));
}

export function getRepository(repoId: string, controllerHome?: string, options: { includeRemoved?: boolean } = {}): RepositoryRecord {
  const record = loadRepositoryRegistry(controllerHome).repositories.find((candidate) => candidate.repoId === repoId);
  if (!record || (record.removedAt && options.includeRemoved !== true)) {
    throw new Error(`repository not found: ${repoId}`);
  }
  return record;
}

export function selectRepositoryCheckout(record: RepositoryRecord, checkoutId?: string): RepositoryRecord {
  if (!checkoutId?.trim()) return record;
  const checkout = record.checkouts.find((candidate) => candidate.checkoutId === checkoutId.trim());
  if (!checkout) throw new Error(`checkout not found for ${record.repoId}: ${checkoutId}`);
  return {
    ...record,
    localRoot: checkout.localRoot,
    canonicalRoot: checkout.canonicalRoot,
    activeCheckoutId: checkout.checkoutId,
  };
}

export function registerRepository(input: RegisterRepositoryInput): RepositoryRecord {
  const home = ensureControllerHome(input.controllerHome);
  const canonicalRoot = resolveGitRoot(input.path);
  const rawRemote = input.remoteUrl?.trim() || git(canonicalRoot, ['config', '--get', 'remote.origin.url']);
  const canonicalRemote = normalizeRemoteUrl(rawRemote);
  const localIdentity = readLocalIdentity(canonicalRoot);
  const legacyGitHub = readLegacyGitHubPluginConfig(canonicalRoot);
  const repoId = canonicalRemote ? stableRemoteRepoId(canonicalRemote) : localIdentity.repoId || newLocalRepoId();
  const checkoutId = stableCheckoutId(repoId, canonicalRoot);
  const timestamp = now();
  const registry = loadRepositoryRegistry(home);
  const existing = registry.repositories.find((record) => record.repoId === repoId);
  const checkout: RepositoryCheckout = {
    checkoutId,
    localRoot: canonicalRoot,
    canonicalRoot,
    worktree: Boolean(git(canonicalRoot, ['rev-parse', '--git-common-dir']) && git(canonicalRoot, ['rev-parse', '--git-dir']) !== git(canonicalRoot, ['rev-parse', '--git-common-dir'])),
    branch: git(canonicalRoot, ['branch', '--show-current']) ?? null,
    createdAt: existing?.checkouts.find((value) => value.checkoutId === checkoutId)?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  };
  const record: RepositoryRecord = {
    schemaVersion: 1,
    repoId,
    displayName: input.displayName?.trim() || existing?.displayName || inferDisplayName(canonicalRoot, canonicalRemote),
    localRoot: canonicalRoot,
    canonicalRoot,
    activeCheckoutId: checkoutId,
    checkouts: [
      ...(existing?.checkouts.filter((value) => value.checkoutId !== checkoutId) ?? []),
      checkout,
    ],
    remoteUrl: rawRemote,
    canonicalRemote,
    github: defaultGitHubMapping(canonicalRemote, existing?.github, legacyGitHub),
    defaultBranch: input.defaultBranch?.trim() || existing?.defaultBranch || defaultBranch(canonicalRoot),
    repositoryType: input.repositoryType ?? existing?.repositoryType ?? repositoryType(canonicalRoot, rawRemote),
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: join(canonicalRoot, LOCAL_CONFIG),
    stateStorageStrategy: input.stateStorageStrategy ?? existing?.stateStorageStrategy ?? 'hybrid',
    disabledAt: input.enabled === true ? undefined : existing?.disabledAt,
    removedAt: undefined,
  };
  registry.repositories = [
    ...registry.repositories.filter((candidate) => candidate.repoId !== repoId),
    record,
  ];
  saveRepositoryRegistry(registry, home);
  ensureRepositoryControllerLayout(home, repoId);
  writeLocalIdentity(record);
  return record;
}

export function updateRepository(repoId: string, patch: UpdateRepositoryInput, controllerHome?: string): RepositoryRecord {
  const registry = loadRepositoryRegistry(controllerHome);
  const index = registry.repositories.findIndex((record) => record.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  const previous = registry.repositories[index];
  const enabled = patch.enabled ?? previous.enabled;
  const next: RepositoryRecord = {
    ...previous,
    ...patch,
    displayName: patch.displayName?.trim() || previous.displayName,
    defaultBranch: patch.defaultBranch?.trim() || previous.defaultBranch,
    enabled,
    disabledAt: enabled ? undefined : previous.disabledAt ?? now(),
    removedAt: enabled ? undefined : previous.removedAt,
    github: patch.github ?? previous.github,
    updatedAt: now(),
  };
  registry.repositories[index] = next;
  saveRepositoryRegistry(registry, controllerHome);
  writeLocalIdentity(next);
  return next;
}

export function disableRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  return updateRepository(repoId, { enabled: false }, controllerHome);
}

export function removeRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const registry = loadRepositoryRegistry(controllerHome);
  const index = registry.repositories.findIndex((record) => record.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  const timestamp = now();
  registry.repositories[index] = {
    ...registry.repositories[index],
    enabled: false,
    disabledAt: registry.repositories[index].disabledAt ?? timestamp,
    removedAt: timestamp,
    updatedAt: timestamp,
  };
  saveRepositoryRegistry(registry, controllerHome);
  return registry.repositories[index];
}

export function purgeRepository(repoId: string, controllerHome?: string): void {
  const home = resolveControllerHome(controllerHome);
  const registry = loadRepositoryRegistry(home);
  registry.repositories = registry.repositories.filter((record) => record.repoId !== repoId);
  saveRepositoryRegistry(registry, home);
  rmSync(join(home, 'repositories', repoId), { recursive: true, force: true });
}

export function validateRepository(repoId: string, controllerHome?: string): RepositoryValidation {
  const record = getRepository(repoId, controllerHome, { includeRemoved: true });
  const checkout = activeCheckout(record);
  const errors: string[] = [];
  const warnings: string[] = [];
  const rootExists = existsSync(checkout.canonicalRoot);
  const canonicalRoot = rootExists ? realpathSync(checkout.canonicalRoot) : checkout.canonicalRoot;
  const gitRepository = rootExists && Boolean(git(canonicalRoot, ['rev-parse', '--show-toplevel']));
  const remoteUrl = gitRepository ? git(canonicalRoot, ['config', '--get', 'remote.origin.url']) : undefined;
  const canonicalRemote = normalizeRemoteUrl(remoteUrl);
  const identityMatches = record.canonicalRemote
    ? canonicalRemote === record.canonicalRemote
    : rootExists && canonicalRoot === checkout.canonicalRoot;
  if (!rootExists) errors.push('checkout root does not exist');
  if (rootExists && !gitRepository) errors.push('checkout root is no longer a Git repository');
  if (gitRepository && !identityMatches) errors.push('repository identity does not match the registry record');
  if (!record.enabled) warnings.push('repository is disabled');
  if (record.removedAt) warnings.push('repository was removed and is retained for audit only');
  return {
    repoId,
    checkoutId: checkout.checkoutId,
    ok: errors.length === 0,
    rootExists,
    gitRepository,
    identityMatches,
    canonicalRoot,
    canonicalRemote,
    errors,
    warnings,
    checkedAt: now(),
  };
}

export function refreshRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const record = getRepository(repoId, controllerHome, { includeRemoved: true });
  const checkout = activeCheckout(record);
  return registerRepository({
    path: checkout.canonicalRoot,
    controllerHome,
    displayName: record.displayName,
    defaultBranch: defaultBranch(checkout.canonicalRoot) ?? record.defaultBranch,
    repositoryType: record.repositoryType,
    enabled: record.enabled,
    stateStorageStrategy: record.stateStorageStrategy,
  });
}

export function focusRepository(repoId: string | undefined, controllerHome?: string): { repoId?: string; updatedAt: string } {
  const home = ensureControllerHome(controllerHome);
  if (repoId) getRepository(repoId, home);
  const value = { repoId, updatedAt: now() };
  atomicJson(focusPath(home), value);
  return value;
}

export function getRepositoryFocus(controllerHome?: string): { repoId?: string; updatedAt?: string } {
  const path = focusPath(controllerHome);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as { repoId?: string; updatedAt?: string };
  } catch (_error) {
    return {};
  }
}

export function resolveRepositorySelection(input: {
  repoId?: string;
  checkoutId?: string;
  explicitPath?: string;
  controllerHome?: string;
  allowSoleRepository?: boolean;
}): RepositoryRecord {
  if (input.repoId?.trim()) {
    const record = getRepository(input.repoId.trim(), input.controllerHome);
    if (!record.enabled) throw new Error(`repository is disabled: ${record.repoId}`);
    return selectRepositoryCheckout(record, input.checkoutId);
  }
  if (input.explicitPath?.trim()) {
    return selectRepositoryCheckout(registerRepository({ path: input.explicitPath, controllerHome: input.controllerHome }), input.checkoutId);
  }
  const enabled = listRepositories(input.controllerHome).filter((record) => record.enabled);
  if (input.allowSoleRepository !== false && enabled.length === 1) return selectRepositoryCheckout(enabled[0], input.checkoutId);
  if (enabled.length === 0) {
    throw new Error('REPOSITORY_REQUIRED: no enabled repository is registered; pass repoId or register a repository');
  }
  throw new Error(`REPOSITORY_AMBIGUOUS: ${enabled.length} enabled repositories are registered; pass repoId explicitly`);
}
