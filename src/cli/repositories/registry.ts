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
  repoIdOverride?: string;
}

interface UpdateRepositoryInput {
  displayName?: string;
  enabled?: boolean;
  defaultBranch?: string;
  stateStorageStrategy?: RepositoryStateStorageStrategy;
  github?: RepositoryRecord['github'];
}

export interface AddRepositoryCheckoutInput {
  repoId: string;
  path: string;
  controllerHome?: string;
  activate?: boolean;
}

function validBranch(value: string | undefined): boolean {
  if (!value) return true;
  return /^(?!\/)(?!.*(?:\/\/|\.\.))(?!.*\/$)[A-Za-z0-9._/-]+$/.test(value);
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
  previousCanonicalRemote?: string,
  legacy?: Partial<RepositoryRecord['github']>,
): RepositoryRecord['github'] {
  const parsed = parseGitHubRemote(canonicalRemote);
  const previousParsed = parseGitHubRemote(previousCanonicalRemote);
  const legacyMapping = legacy?.owner && legacy?.repo ? {
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
  } : undefined;
  if (!parsed) return existing ?? legacyMapping;
  const inferredRepository = `${parsed.owner}/${parsed.repo}`;
  if (!existing) {
    return {
      ...parsed,
      repository: inferredRepository,
      pluginEnabled: true,
      syncMode: 'manual',
      includeTasks: true,
      authenticationCapability: 'unknown',
    };
  }
  const previousRepository = previousParsed ? `${previousParsed.owner}/${previousParsed.repo}` : undefined;
  const existingRepository = existing.repository ?? `${existing.owner}/${existing.repo}`;
  if (previousRepository && existingRepository.toLowerCase() === previousRepository.toLowerCase()) {
    return {
      ...existing,
      ...parsed,
      repository: inferredRepository,
    };
  }
  return existing ?? legacyMapping;
}

function currentProcessOwnsRepository(record: RepositoryRecord): boolean {
  try {
    return realpathSync(process.cwd()) === realpathSync(record.canonicalRoot);
  } catch {
    return false;
  }
}

function uniqueCanonicalRecord(records: RepositoryRecord[], canonicalRoot: string): RepositoryRecord | undefined {
  const normalized = canonicalRoot.replace(/\\/g, '/');
  return records.find((record) => record.canonicalRoot.replace(/\\/g, '/') === normalized);
}

function retireCanonicalDuplicates(records: RepositoryRecord[], canonicalRoot: string, keepRepoId: string, timestamp: string): RepositoryRecord[] {
  const normalized = canonicalRoot.replace(/\\/g, '/');
  return records.map((record) => {
    if (record.repoId === keepRepoId || record.canonicalRoot.replace(/\\/g, '/') !== normalized) return record;
    if (record.removedAt) return record;
    return {
      ...record,
      enabled: false,
      disabledAt: record.disabledAt ?? timestamp,
      removedAt: record.removedAt ?? timestamp,
      updatedAt: timestamp,
    };
  });
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
  if (!input.path?.trim()) throw new Error('REPOSITORY_PATH_REQUIRED');
  const canonicalRoot = resolveGitRoot(input.path);
  if (input.defaultBranch && !validBranch(input.defaultBranch.trim())) throw new Error(`BRANCH_INVALID: ${input.defaultBranch}`);
  const requestedRemote = input.remoteUrl?.trim();
  const rawRemote = requestedRemote || git(canonicalRoot, ['config', '--get', 'remote.origin.url']);
  const canonicalRemote = normalizeRemoteUrl(rawRemote);
  if (requestedRemote && !canonicalRemote) throw new Error(`REMOTE_URL_INVALID: ${requestedRemote}`);
  const localIdentity = readLocalIdentity(canonicalRoot);
  const legacyGitHub = readLegacyGitHubPluginConfig(canonicalRoot);
  const timestamp = now();
  const registry = loadRepositoryRegistry(home);
  const existingByRoot = uniqueCanonicalRecord(registry.repositories, canonicalRoot);
  const derivedRepoId = input.repoIdOverride?.trim()
    || localIdentity.repoId
    || (canonicalRemote ? stableRemoteRepoId(canonicalRemote) : newLocalRepoId());
  const repoId = existingByRoot?.repoId ?? derivedRepoId;
  const checkoutId = stableCheckoutId(repoId, canonicalRoot);
  const existing = existingByRoot ?? registry.repositories.find((record) => record.repoId === repoId);
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
  const restoringExisting = Boolean(existing && (existing.removedAt || existing.enabled === false));
  const enabled = input.enabled ?? (restoringExisting ? true : existing?.enabled ?? true);
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
    github: defaultGitHubMapping(canonicalRemote, existing?.github, existing?.canonicalRemote, legacyGitHub),
    defaultBranch: input.defaultBranch?.trim() || existing?.defaultBranch || defaultBranch(canonicalRoot),
    repositoryType: input.repositoryType ?? existing?.repositoryType ?? repositoryType(canonicalRoot, rawRemote),
    enabled,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: join(canonicalRoot, LOCAL_CONFIG),
    stateStorageStrategy: input.stateStorageStrategy ?? existing?.stateStorageStrategy ?? 'hybrid',
    disabledAt: enabled ? undefined : existing?.disabledAt,
    removedAt: enabled ? undefined : existing?.removedAt,
  };
  const retained = registry.repositories.filter((candidate) => candidate.repoId !== repoId);
  registry.repositories = [
    ...retireCanonicalDuplicates(retained, canonicalRoot, repoId, timestamp),
    record,
  ];
  saveRepositoryRegistry(registry, home);
  ensureRepositoryControllerLayout(home, repoId);
  writeLocalIdentity(record);
  return record;
}

export function addRepositoryCheckout(input: AddRepositoryCheckoutInput): RepositoryRecord {
  const home = ensureControllerHome(input.controllerHome);
  const canonicalRoot = resolveGitRoot(input.path);
  const registry = loadRepositoryRegistry(home);
  const index = registry.repositories.findIndex((record) => record.repoId === input.repoId);
  if (index < 0) throw new Error(`repository not found: ${input.repoId}`);
  const current = registry.repositories[index];
  const rawRemote = git(canonicalRoot, ['config', '--get', 'remote.origin.url']);
  const canonicalRemote = normalizeRemoteUrl(rawRemote);
  if (current.canonicalRemote && canonicalRemote !== current.canonicalRemote) {
    throw new Error(`CHECKOUT_REPOSITORY_MISMATCH: ${canonicalRoot}`);
  }
  const timestamp = now();
  const checkoutId = stableCheckoutId(current.repoId, canonicalRoot);
  const checkout: RepositoryCheckout = {
    checkoutId,
    localRoot: canonicalRoot,
    canonicalRoot,
    worktree: Boolean(git(canonicalRoot, ['rev-parse', '--git-common-dir']) && git(canonicalRoot, ['rev-parse', '--git-dir']) !== git(canonicalRoot, ['rev-parse', '--git-common-dir'])),
    branch: git(canonicalRoot, ['branch', '--show-current']) ?? null,
    createdAt: current.checkouts.find((value) => value.checkoutId === checkoutId)?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  };
  const activate = input.activate === true;
  const next: RepositoryRecord = {
    ...current,
    ...(activate ? { localRoot: canonicalRoot, canonicalRoot, activeCheckoutId: checkoutId } : {}),
    checkouts: [...current.checkouts.filter((value) => value.checkoutId !== checkoutId), checkout],
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  };
  registry.repositories[index] = next;
  saveRepositoryRegistry(registry, home);
  atomicJson(join(canonicalRoot, LOCAL_CONFIG), {
    schemaVersion: 1,
    repoId: next.repoId,
    checkoutId,
    stateStorageStrategy: next.stateStorageStrategy,
  });
  return next;
}

export function updateRepository(repoId: string, patch: UpdateRepositoryInput, controllerHome?: string): RepositoryRecord {
  if (patch.defaultBranch && !validBranch(patch.defaultBranch.trim())) throw new Error(`BRANCH_INVALID: ${patch.defaultBranch}`);
  const registry = loadRepositoryRegistry(controllerHome);
  const index = registry.repositories.findIndex((record) => record.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  const previous = registry.repositories[index];
  const enabled = patch.enabled ?? previous.enabled;
  const restoring = previous.enabled === false && patch.enabled === true;
  const next: RepositoryRecord = {
    ...previous,
    ...patch,
    displayName: patch.displayName?.trim() || previous.displayName,
    defaultBranch: patch.defaultBranch?.trim() || previous.defaultBranch,
    enabled,
    disabledAt: enabled ? undefined : previous.disabledAt ?? now(),
    removedAt: restoring ? previous.removedAt : enabled ? undefined : previous.removedAt,
    github: patch.github ?? previous.github,
    updatedAt: now(),
  };
  registry.repositories[index] = next;
  saveRepositoryRegistry(registry, controllerHome);
  writeLocalIdentity(next);
  return next;
}

export function disableRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const record = getRepository(repoId, controllerHome, { includeRemoved: true });
  if (currentProcessOwnsRepository(record)) throw new Error(`REPOSITORY_SELF_PROTECTED: ${repoId}`);
  return updateRepository(repoId, { enabled: false }, controllerHome);
}

export function removeRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const registry = loadRepositoryRegistry(controllerHome);
  const index = registry.repositories.findIndex((record) => record.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  if (currentProcessOwnsRepository(registry.repositories[index])) throw new Error(`REPOSITORY_SELF_PROTECTED: ${repoId}`);
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
  const githubRemote = parseGitHubRemote(canonicalRemote);
  const githubRemoteRepository = githubRemote ? `${githubRemote.owner}/${githubRemote.repo}` : undefined;
  const githubMappingMatches = !record.github || !githubRemoteRepository
    ? undefined
    : record.github.owner.toLowerCase() === githubRemote!.owner.toLowerCase() &&
      record.github.repo.toLowerCase() === githubRemote!.repo.toLowerCase();
  if (!rootExists) errors.push('checkout root does not exist');
  if (rootExists && !gitRepository) errors.push('checkout root is no longer a Git repository');
  if (gitRepository && !identityMatches) errors.push('repository identity does not match the registry record');
  if (record.canonicalRemote && canonicalRemote && record.canonicalRemote !== canonicalRemote) {
    warnings.push(`Git origin ${canonicalRemote} differs from registry remote ${record.canonicalRemote}; repoId remains stable until explicitly remapped`);
  }
  if (githubMappingMatches === false) {
    warnings.push(`GitHub plugin mapping ${record.github?.owner}/${record.github?.repo} differs from Git origin ${githubRemoteRepository}; mapping was not changed automatically`);
  }
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
    registryCanonicalRemote: record.canonicalRemote,
    githubRemoteRepository,
    githubMappingMatches,
    errors,
    warnings,
    checkedAt: now(),
  };
}

export function refreshRepository(repoId: string, controllerHome?: string): RepositoryRecord {
  const home = ensureControllerHome(controllerHome);
  const registry = loadRepositoryRegistry(home);
  const index = registry.repositories.findIndex((candidate) => candidate.repoId === repoId);
  if (index < 0) throw new Error(`repository not found: ${repoId}`);
  const record = registry.repositories[index];
  const checkout = activeCheckout(record);
  const canonicalRoot = resolveGitRoot(checkout.canonicalRoot);
  const rawRemote = git(canonicalRoot, ['config', '--get', 'remote.origin.url']);
  const canonicalRemote = normalizeRemoteUrl(rawRemote);
  const checkoutId = stableCheckoutId(repoId, canonicalRoot);
  const timestamp = now();
  const refreshedCheckout: RepositoryCheckout = {
    ...checkout,
    checkoutId,
    localRoot: canonicalRoot,
    canonicalRoot,
    worktree: Boolean(git(canonicalRoot, ['rev-parse', '--git-common-dir']) && git(canonicalRoot, ['rev-parse', '--git-dir']) !== git(canonicalRoot, ['rev-parse', '--git-common-dir'])),
    branch: git(canonicalRoot, ['branch', '--show-current']) ?? null,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  };
  const refreshed: RepositoryRecord = {
    ...record,
    localRoot: canonicalRoot,
    canonicalRoot,
    activeCheckoutId: checkoutId,
    checkouts: [
      ...record.checkouts.filter((candidate) => candidate.checkoutId !== checkout.checkoutId && candidate.checkoutId !== checkoutId),
      refreshedCheckout,
    ],
    remoteUrl: rawRemote,
    canonicalRemote,
    github: defaultGitHubMapping(canonicalRemote, record.github, record.canonicalRemote, readLegacyGitHubPluginConfig(canonicalRoot)),
    defaultBranch: defaultBranch(canonicalRoot) ?? record.defaultBranch,
    repositoryType: repositoryType(canonicalRoot, rawRemote),
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: join(canonicalRoot, LOCAL_CONFIG),
  };
  registry.repositories[index] = refreshed;
  registry.repositories = retireCanonicalDuplicates(registry.repositories, canonicalRoot, repoId, timestamp);
  saveRepositoryRegistry(registry, home);
  ensureRepositoryControllerLayout(home, repoId);
  writeLocalIdentity(refreshed);
  return refreshed;
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
  allowDisabledReason?: 'restore';
}): RepositoryRecord {
  if (input.repoId?.trim()) {
    const record = getRepository(input.repoId.trim(), input.controllerHome);
    if (!record.enabled) {
      const allowRestore = input.allowDisabledReason === 'restore';
      if (!allowRestore) throw new Error(`repository is disabled: ${record.repoId}`);
    }
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
