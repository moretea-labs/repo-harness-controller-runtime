import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import {
  type GoogleCalendarPluginConfig,
  googleApiRequest,
  googleCalendarPluginConfigPath,
  googlePermission,
  loadGoogleCalendarPluginConfig,
  pluginStateFromGoogleAuth,
  resolveGoogleAuth,
  saveGoogleCalendarPluginConfig,
  stableMockId,
} from './google-shared';

const GOOGLE_CALENDAR_PLUGIN_ID = 'google_calendar';

interface CalendarProvider {
  listEvents(args: Record<string, unknown>, config: GoogleCalendarPluginConfig): Promise<Record<string, unknown>>;
  getEvent(args: Record<string, unknown>, config: GoogleCalendarPluginConfig): Promise<Record<string, unknown>>;
  createEvent(args: Record<string, unknown>, config: GoogleCalendarPluginConfig): Promise<Record<string, unknown>>;
  rescheduleEvent(args: Record<string, unknown>, config: GoogleCalendarPluginConfig): Promise<Record<string, unknown>>;
  cancelEvent(args: Record<string, unknown>, config: GoogleCalendarPluginConfig): Promise<Record<string, unknown>>;
}

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function calendarPermissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    googlePermission('calendar.events.readonly', 'read', 'Read Google Calendar events and availability windows.', ready),
    googlePermission('calendar.events.write', 'write', 'Create and update Google Calendar events.', ready),
    googlePermission('calendar.events.delete', 'write', 'Cancel Google Calendar events.', ready),
  ];
}

function calendarCapabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'calendar-read',
      title: 'Calendar Read',
      description: 'List and inspect Google Calendar events.',
      scopes: ['calendar.events.readonly'],
      actions: ['list_events', 'get_event'],
    },
    {
      capabilityId: 'calendar-plan',
      title: 'Calendar Plan',
      description: 'Create and reschedule calendar events with explicit authorization.',
      scopes: ['calendar.events.write'],
      actions: ['create_event', 'reschedule_event'],
    },
    {
      capabilityId: 'calendar-cancel',
      title: 'Calendar Cancel',
      description: 'Cancel calendar events after strong confirmation.',
      scopes: ['calendar.events.delete'],
      actions: ['cancel_event'],
    },
  ];
}

function calendarActions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'configure',
      title: 'Configure Google Calendar plugin',
      description: 'Enable Calendar access, choose provider mode, and save non-secret calendar defaults.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['calendar.events.readonly', 'calendar.events.write', 'calendar.events.delete'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          provider: { type: 'string', enum: ['mock', 'google-workspace'] },
          account_email: { type: 'string' },
          clear_account_email: { type: 'boolean' },
          calendar_id: { type: 'string' },
          clear_calendar_id: { type: 'boolean' },
          timezone: { type: 'string' },
          clear_timezone: { type: 'boolean' },
          default_timeout_ms: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'list_events',
      title: 'List Calendar events',
      description: 'List events in a time window.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['calendar.events.readonly'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          calendar_id: { type: 'string' },
          time_min: { type: 'string' },
          time_max: { type: 'string' },
          query: { type: 'string' },
          max_results: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'get_event',
      title: 'Get Calendar event',
      description: 'Read one calendar event.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['calendar.events.readonly'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          calendar_id: { type: 'string' },
          event_id: { type: 'string' },
        },
        required: ['event_id'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'create_event',
      title: 'Create Calendar event',
      description: 'Create a calendar event.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: false,
      scopes: ['calendar.events.write'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          calendar_id: { type: 'string' },
          summary: { type: 'string' },
          description: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          time_zone: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'start', 'end'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'reschedule_event',
      title: 'Reschedule Calendar event',
      description: 'Move a calendar event to a different time window.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'reschedule-calendar-event',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: false,
      scopes: ['calendar.events.write'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          calendar_id: { type: 'string' },
          event_id: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          time_zone: { type: 'string' },
        },
        required: ['event_id', 'start', 'end'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'cancel_event',
      title: 'Cancel Calendar event',
      description: 'Cancel a calendar event.',
      readOnly: false,
      risk: 'destructive',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'cancel-calendar-event',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: true,
      scopes: ['calendar.events.delete'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          calendar_id: { type: 'string' },
          event_id: { type: 'string' },
        },
        required: ['event_id'],
        additionalProperties: false,
      },
    },
  ];
}

function eventBody(args: Record<string, unknown>, config: GoogleCalendarPluginConfig): Record<string, unknown> {
  const summary = stringValue(args.summary);
  const start = stringValue(args.start);
  const end = stringValue(args.end);
  if (!start || !end) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'start and end are required.');
  }
  return {
    ...(summary ? { summary } : {}),
    ...(stringValue(args.description) ? { description: stringValue(args.description) } : {}),
    start: {
      dateTime: start,
      timeZone: stringValue(args.time_zone) ?? config.timezone,
    },
    end: {
      dateTime: end,
      timeZone: stringValue(args.time_zone) ?? config.timezone,
    },
    ...(Array.isArray(args.attendees)
      ? { attendees: args.attendees.map((entry) => ({ email: String(entry) })) }
      : {}),
  };
}

function mockCalendarProvider(): CalendarProvider {
  return {
    async listEvents(args, config) {
      const eventId = stableMockId('gcal_evt', { args, calendarId: args.calendar_id ?? config.calendarId });
      return {
        provider: 'mock',
        calendarId: String(args.calendar_id ?? config.calendarId ?? 'primary'),
        items: [{
          id: eventId,
          summary: `Mock event for ${String(args.query ?? 'calendar')}`,
          start: { dateTime: String(args.time_min ?? now()) },
          end: { dateTime: String(args.time_max ?? now()) },
        }],
      };
    },
    async getEvent(args, config) {
      return {
        provider: 'mock',
        calendarId: String(args.calendar_id ?? config.calendarId ?? 'primary'),
        event: {
          id: String(args.event_id),
          summary: 'Mock calendar event',
          start: { dateTime: now() },
          end: { dateTime: new Date(Date.now() + 3_600_000).toISOString() },
        },
      };
    },
    async createEvent(args, config) {
      return {
        provider: 'mock',
        calendarId: String(args.calendar_id ?? config.calendarId ?? 'primary'),
        event: {
          id: stableMockId('gcal_evt', args),
          ...eventBody(args, config),
          createdAt: now(),
        },
      };
    },
    async rescheduleEvent(args, config) {
      return {
        provider: 'mock',
        calendarId: String(args.calendar_id ?? config.calendarId ?? 'primary'),
        event: {
          id: String(args.event_id),
          ...eventBody(args, config),
          rescheduledAt: now(),
        },
      };
    },
    async cancelEvent(args, config) {
      return {
        provider: 'mock',
        calendarId: String(args.calendar_id ?? config.calendarId ?? 'primary'),
        event: {
          id: String(args.event_id),
          status: 'cancelled',
          cancelledAt: now(),
        },
      };
    },
  };
}

function liveCalendarProvider(config: GoogleCalendarPluginConfig, repoRoot?: string): CalendarProvider {
  const auth = resolveGoogleAuth('calendar', config, { repoRoot });
  if (!auth.ready || !auth.accessToken) {
    throw new AssistantPluginError('PLUGIN_AUTH_REQUIRED', auth.errors[0] ?? 'Calendar access token is required.', {
      retryable: false,
      details: {
        pluginId: GOOGLE_CALENDAR_PLUGIN_ID,
        provider: config.provider,
      },
    });
  }
  const accessToken = auth.accessToken;
  const calendarId = (args: Record<string, unknown>) => encodeURIComponent(String(args.calendar_id ?? config.calendarId ?? 'primary'));
  return {
    async listEvents(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'calendar',
        path: `/calendar/v3/calendars/${calendarId(args)}/events`,
        accessToken,
        query: {
          timeMin: stringValue(args.time_min),
          timeMax: stringValue(args.time_max),
          q: stringValue(args.query),
          maxResults: positiveNumber(args.max_results, 20),
          singleEvents: true,
          orderBy: 'startTime',
        },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async getEvent(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'calendar',
        path: `/calendar/v3/calendars/${calendarId(args)}/events/${encodeURIComponent(String(args.event_id))}`,
        accessToken,
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async createEvent(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'calendar',
        path: `/calendar/v3/calendars/${calendarId(args)}/events`,
        method: 'POST',
        accessToken,
        body: eventBody(args, config),
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async rescheduleEvent(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'calendar',
        path: `/calendar/v3/calendars/${calendarId(args)}/events/${encodeURIComponent(String(args.event_id))}`,
        method: 'PATCH',
        accessToken,
        body: eventBody(args, config),
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async cancelEvent(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'calendar',
        path: `/calendar/v3/calendars/${calendarId(args)}/events/${encodeURIComponent(String(args.event_id))}`,
        method: 'PATCH',
        accessToken,
        body: { status: 'cancelled' },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
  };
}

function calendarProvider(config: GoogleCalendarPluginConfig, repoRoot?: string): CalendarProvider {
  return config.provider === 'mock' ? mockCalendarProvider() : liveCalendarProvider(config, repoRoot);
}

export function buildGoogleCalendarPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const root = repoRoot ?? process.cwd();
  const config = loadGoogleCalendarPluginConfig(root);
  const auth = resolveGoogleAuth('calendar', config, { repoRoot: root });
  const state = pluginStateFromGoogleAuth(config, auth);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: GOOGLE_CALENDAR_PLUGIN_ID,
    provider: 'google',
    displayName: 'Google Calendar Assistant Plugin',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: [`repo-local:${googleCalendarPluginConfigPath()}`, 'env:REPO_HARNESS_*_ACCESS_TOKEN'],
    },
    enabled: config.enabled,
    lifecycle: {
      state: state.lifecycleState,
      reason: !config.enabled
        ? 'Google Calendar plugin is disabled.'
        : auth.ready
          ? `Google Calendar plugin is ready via ${auth.credentialSource}.`
          : auth.errors[0],
    },
    health: state.health,
    permissions: calendarPermissions(auth.ready),
    capabilities: calendarCapabilities(),
    actions: calendarActions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeGoogleCalendarPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const current = loadGoogleCalendarPluginConfig(input.repoRoot);
  switch (input.actionId) {
    case 'configure': {
      const args = input.args;
      const config = saveGoogleCalendarPluginConfig(input.repoRoot, {
        enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled,
        provider: args.provider === 'google-workspace' ? 'google-workspace' : args.provider === 'mock' ? 'mock' : current.provider,
        accountEmail: args.clear_account_email === true ? undefined : stringValue(args.account_email) ?? current.accountEmail,
        calendarId: args.clear_calendar_id === true ? undefined : stringValue(args.calendar_id) ?? current.calendarId,
        timezone: args.clear_timezone === true ? undefined : stringValue(args.timezone) ?? current.timezone,
        defaultTimeoutMs: typeof args.default_timeout_ms === 'number' ? positiveNumber(args.default_timeout_ms, 30_000) : current.defaultTimeoutMs,
      });
      return {
        config,
        auth: resolveGoogleAuth('calendar', config, { repoRoot: input.repoRoot }),
      };
    }
    case 'list_events':
      return calendarProvider(current, input.repoRoot).listEvents(input.args, current);
    case 'get_event':
      return calendarProvider(current, input.repoRoot).getEvent(input.args, current);
    case 'create_event':
      return calendarProvider(current, input.repoRoot).createEvent(input.args, current);
    case 'reschedule_event':
      return calendarProvider(current, input.repoRoot).rescheduleEvent(input.args, current);
    case 'cancel_event':
      return calendarProvider(current, input.repoRoot).cancelEvent(input.args, current);
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `google_calendar/${input.actionId} is not supported.`, {
        retryable: false,
      });
  }
}

export const googleCalendarPluginAdapter = {
  pluginId: GOOGLE_CALENDAR_PLUGIN_ID,
  buildManifest: buildGoogleCalendarPluginManifest,
  executeAction: executeGoogleCalendarPluginAction,
};
