import { createHash } from 'crypto';
import { join } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
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
  [gmailPluginAdapter.pluginId, gmailPluginAdapter],
  [googleCalendarPluginAdapter.pluginId, googleCalendarPluginAdapter],
  [googleTasksPluginAdapter.pluginId, googleTasksPluginAdapter],
]);

function now(): string {
  return new Date().toISOString();
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

function computeManifest(controllerHome: string, repository: RepositoryRecord, pluginId: string): AssistantPluginManifest {
  const adapter = PLUGIN_ADAPTERS.get(pluginId);
  if (!adapter) throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
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
  return action.resourceClaims.map((claim) => ({
    resourceKey: claim.resource === 'remote'
      ? `remote:${repository.repoId}`
      : claim.resource === 'workspace'
        ? `workspace:${repository.activeCheckoutId}`
        : claim.resource === 'git-refs'
          ? `git-refs:${repository.repoId}`
          : 'repo-state',
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
  if (action.confirmation === 'none') return;
  if (action.confirmation === 'authorization' && request.confirmAuthorization !== true) {
    throw new Error(`PLUGIN_CONFIRMATION_REQUIRED: ${request.pluginId}/${request.actionId} requires confirmAuthorization=true`);
  }
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

export function listAssistantPluginManifests(
  controllerHome: string,
  repository: RepositoryRecord,
): AssistantPluginManifest[] {
  return [...PLUGIN_ADAPTERS.keys()]
    .map((pluginId) => computeManifest(controllerHome, repository, pluginId))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export function getAssistantPluginManifest(
  controllerHome: string,
  repository: RepositoryRecord,
  pluginId: string,
): AssistantPluginManifest {
  return computeManifest(controllerHome, repository, pluginId);
}

export function syncAssistantPluginRegistry(
  controllerHome: string,
  repository: RepositoryRecord,
): { manifests: AssistantPluginManifest[]; index: AssistantPluginRegistryIndex } {
  const manifests = listAssistantPluginManifests(controllerHome, repository);
  for (const manifest of manifests) {
    writeJsonAtomic(manifestPath(controllerHome, repository.repoId, manifest.pluginId), manifest);
  }
  return {
    manifests,
    index: writeRegistry(controllerHome, repository.repoId, manifests),
  };
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
    const synced = syncAssistantPluginRegistry(input.controllerHome, repository);
    const nextManifest = synced.manifests.find((entry) => entry.pluginId === input.pluginId) ?? manifest;
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
    const refreshed = syncAssistantPluginRegistry(input.controllerHome, repository);
    const nextManifest = refreshed.manifests.find((entry) => entry.pluginId === input.pluginId) ?? manifest;
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
