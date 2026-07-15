import { createHash } from 'crypto';
import { join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { CONTROLLER_SCOPE_REPO_ID, controllerSystemRoot, repositoryControllerRoot } from '../../cli/repositories/controller-home';
import { createExecutionJob } from '../execution/jobs/store';
import type { ExecutionJob, ResourceClaimSpec } from '../execution/jobs/types';
import { appendRuntimeEvent } from '../evidence/event-ledger';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';
import { gmailPluginAdapter } from './gmail-adapter';
import { googleCalendarPluginAdapter } from './google-calendar-adapter';
import { googleTasksPluginAdapter } from './google-tasks-adapter';
import { githubPluginAdapter } from './github-adapter';
import { browserPluginAdapter } from './browser-adapter';
import { appStoreConnectPluginAdapter } from './app-store-connect-adapter';
import { iosPluginAdapter } from './ios-adapter';
import { localSystemPluginAdapter } from './local-system-adapter';
import { AssistantPluginError, toAssistantPluginError } from './errors';
import type {
  AssistantPluginAdapter,
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginActionRequest,
  AssistantPluginManifest,
  AssistantPluginRegistryIndex,
  AssistantPluginRegistryIndexEntry,
} from './types';

const PLUGIN_ADAPTERS = new Map<string, AssistantPluginAdapter>([
  [githubPluginAdapter.pluginId, githubPluginAdapter],
  [browserPluginAdapter.pluginId, browserPluginAdapter],
  [appStoreConnectPluginAdapter.pluginId, appStoreConnectPluginAdapter],
  [iosPluginAdapter.pluginId, iosPluginAdapter],
  [gmailPluginAdapter.pluginId, gmailPluginAdapter],
  [googleCalendarPluginAdapter.pluginId, googleCalendarPluginAdapter],
  [googleTasksPluginAdapter.pluginId, googleTasksPluginAdapter],
  [localSystemPluginAdapter.pluginId, localSystemPluginAdapter],
]);

const PLUGIN_MANIFEST_CACHE_TTL_MS = 5_000;

interface PluginManifestCacheEntry<T> {
  createdAt: number;
  value: T;
}

const pluginManifestListCache = new Map<string, PluginManifestCacheEntry<AssistantPluginManifest[]>>();
const pluginManifestItemCache = new Map<string, PluginManifestCacheEntry<AssistantPluginManifest>>();

function now(): string {
  return new Date().toISOString();
}

export function controllerPluginRepository(controllerHome: string): RepositoryRecord {
  const root = controllerSystemRoot(controllerHome);
  const timestamp = now();
  return {
    schemaVersion: 1,
    repoId: CONTROLLER_SCOPE_REPO_ID,
    displayName: 'Controller local system',
    canonicalRoot: root,
    localRoot: root,
    activeCheckoutId: 'controller',
    checkouts: [],
    defaultBranch: 'none',
    repositoryType: 'local-git',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    configurationPath: join(root, 'local-system', 'targets.json'),
    stateStorageStrategy: 'controller-home',
  };
}

function adapterMatchesRepository(adapter: AssistantPluginAdapter, repository: RepositoryRecord): boolean {
  const scope = adapter.scope ?? 'repository';
  return repository.repoId === CONTROLLER_SCOPE_REPO_ID ? scope === 'controller' : scope === 'repository';
}

function cloneCacheValue<T>(value: T): T {
  return structuredClone(value);
}

function listCacheKey(controllerHome: string, repoId: string, preferStored: boolean): string {
  return `${controllerHome}::${repoId}::list::${preferStored ? 'stored' : 'live'}`;
}

function itemCacheKey(controllerHome: string, repoId: string, pluginId: string, preferStored: boolean): string {
  return `${controllerHome}::${repoId}::item::${pluginId}::${preferStored ? 'stored' : 'live'}`;
}

function readPluginManifestCache<T>(
  cache: Map<string, PluginManifestCacheEntry<T>>,
  key: string,
): T | undefined {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.createdAt > PLUGIN_MANIFEST_CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return cloneCacheValue(cached.value);
}

function writePluginManifestCache<T>(
  cache: Map<string, PluginManifestCacheEntry<T>>,
  key: string,
  value: T,
): T {
  cache.set(key, {
    createdAt: Date.now(),
    value: cloneCacheValue(value),
  });
  return cloneCacheValue(value);
}

function primePluginManifestItemCache(
  controllerHome: string,
  repoId: string,
  manifests: AssistantPluginManifest[],
  preferStored: boolean,
): void {
  for (const manifest of manifests) {
    pluginManifestItemCache.set(itemCacheKey(controllerHome, repoId, manifest.pluginId, preferStored), {
      createdAt: Date.now(),
      value: cloneCacheValue(manifest),
    });
  }
}

function cacheAssistantPluginManifest(
  controllerHome: string,
  repoId: string,
  manifest: AssistantPluginManifest,
  preferStored: boolean,
): void {
  pluginManifestItemCache.set(itemCacheKey(controllerHome, repoId, manifest.pluginId, preferStored), {
    createdAt: Date.now(),
    value: cloneCacheValue(manifest),
  });
}

function invalidateAssistantPluginManifestCache(
  controllerHome: string,
  repoId: string,
  pluginId?: string,
): void {
  const prefix = `${controllerHome}::${repoId}::`;
  for (const key of pluginManifestListCache.keys()) {
    if (key.startsWith(prefix)) pluginManifestListCache.delete(key);
  }
  if (pluginId) {
    pluginManifestItemCache.delete(itemCacheKey(controllerHome, repoId, pluginId, false));
    pluginManifestItemCache.delete(itemCacheKey(controllerHome, repoId, pluginId, true));
    return;
  }
  for (const key of pluginManifestItemCache.keys()) {
    if (key.startsWith(prefix)) pluginManifestItemCache.delete(key);
  }
}

export function clearAssistantPluginManifestCacheForTest(): void {
  pluginManifestListCache.clear();
  pluginManifestItemCache.clear();
}

function pluginsRoot(controllerHome: string, repoId: string): string {
  return join(repositoryControllerRoot(controllerHome, repoId), 'plugins');
}

function manifestPath(controllerHome: string, repoId: string, pluginId: string): string {
  return join(pluginsRoot(controllerHome, repoId), 'manifests', `${sanitizeFileComponent(pluginId)}.json`);
}

function indexPath(controllerHome: string, repoId: string): string {
  return join(pluginsRoot(controllerHome, repoId), 'index.json');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function fingerprintManifest(value: AssistantPluginManifest): string {
  return JSON.stringify({
    ...value,
    revision: 0,
    updatedAt: '',
    health: { ...value.health, checkedAt: '' },
  });
}

function pluginIndexEntry(controllerHome: string, repoId: string, manifest: AssistantPluginManifest): AssistantPluginRegistryIndexEntry {
  return {
    pluginId: manifest.pluginId,
    provider: manifest.provider,
    displayName: manifest.displayName,
    enabled: manifest.enabled,
    lifecycleState: manifest.lifecycle.state,
    healthState: manifest.health.state,
    revision: manifest.revision,
    manifestPath: manifestPath(controllerHome, repoId, manifest.pluginId),
    updatedAt: manifest.updatedAt,
  };
}

function readStoredManifest(controllerHome: string, repoId: string, pluginId: string): AssistantPluginManifest | undefined {
  try {
    return readJsonFile<AssistantPluginManifest>(manifestPath(controllerHome, repoId, pluginId));
  } catch {
    return undefined;
  }
}

function cachedManifestForRepository(
  controllerHome: string,
  repoId: string,
  pluginId: string,
): AssistantPluginManifest | undefined {
  return readPluginManifestCache(pluginManifestItemCache, itemCacheKey(controllerHome, repoId, pluginId, true))
    ?? readPluginManifestCache(pluginManifestItemCache, itemCacheKey(controllerHome, repoId, pluginId, false));
}

function computeManifest(controllerHome: string, repository: RepositoryRecord, pluginId: string): AssistantPluginManifest {
  const adapter = PLUGIN_ADAPTERS.get(pluginId);
  if (!adapter || !adapterMatchesRepository(adapter, repository)) throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
  const previous = readStoredManifest(controllerHome, repository.repoId, pluginId);
  const built = adapter.buildManifest(previous?.revision ?? 0, previous?.updatedAt, repository.canonicalRoot);
  const changed = !previous || fingerprintManifest(previous) !== fingerprintManifest(built);
  return {
    ...built,
    revision: previous ? (changed ? previous.revision + 1 : previous.revision) : 1,
    updatedAt: changed ? now() : previous?.updatedAt ?? built.updatedAt,
  };
}

function writeRegistry(controllerHome: string, repoId: string, manifests: AssistantPluginManifest[]): AssistantPluginRegistryIndex {
  const index: AssistantPluginRegistryIndex = {
    schemaVersion: 1,
    updatedAt: now(),
    plugins: manifests
      .map((manifest) => pluginIndexEntry(controllerHome, repoId, manifest))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
  };
  writeJsonAtomic(indexPath(controllerHome, repoId), index);
  return index;
}

function mapResourceClaims(action: AssistantPluginActionDescriptor, repository: RepositoryRecord): ResourceClaimSpec[] {
  const controllerScoped = repository.repoId === CONTROLLER_SCOPE_REPO_ID;
  return action.resourceClaims.map((claim) => ({
    resourceKey: controllerScoped
      ? `controller-system:${claim.resource}`
      : claim.resource === 'remote'
        ? `remote:${repository.repoId}`
        : claim.resource === 'workspace'
          ? `workspace:${repository.activeCheckoutId}`
          : claim.resource === 'git-refs'
            ? `git-refs:${repository.repoId}`
            : `repo-state:${repository.repoId}`,
    mode: claim.mode,
  }));
}

function semanticKey(repository: RepositoryRecord, pluginId: string, actionId: string, args: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex').slice(0, 20);
  return `plugin-action:${repository.repoId}:${pluginId}:${actionId}:${digest}`;
}

function validatePrimitive(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  return true;
}

function validateSchemaNode(schema: Record<string, unknown>, value: unknown, path: string): void {
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type && !validatePrimitive(type, value)) {
    throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path} must be ${type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path} must be one of ${schema.enum.join(', ')}`);
  }
  if (type === 'object') {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in objectValue)) throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) throw new Error(`PLUGIN_ACTION_ARGUMENT_INVALID: ${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue && objectValue[key] !== undefined) {
        validateSchemaNode(childSchema, objectValue[key], `${path}.${key}`);
      }
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((entry, index) => validateSchemaNode(schema.items as Record<string, unknown>, entry, `${path}[${index}]`));
  }
}

function validateActionArguments(action: AssistantPluginActionDescriptor, args: Record<string, unknown>): Record<string, unknown> {
  validateSchemaNode(action.argumentsSchema, args, 'arguments');
  return canonical(args) as Record<string, unknown>;
}

function enforceConfirmation(action: AssistantPluginActionDescriptor, request: AssistantPluginActionRequest): void {
  // Ordinary authorization is delegated to the host AI/tool permission model.
  // Repo Harness keeps only the explicit strong-confirmation boundary for
  // destructive or irreversible plugin operations.
  if (action.confirmation === 'none' || action.confirmation === 'authorization') return;
  if (action.confirmation === 'strong_confirmation') {
    if (request.confirmAuthorization !== true) {
      throw new Error(`PLUGIN_CONFIRMATION_REQUIRED: ${request.pluginId}/${request.actionId} requires confirmAuthorization=true`);
    }
    if (!action.requiredConfirmationText || request.confirmationText !== action.requiredConfirmationText) {
      throw new Error(`PLUGIN_CONFIRMATION_TEXT_REQUIRED: provide confirmationText=${action.requiredConfirmationText ?? ''}`);
    }
  }
}

function actionForManifest(manifest: AssistantPluginManifest, actionId: string): AssistantPluginActionDescriptor {
  const action = manifest.actions.find((entry) => entry.actionId === actionId);
  if (!action) throw new Error(`PLUGIN_ACTION_NOT_FOUND: ${manifest.pluginId}/${actionId}`);
  return action;
}

function denyAutomatedWrite(manifest: AssistantPluginManifest, action: AssistantPluginActionDescriptor, origin: AssistantPluginActionExecutionInput['origin']): void {
  if (!['schedule', 'reconciliation', 'system', 'assistant-routine'].includes(origin.surface)) return;
  if (action.readOnly) return;
  throw new Error(`EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED: ${manifest.pluginId}/${action.actionId} cannot run from ${origin.surface}`);
}

export type ListAssistantPluginManifestsOptions = {
  /**
   * Prefer previously persisted manifests for connector/status hot paths.
   * Live adapter rebuild (including host probes such as Xcode) runs only when
   * no stored manifest exists, or when forceRefresh is true.
   */
  preferStored?: boolean;
  forceRefresh?: boolean;
};

function listAssistantPluginIds(repository: RepositoryRecord): string[] {
  return [...PLUGIN_ADAPTERS.values()]
    .filter((adapter) => adapterMatchesRepository(adapter, repository))
    .map((adapter) => adapter.pluginId)
    .sort((left, right) => left.localeCompare(right));
}

export function listAssistantPluginManifests(
  controllerHome: string,
  repository: RepositoryRecord,
  options: ListAssistantPluginManifestsOptions = {},
): AssistantPluginManifest[] {
  const preferStored = options.preferStored === true && options.forceRefresh !== true;
  const cacheKey = listCacheKey(controllerHome, repository.repoId, preferStored);
  if (options.forceRefresh !== true) {
    const cached = readPluginManifestCache(pluginManifestListCache, cacheKey);
    if (cached) return cached;
  }
  const manifests = listAssistantPluginIds(repository)
    .map((pluginId) => {
      if (preferStored) {
        const stored = readStoredManifest(controllerHome, repository.repoId, pluginId);
        if (stored) return stored;
      }
      return computeManifest(controllerHome, repository, pluginId);
    })
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  primePluginManifestItemCache(controllerHome, repository.repoId, manifests, preferStored);
  return writePluginManifestCache(pluginManifestListCache, cacheKey, manifests);
}

export function getAssistantPluginManifest(
  controllerHome: string,
  repository: RepositoryRecord,
  pluginId: string,
): AssistantPluginManifest {
  const cacheKey = itemCacheKey(controllerHome, repository.repoId, pluginId, false);
  const cached = readPluginManifestCache(pluginManifestItemCache, cacheKey);
  if (cached) return cached;
  const manifest = computeManifest(controllerHome, repository, pluginId);
  return writePluginManifestCache(pluginManifestItemCache, cacheKey, manifest);
}

export function syncAssistantPluginRegistry(
  controllerHome: string,
  repository: RepositoryRecord,
): { manifests: AssistantPluginManifest[]; index: AssistantPluginRegistryIndex } {
  invalidateAssistantPluginManifestCache(controllerHome, repository.repoId);
  const manifests = listAssistantPluginManifests(controllerHome, repository, { forceRefresh: true });
  for (const manifest of manifests) {
    writeJsonAtomic(manifestPath(controllerHome, repository.repoId, manifest.pluginId), manifest);
  }
  return {
    manifests,
    index: writeRegistry(controllerHome, repository.repoId, manifests),
  };
}

function syncAssistantPluginManifest(
  controllerHome: string,
  repository: RepositoryRecord,
  pluginId: string,
): { manifest: AssistantPluginManifest; index: AssistantPluginRegistryIndex } {
  invalidateAssistantPluginManifestCache(controllerHome, repository.repoId, pluginId);
  const manifest = computeManifest(controllerHome, repository, pluginId);
  writeJsonAtomic(manifestPath(controllerHome, repository.repoId, manifest.pluginId), manifest);
  cacheAssistantPluginManifest(controllerHome, repository.repoId, manifest, false);
  cacheAssistantPluginManifest(controllerHome, repository.repoId, manifest, true);
  const manifests = listAssistantPluginIds(repository)
    .map((candidatePluginId) => {
      if (candidatePluginId === pluginId) return manifest;
      return readStoredManifest(controllerHome, repository.repoId, candidatePluginId)
        ?? cachedManifestForRepository(controllerHome, repository.repoId, candidatePluginId);
    })
    .filter((entry): entry is AssistantPluginManifest => Boolean(entry))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  return {
    manifest,
    index: writeRegistry(controllerHome, repository.repoId, manifests),
  };
}

export function isDirectPluginReadAction(action: AssistantPluginActionDescriptor): boolean {
  return action.readOnly === true
    && action.risk === 'readonly'
    && action.confirmation === 'none'
    && action.idempotent === true;
}

export async function executeAssistantPluginReadDirect(
  controllerHome: string,
  repository: RepositoryRecord,
  request: AssistantPluginActionRequest,
): Promise<{ manifest: AssistantPluginManifest; action: AssistantPluginActionDescriptor; result: Record<string, unknown> }> {
  const manifest = getAssistantPluginManifest(controllerHome, repository, request.pluginId);
  const action = actionForManifest(manifest, request.actionId);
  if (!manifest.enabled && action.actionId !== 'configure') {
    throw new Error(`PLUGIN_DISABLED: ${request.pluginId} is disabled`);
  }
  if (!isDirectPluginReadAction(action)) {
    throw new Error(`PLUGIN_DIRECT_READ_NOT_ALLOWED: ${request.pluginId}/${request.actionId}`);
  }
  const normalizedArgs = validateActionArguments(action, request.args ?? {});
  enforceConfirmation(action, { ...request, args: normalizedArgs });
  const result = await executeAssistantPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    pluginId: request.pluginId,
    actionId: request.actionId,
    requestId: request.requestId,
    args: normalizedArgs,
    origin: request.origin,
  });
  return { manifest, action, result };
}

export function submitAssistantPluginAction(
  controllerHome: string,
  repository: RepositoryRecord,
  request: AssistantPluginActionRequest,
): { manifest: AssistantPluginManifest; action: AssistantPluginActionDescriptor; job: ExecutionJob; deduplicated: boolean } {
  const manifest = getAssistantPluginManifest(controllerHome, repository, request.pluginId);
  const action = actionForManifest(manifest, request.actionId);
  if (!manifest.enabled && action.actionId !== 'configure') {
    throw new Error(`PLUGIN_DISABLED: ${request.pluginId} is disabled`);
  }
  const normalizedArgs = validateActionArguments(action, request.args ?? {});
  enforceConfirmation(action, { ...request, args: normalizedArgs });
  const timeoutMs = typeof request.timeoutMs === 'number' ? request.timeoutMs : action.defaultTimeoutMs;
  const created = createExecutionJob(controllerHome, {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    type: 'plugin-action',
    requestId: request.requestId,
    semanticKey: semanticKey(repository, request.pluginId, request.actionId, normalizedArgs),
    priority: action.risk === 'destructive' ? 'P0' : action.risk === 'remote_write' ? 'P1' : 'P2',
    origin: request.origin,
    payload: {
      operation: 'plugin_action_execute',
      target: 'runtime',
      timeoutMs,
      arguments: {
        pluginId: request.pluginId,
        actionId: request.actionId,
        actionArguments: normalizedArgs,
        manifestRevision: manifest.revision,
      },
    },
    resourceClaims: mapResourceClaims(action, repository),
    timeoutMs,
    maxAttempts: 1,
  });
  if (!created.deduplicated) {
    appendRuntimeEvent(controllerHome, {
      repoId: repository.repoId,
      entityType: 'plugin',
      entityId: manifest.pluginId,
      eventType: 'plugin_action_requested',
      requestId: request.requestId,
      revision: manifest.revision,
      data: {
        actionId: action.actionId,
        jobId: created.job.jobId,
        risk: action.risk,
        confirmation: action.confirmation,
      },
    });
  }
  return { manifest, action, job: created.job, deduplicated: created.deduplicated };
}

export async function executeAssistantPluginAction(
  input: AssistantPluginActionExecutionInput,
): Promise<Record<string, unknown>> {
  const adapter = PLUGIN_ADAPTERS.get(input.pluginId);
  if (!adapter) throw new Error(`PLUGIN_NOT_FOUND: ${input.pluginId}`);
  const repository = {
    repoId: input.repoId,
    canonicalRoot: input.repoRoot,
    activeCheckoutId: 'active',
  } as RepositoryRecord;
  const manifest = getAssistantPluginManifest(input.controllerHome, repository, input.pluginId);
  const action = actionForManifest(manifest, input.actionId);
  denyAutomatedWrite(manifest, action, input.origin);
  const normalizedArgs = validateActionArguments(action, input.args);
  try {
    const result = await adapter.executeAction({ ...input, args: normalizedArgs });
    const synced = syncAssistantPluginManifest(input.controllerHome, repository, input.pluginId);
    const nextManifest = synced.manifest;
    appendRuntimeEvent(input.controllerHome, {
      repoId: input.repoId,
      entityType: 'plugin',
      entityId: input.pluginId,
      eventType: 'plugin_action_succeeded',
      requestId: input.requestId,
      revision: nextManifest.revision,
      data: {
        actionId: input.actionId,
        jobId: input.jobId,
        resultKeys: Object.keys(result).slice(0, 20),
        lifecycleState: nextManifest.lifecycle.state,
        healthState: nextManifest.health.state,
      },
    });
    return {
      schemaVersion: 1,
      plugin: {
        pluginId: nextManifest.pluginId,
        provider: nextManifest.provider,
        revision: nextManifest.revision,
        lifecycle: nextManifest.lifecycle,
        health: nextManifest.health,
      },
      action: {
        actionId: action.actionId,
        confirmation: action.confirmation,
        risk: action.risk,
        requestId: input.requestId,
      },
      result,
    };
  } catch (error) {
    const pluginError = toAssistantPluginError(error, {
      code: 'PLUGIN_ACTION_FAILED',
      message: `Plugin action ${input.pluginId}/${input.actionId} failed.`,
      retryable: true,
      details: {
        pluginId: input.pluginId,
        actionId: input.actionId,
      },
    });
    const refreshed = syncAssistantPluginManifest(input.controllerHome, repository, input.pluginId);
    const nextManifest = refreshed.manifest;
    appendRuntimeEvent(input.controllerHome, {
      repoId: input.repoId,
      entityType: 'plugin',
      entityId: input.pluginId,
      eventType: 'plugin_action_failed',
      requestId: input.requestId,
      revision: nextManifest.revision,
      data: {
        actionId: input.actionId,
        jobId: input.jobId,
        code: pluginError.code,
        retryable: pluginError.retryable,
      },
    });
    throw new AssistantPluginError(pluginError.code, pluginError.message.replace(/^[^:]+:\s*/, ''), {
      retryable: pluginError.retryable,
      details: pluginError.details,
    });
  }
}
