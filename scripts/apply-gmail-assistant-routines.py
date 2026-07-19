from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# Schedule model: timezone-aware cron, bounded catch-up, and runtime targets.
replace_once(
    'src/runtime/workflow/schedules/types.ts',
    "  cronExpression?: string;\n  calendarAt?: string;",
    "  cronExpression?: string;\n  timezone?: string;\n  catchUpMinutes?: number;\n  calendarAt?: string;",
)
replace_once(
    'src/runtime/workflow/schedules/types.ts',
    "export interface ScheduleAction {\n  operation: string;\n  arguments?: Record<string, unknown>;",
    "export interface ScheduleAction {\n  operation: string;\n  target?: 'repository-tool' | 'mcp-tool' | 'runtime' | 'workspace-agent';\n  arguments?: Record<string, unknown>;",
)

engine_helpers = r'''
interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function zonedDateParts(at: number, timezone = 'UTC'): ZonedDateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error(`SCHEDULE_TIMEZONE_INVALID: ${timezone}`);
  }
  const values = Object.fromEntries(formatter.formatToParts(new Date(at)).map((entry) => [entry.type, entry.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdays[String(values.weekday)] ?? 0,
  };
}

function fixedCronTime(expression: string | undefined): { minute: number; hour: number; day: string; month: string; weekday: string } | undefined {
  if (!expression) return undefined;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) return undefined;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return undefined;
  return { minute, hour, day: fields[2], month: fields[3], weekday: fields[4] };
}

function cronWindowKey(schedule: RepositorySchedule, at = Date.now()): string {
  const timezone = schedule.trigger.timezone ?? 'UTC';
  const parts = zonedDateParts(at, timezone);
  const fixed = fixedCronTime(schedule.trigger.cronExpression);
  if (fixed) {
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}@${String(fixed.hour).padStart(2, '0')}:${String(fixed.minute).padStart(2, '0')}[${timezone}]`;
  }
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}[${timezone}]`;
}
'''
replace_once(
    'src/runtime/workflow/schedules/engine.ts',
    "function normalizedWindow(minutes: number, at = Date.now()): string {\n  return String(Math.floor(at / (Math.max(1, minutes) * 60_000)));\n}\n",
    "function normalizedWindow(minutes: number, at = Date.now()): string {\n  return String(Math.floor(at / (Math.max(1, minutes) * 60_000)));\n}\n" + engine_helpers,
)
replace_once(
    'src/runtime/workflow/schedules/engine.ts',
    "    case 'cron':\n      return new Date(at).toISOString().slice(0, 16);",
    "    case 'cron':\n      return cronWindowKey(schedule, at);",
)
old_cron = r'''function cronDue(expression: string | undefined, at = Date.now()): boolean {
  if (!expression) return false;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`SCHEDULE_CRON_INVALID: expected five fields, received ${fields.length}`);
  const date = new Date(at);
  return cronFieldMatches(date.getUTCMinutes(), fields[0], 0, 59)
    && cronFieldMatches(date.getUTCHours(), fields[1], 0, 23)
    && cronFieldMatches(date.getUTCDate(), fields[2], 1, 31)
    && cronFieldMatches(date.getUTCMonth() + 1, fields[3], 1, 12)
    && cronFieldMatches(date.getUTCDay(), fields[4], 0, 6);
}
'''
new_cron = r'''export function cronDue(
  expression: string | undefined,
  at = Date.now(),
  timezone = 'UTC',
  catchUpMinutes = 0,
): boolean {
  if (!expression) return false;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`SCHEDULE_CRON_INVALID: expected five fields, received ${fields.length}`);
  const parts = zonedDateParts(at, timezone);
  const calendarMatches = cronFieldMatches(parts.day, fields[2], 1, 31)
    && cronFieldMatches(parts.month, fields[3], 1, 12)
    && cronFieldMatches(parts.weekday, fields[4], 0, 6);
  if (!calendarMatches) return false;
  if (cronFieldMatches(parts.minute, fields[0], 0, 59) && cronFieldMatches(parts.hour, fields[1], 0, 23)) return true;
  const fixed = fixedCronTime(expression);
  if (!fixed || catchUpMinutes <= 0) return false;
  const scheduledMinute = fixed.hour * 60 + fixed.minute;
  const currentMinute = parts.hour * 60 + parts.minute;
  return currentMinute >= scheduledMinute && currentMinute - scheduledMinute <= Math.min(24 * 60, catchUpMinutes);
}
'''
replace_once('src/runtime/workflow/schedules/engine.ts', old_cron, new_cron)
replace_once(
    'src/runtime/workflow/schedules/engine.ts',
    "    case 'cron':\n      return { due: cronDue(schedule.trigger.cronExpression), reason: 'Cron expression is not due in the current UTC minute.' };",
    "    case 'cron':\n      return {\n        due: cronDue(schedule.trigger.cronExpression, Date.now(), schedule.trigger.timezone ?? 'UTC', schedule.trigger.catchUpMinutes ?? 0),\n        reason: `Cron expression is not due in the current ${schedule.trigger.timezone ?? 'UTC'} minute or catch-up window.`,\n      };",
)
replace_once(
    'src/runtime/workflow/schedules/engine.ts',
    "      target: 'mcp-tool',",
    "      target: schedule.action.target ?? 'mcp-tool',",
)

# Assistant creation/manual execution uses the durable runtime operation.
replace_once(
    'src/runtime/assistant/intent.ts',
    "import { getAssistantPluginManifest, submitAssistantPluginAction } from '../plugins/store';",
    "import { getAssistantPluginManifest, submitAssistantPluginAction } from '../plugins/store';\nimport { createExecutionJob } from '../execution/jobs/store';\nimport { bindAssistantRoutineSchedule } from './schedule-binding';",
)
replace_once(
    'src/runtime/assistant/intent.ts',
    "    const routine = createAssistantRoutine(repository.canonicalRoot, routineDraft);\n    const inboxItem = addAssistantInboxItem(repository.canonicalRoot, {",
    "    const routine = createAssistantRoutine(repository.canonicalRoot, routineDraft);\n    const binding = bindAssistantRoutineSchedule(controllerHome, repository, routine);\n    const inboxItem = addAssistantInboxItem(repository.canonicalRoot, {",
)
replace_once(
    'src/runtime/assistant/intent.ts',
    "      data: { routine },",
    "      data: { routine, binding },",
)
replace_once(
    'src/runtime/assistant/intent.ts',
    "      displayText: `已保存「${routine.name}」，计划：${routine.scheduleText}。`,",
    "      displayText: `已保存「${routine.name}」，并绑定到持久化 Schedule：${binding.normalizedSchedule}。`,",
)
start = "export function runAssistantRoutineNow(\n"
end = "\nexport function assistantRoutineDraftFromInput(input: AssistantIntentInput): AssistantRoutineDraft | undefined {"
intent_path = Path('src/runtime/assistant/intent.ts')
intent_text = intent_path.read_text()
left = intent_text.find(start)
right = intent_text.find(end)
if left < 0 or right < 0 or right <= left:
    raise SystemExit('runAssistantRoutineNow anchors not found')
new_run = r'''export function runAssistantRoutineNow(
  controllerHome: string,
  repository: RepositoryRecord,
  routineId: string,
): AssistantIntentResult {
  const routine = getAssistantRoutine(repository.canonicalRoot, routineId);
  if (routine.status !== 'enabled') throw new Error(`ASSISTANT_ROUTINE_NOT_ENABLED: ${routineId}`);
  const requestId = `routine-run-${routine.routineId}-${Date.now()}`;
  const created = createExecutionJob(controllerHome, {
    repoId: repository.repoId,
    checkoutId: repository.activeCheckoutId,
    type: 'mcp-tool',
    requestId,
    semanticKey: `assistant-routine:${routine.routineId}:${requestId}`,
    priority: 'P2',
    origin: { surface: 'assistant-routine', actor: routine.routineId, correlationId: requestId },
    payload: {
      operation: 'assistant_routine_execute',
      target: 'runtime',
      arguments: { routineId: routine.routineId },
      timeoutMs: 30 * 60_000,
    },
    resourceClaims: [{ resourceKey: `assistant-routine:${repository.repoId}:${routine.routineId}`, mode: 'exclusive' }],
    timeoutMs: 30 * 60_000,
    maxAttempts: 1,
  });
  const touched = touchAssistantRoutineRun(repository.canonicalRoot, routineId);
  const plan: AssistantPlanStepResult[] = [{
    stepId: 'routine-runtime',
    pluginId: 'assistant',
    actionId: 'assistant_routine_execute',
    status: 'submitted',
    risk: 'readonly',
    decision: 'allow',
    reason: 'A durable read-only Routine Runtime Job was queued.',
    job: created.job,
  }];
  const inboxItem = addAssistantInboxItem(repository.canonicalRoot, {
    kind: 'routine_result',
    title: `Routine 已排队：${routine.name}`,
    summary: '已提交持久化 Routine Runtime Job；完成后会生成最终邮件报告。',
    body: routine.naturalLanguageGoal,
    source: 'routine',
    relatedRoutineId: routine.routineId,
    relatedRequestId: requestId,
    jobIds: [created.job.jobId],
    recommendations: ['等待最终 Routine 报告；发送邮件和移入垃圾箱仍需单独确认。'],
    data: { routine: touched, jobId: created.job.jobId },
  });
  return {
    schemaVersion: 1,
    accepted: true,
    mode: 'execute',
    source: 'system',
    requestId,
    understoodIntent: 'run_routine',
    displayTitle: `Routine 已排队：${routine.name}`,
    displayText: `已为「${routine.name}」提交持久化执行 Job ${created.job.jobId}。`,
    requiresConfirmation: false,
    plan,
    routine: touched,
    inboxItem,
    clarifyingQuestions: [],
  };
}
'''
intent_path.write_text(intent_text[:left] + new_run + intent_text[right:])

# Local Controller keeps routine and schedule lifecycle synchronized.
replace_once(
    'src/cli/local-bridge/server.ts',
    'import { submitAssistantIntent, runAssistantRoutineNow } from "../../runtime/assistant/intent";',
    'import { submitAssistantIntent, runAssistantRoutineNow } from "../../runtime/assistant/intent";\nimport { updateAssistantRoutineLifecycle } from "../../runtime/assistant/schedule-binding";',
)
replace_once(
    'src/cli/local-bridge/server.ts',
    "  updateAssistantInboxStatus,\n  updateAssistantRoutineStatus,\n  upsertAssistantMemory,",
    "  updateAssistantInboxStatus,\n  upsertAssistantMemory,",
)
replace_once(
    'src/cli/local-bridge/server.ts',
    '      response.json({ routine: updateAssistantRoutineStatus(requestRepositoryRoot(request, options, controllerHome), request.params.routineId, "paused") });',
    '      const repository = requestRepositorySelection(request, options, controllerHome);\n      response.json(updateAssistantRoutineLifecycle(controllerHome, repository, request.params.routineId, "paused"));',
)
replace_once(
    'src/cli/local-bridge/server.ts',
    '      response.json({ routine: updateAssistantRoutineStatus(requestRepositoryRoot(request, options, controllerHome), request.params.routineId, "enabled") });',
    '      const repository = requestRepositorySelection(request, options, controllerHome);\n      response.json(updateAssistantRoutineLifecycle(controllerHome, repository, request.params.routineId, "enabled"));',
)
replace_once(
    'src/cli/local-bridge/server.ts',
    '      response.json({ routine: updateAssistantRoutineStatus(requestRepositoryRoot(request, options, controllerHome), request.params.routineId, "deleted") });',
    '      const repository = requestRepositorySelection(request, options, controllerHome);\n      response.json(updateAssistantRoutineLifecycle(controllerHome, repository, request.params.routineId, "deleted"));',
)

# Worker executes the typed runtime operation directly and returns the finalized report.
replace_once(
    'src/runtime/execution/workers/executor.ts',
    "import { isAssistantPluginError } from '../../plugins/errors';",
    "import { isAssistantPluginError } from '../../plugins/errors';\nimport { executeAssistantRoutineRuntime } from '../../assistant/routine-runtime';",
)
replace_once(
    'src/runtime/execution/workers/executor.ts',
    "    bindRepositoryEntities(repository);\n\n    if (job.payload.target === 'runtime' && job.payload.operation === 'legacy-local-job') {",
    "    bindRepositoryEntities(repository);\n\n    if (job.payload.target === 'runtime' && job.payload.operation === 'assistant_routine_execute') {\n      const routineId = String(job.payload.arguments?.routineId ?? job.payload.arguments?.routine_id ?? '').trim();\n      if (!routineId) throw new Error('ASSISTANT_ROUTINE_ID_REQUIRED');\n      const routineResult = await executeAssistantRoutineRuntime({\n        controllerHome,\n        repository,\n        routineId,\n        requestId: job.requestId,\n        origin: job.origin,\n        occurrenceId: typeof job.payload.occurrenceId === 'string' ? job.payload.occurrenceId : undefined,\n      });\n      return { ok: true, result: { assistantRoutine: routineResult }, repoRoot };\n    }\n\n    if (job.payload.target === 'runtime' && job.payload.operation === 'legacy-local-job') {",
)

# Routine completion updates lastRunAt only after successful finalization.
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "import { addAssistantInboxItem, getAssistantRoutine } from './store';",
    "import { addAssistantInboxItem, getAssistantRoutine, touchAssistantRoutineRun } from './store';",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    addAssistantInboxItem(input.repository.canonicalRoot, {\n      kind: 'routine_result',",
    "    touchAssistantRoutineRun(input.repository.canonicalRoot, routine.routineId);\n    addAssistantInboxItem(input.repository.canonicalRoot, {\n      kind: 'routine_result',",
)

# Google OAuth refresh and provider-verified readiness.
google = Path('src/runtime/plugins/google-shared.ts')
text = google.read_text()
text = text.replace(
    "  accessToken?: string;\n  errors: string[];",
    "  accessToken?: string;\n  refreshReady?: boolean;\n  errors: string[];",
    1,
)
text = text.replace(
    "const CONFIG_ROOT = '.repo-harness/plugins';\n",
    r'''const CONFIG_ROOT = '.repo-harness/plugins';

interface CachedGoogleCredential {
  accessToken: string;
  expiresAt: number;
  source: string;
}

const GOOGLE_ACCESS_TOKEN_CACHE = new Map<GoogleService, CachedGoogleCredential>();
const VERIFIED_GOOGLE_TOKEN_FINGERPRINTS = new Map<string, number>();

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function verifiedToken(token: string): boolean {
  const verifiedAt = VERIFIED_GOOGLE_TOKEN_FINGERPRINTS.get(tokenFingerprint(token));
  return Boolean(verifiedAt && Date.now() - verifiedAt < 24 * 60 * 60_000);
}

function cachedGoogleToken(service: GoogleService): CachedGoogleCredential | undefined {
  const cached = GOOGLE_ACCESS_TOKEN_CACHE.get(service);
  if (!cached || cached.expiresAt <= Date.now() + 30_000) return undefined;
  return cached;
}

function firstEnv(names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

function refreshTokenEnvNames(service: GoogleService): string[] {
  return [
    `REPO_HARNESS_${service.toUpperCase()}_REFRESH_TOKEN`,
    service === 'gmail' ? 'REPO_HARNESS_GMAIL_REFRESH_TOKEN' : '',
    'REPO_HARNESS_GOOGLE_WORKSPACE_REFRESH_TOKEN',
    'REPO_HARNESS_GOOGLE_REFRESH_TOKEN',
  ].filter(Boolean);
}

function clientIdEnvNames(service: GoogleService): string[] {
  return [`REPO_HARNESS_${service.toUpperCase()}_CLIENT_ID`, 'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID', 'REPO_HARNESS_GOOGLE_CLIENT_ID'];
}

function clientSecretEnvNames(service: GoogleService): string[] {
  return [`REPO_HARNESS_${service.toUpperCase()}_CLIENT_SECRET`, 'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET', 'REPO_HARNESS_GOOGLE_CLIENT_SECRET'];
}

function refreshCredentialsReady(service: GoogleService): boolean {
  return Boolean(firstEnv(refreshTokenEnvNames(service)) && firstEnv(clientIdEnvNames(service)) && firstEnv(clientSecretEnvNames(service)));
}
''',
    1,
)
start = text.find('export function resolveGoogleAuth(')
end = text.find('\nexport type GoogleReadinessMode', start)
if start < 0 or end < 0:
    raise SystemExit('resolveGoogleAuth anchors not found')
new_auth = r'''export function resolveGoogleAuth(
  service: GoogleService,
  config: GooglePluginConfig,
  options: { repoRoot?: string } = {},
): GoogleAuthState {
  bootstrapManagedRuntimeEnv({ repoRoot: options.repoRoot });
  if (config.provider === 'mock') {
    return {
      provider: 'mock', ready: true, authenticated: true, probed: true,
      credentialSource: 'mock', refreshReady: false, errors: [],
      warnings: ['Mock provider enabled. No external credentials are persisted or required.'],
    };
  }
  const cached = cachedGoogleToken(service);
  const configured = firstEnv(tokenEnvNames(service));
  const token = cached?.accessToken ?? configured?.value;
  const probed = Boolean(token && verifiedToken(token));
  const refreshReady = refreshCredentialsReady(service);
  if (token) {
    return {
      provider: 'google-workspace',
      ready: probed,
      authenticated: true,
      probed,
      credentialSource: cached?.source ?? `env:${configured?.name}`,
      accessToken: token,
      refreshReady,
      errors: [],
      warnings: probed ? [] : ['Google access token is configured but has not passed a live provider probe yet.'],
    };
  }
  return {
    provider: 'google-workspace', ready: false, authenticated: false, probed: false, refreshReady,
    errors: [`Set one of ${tokenEnvNames(service).join(', ')} before invoking ${service} Google Workspace actions.`],
    warnings: refreshReady ? ['Refresh credentials are configured but an initial access token or authorization handoff is still required.'] : [],
  };
}
'''
text = text[:start] + new_auth + text[end:]
start = text.find('export type GoogleReadinessMode =')
end = text.find('\nexport function googlePermission(', start)
if start < 0 or end < 0:
    raise SystemExit('readiness anchors not found')
new_readiness = r'''export type GoogleReadinessMode =
  | 'disabled'
  | 'missing_token'
  | 'live_token_unverified'
  | 'mock_provider_ready'
  | 'live_provider_ready';

export function resolveGoogleReadinessMode(config: GooglePluginConfig, auth: GoogleAuthState): GoogleReadinessMode {
  if (!config.enabled) return 'disabled';
  if (config.provider === 'mock' && auth.ready) return 'mock_provider_ready';
  if (config.provider === 'google-workspace' && auth.ready && auth.probed) return 'live_provider_ready';
  if (config.provider === 'google-workspace' && auth.authenticated) return 'live_token_unverified';
  return 'missing_token';
}

export function pluginStateFromGoogleAuth(config: GooglePluginConfig, auth: GoogleAuthState): {
  lifecycleState: AssistantPluginLifecycleState;
  health: AssistantPluginHealth;
} {
  const readinessMode = resolveGoogleReadinessMode(config, auth);
  const ready = readinessMode === 'mock_provider_ready' || readinessMode === 'live_provider_ready';
  const lifecycleState: AssistantPluginLifecycleState = !config.enabled ? 'disabled' : ready ? 'enabled' : 'degraded';
  const userFacingStatus = readinessMode === 'disabled'
    ? 'disabled'
    : readinessMode === 'mock_provider_ready'
      ? 'mock ready'
      : readinessMode === 'live_provider_ready'
        ? 'ready'
        : readinessMode === 'live_token_unverified'
          ? 'live token unverified'
          : 'live token missing';
  return {
    lifecycleState,
    health: {
      state: !config.enabled ? 'disabled' : ready ? 'ready' : 'degraded',
      checkedAt: new Date().toISOString(),
      ready: config.enabled && ready,
      probed: config.enabled ? auth.probed : false,
      errors: [],
      warnings: !config.enabled
        ? ['Plugin is disabled. Enable it before using Google provider actions.']
        : [...auth.warnings, ...(!auth.authenticated ? auth.errors : [])],
      details: {
        provider: config.provider,
        accountEmail: config.accountEmail,
        credentialSource: auth.credentialSource,
        credentialPersistence: 'tokens are loaded from managed process secrets and are never written to repository state',
        refreshReady: auth.refreshReady === true,
        readinessMode,
        userFacingStatus,
      },
    },
  };
}
'''
text = text[:start] + new_readiness + text[end:]
start = text.find('export async function googleApiRequest<T>(')
end = text.find('\nexport function encodeBase64Url', start)
if start < 0 or end < 0:
    raise SystemExit('googleApiRequest anchors not found')
new_request = r'''async function refreshGoogleAccessToken(service: GoogleService, timeoutMs: number): Promise<string | undefined> {
  const refreshToken = firstEnv(refreshTokenEnvNames(service));
  const clientId = firstEnv(clientIdEnvNames(service));
  const clientSecret = firstEnv(clientSecretEnvNames(service));
  if (!refreshToken || !clientId || !clientSecret) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken.value,
      client_id: clientId.value,
      client_secret: clientSecret.value,
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { parsed = { raw }; }
    const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
    if (!response.ok || !accessToken) {
      throw new AssistantPluginError('PLUGIN_AUTH_FAILED', 'Google refresh token exchange failed.', {
        retryable: false,
        details: { service, status: response.status, providerError: parsed },
      });
    }
    const expiresIn = typeof parsed.expires_in === 'number' ? Math.max(60, parsed.expires_in) : 3600;
    GOOGLE_ACCESS_TOKEN_CACHE.set(service, {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      source: `refresh:${refreshToken.name}`,
    });
    return accessToken;
  } finally {
    clearTimeout(timeout);
  }
}

async function googleFetch(options: GoogleApiRequestOptions, accessToken: string): Promise<{ response: Response; parsed: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  const url = `${serviceBaseUrl(options.service)}${options.path}${buildQueryString(options.query ?? {})}`;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { parsed = { raw }; }
    return { response, parsed };
  } finally {
    clearTimeout(timeout);
  }
}

export function clearGoogleAuthCachesForTest(): void {
  GOOGLE_ACCESS_TOKEN_CACHE.clear();
  VERIFIED_GOOGLE_TOKEN_FINGERPRINTS.clear();
}

export async function googleApiRequest<T>(options: GoogleApiRequestOptions): Promise<T> {
  try {
    const cached = cachedGoogleToken(options.service);
    let accessToken = cached?.accessToken ?? options.accessToken;
    let attempt = await googleFetch(options, accessToken);
    if ((attempt.response.status === 401 || attempt.response.status === 403) && refreshCredentialsReady(options.service)) {
      const refreshed = await refreshGoogleAccessToken(options.service, options.timeoutMs ?? 60_000);
      if (refreshed) {
        accessToken = refreshed;
        attempt = await googleFetch(options, accessToken);
      }
    }
    const { response, parsed } = attempt;
    if (response.status === 401 || response.status === 403) {
      throw new AssistantPluginError('PLUGIN_AUTH_FAILED', 'Google provider rejected the access token.', {
        retryable: false,
        details: { service: options.service, status: response.status, providerError: parsed, refreshReady: refreshCredentialsReady(options.service) },
      });
    }
    if (response.status === 429) {
      throw new AssistantPluginError('PLUGIN_RATE_LIMITED', 'Google provider rate limited the request.', {
        retryable: true,
        details: { service: options.service, status: response.status, retryAfter: response.headers.get('retry-after') ?? undefined, providerError: parsed },
      });
    }
    if (response.status >= 500) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_UNAVAILABLE', 'Google provider is temporarily unavailable.', {
        retryable: true,
        details: { service: options.service, status: response.status, providerError: parsed },
      });
    }
    if (!response.ok) {
      throw new AssistantPluginError('PLUGIN_PROVIDER_ERROR', `Google provider returned HTTP ${response.status}.`, {
        retryable: false,
        details: { service: options.service, status: response.status, providerError: parsed },
      });
    }
    VERIFIED_GOOGLE_TOKEN_FINGERPRINTS.set(tokenFingerprint(accessToken), Date.now());
    const current = cachedGoogleToken(options.service);
    if (current?.accessToken === accessToken) GOOGLE_ACCESS_TOKEN_CACHE.set(options.service, { ...current, expiresAt: Math.max(current.expiresAt, Date.now() + 60_000) });
    return parsed as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AssistantPluginError('PLUGIN_PROVIDER_TIMEOUT', 'Google provider request timed out.', {
        retryable: true,
        details: { service: options.service, timeoutMs: options.timeoutMs ?? 60_000 },
      });
    }
    throw toAssistantPluginError(error, {
      code: 'PLUGIN_PROVIDER_ERROR', message: 'Google provider request failed.', retryable: true, details: { service: options.service },
    });
  }
}
'''
text = text[:start] + new_request + text[end:]
google.write_text(text)

print('Applied Gmail assistant routine integration patches.')
