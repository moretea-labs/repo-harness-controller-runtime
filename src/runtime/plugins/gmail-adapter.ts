import type {
  AssistantPluginActionDescriptor,
  AssistantPluginActionExecutionInput,
  AssistantPluginCapability,
  AssistantPluginManifest,
  AssistantPluginPermissionScope,
} from './types';
import { AssistantPluginError } from './errors';
import {
  type GmailPluginConfig,
  encodeBase64Url,
  gmailPluginConfigPath,
  googleApiRequest,
  googlePermission,
  loadGmailPluginConfig,
  pluginStateFromGoogleAuth,
  resolveGoogleAuth,
  saveGmailPluginConfig,
  stableMockId,
} from './google-shared';

const GMAIL_PLUGIN_ID = 'gmail';

interface GmailProvider {
  listMessages(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;
  getMessage(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;
  createDraft(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;
  sendMessage(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;
  trashMessage(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;
}

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((entry) => String(entry).trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function gmailPermissions(ready: boolean): AssistantPluginPermissionScope[] {
  return [
    googlePermission('gmail.readonly', 'read', 'Read Gmail message metadata and content.', ready),
    googlePermission('gmail.compose', 'write', 'Create Gmail drafts without sending mail.', ready),
    googlePermission('gmail.send', 'write', 'Send Gmail messages on behalf of the configured mailbox.', ready),
    googlePermission('gmail.modify', 'write', 'Move or trash Gmail messages.', ready),
  ];
}

function gmailCapabilities(): AssistantPluginCapability[] {
  return [
    {
      capabilityId: 'inbox-read',
      title: 'Inbox Read',
      description: 'Search Gmail messages and read structured message details.',
      scopes: ['gmail.readonly'],
      actions: ['list_messages', 'get_message'],
    },
    {
      capabilityId: 'mail-compose',
      title: 'Mail Compose',
      description: 'Draft and send Gmail messages with explicit confirmation for consequential delivery.',
      scopes: ['gmail.compose', 'gmail.send'],
      actions: ['create_draft', 'send_message'],
    },
    {
      capabilityId: 'message-triage',
      title: 'Message Triage',
      description: 'Move Gmail messages to trash with destructive confirmation.',
      scopes: ['gmail.modify'],
      actions: ['trash_message'],
    },
  ];
}

function gmailActions(): AssistantPluginActionDescriptor[] {
  return [
    {
      actionId: 'configure',
      title: 'Configure Gmail plugin',
      description: 'Enable Gmail access, choose provider mode, and save non-secret mailbox defaults.',
      readOnly: false,
      risk: 'workspace_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['gmail.readonly', 'gmail.compose', 'gmail.send', 'gmail.modify'],
      resourceClaims: [{ resource: 'repo-state', mode: 'write' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          provider: { type: 'string', enum: ['mock', 'google-workspace'] },
          account_email: { type: 'string' },
          clear_account_email: { type: 'boolean' },
          default_query: { type: 'string' },
          clear_default_query: { type: 'boolean' },
          default_timeout_ms: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'list_messages',
      title: 'List Gmail messages',
      description: 'List Gmail messages by query, label, and page size.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['gmail.readonly'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          label_ids: { type: 'array', items: { type: 'string' } },
          max_results: { type: 'number' },
          page_token: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      actionId: 'get_message',
      title: 'Get Gmail message',
      description: 'Read one Gmail message.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['gmail.readonly'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          format: { type: 'string', enum: ['metadata', 'full'] },
        },
        required: ['message_id'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'create_draft',
      title: 'Create Gmail draft',
      description: 'Create a Gmail draft without sending it.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'authorization',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: false,
      scopes: ['gmail.compose'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body_text: { type: 'string' },
        },
        required: ['to', 'subject', 'body_text'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'send_message',
      title: 'Send Gmail message',
      description: 'Send a Gmail message after strong confirmation.',
      readOnly: false,
      risk: 'remote_write',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'send-gmail-message',
      defaultTimeoutMs: 45_000,
      cancellable: true,
      idempotent: false,
      scopes: ['gmail.send'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' } },
          cc: { type: 'array', items: { type: 'string' } },
          bcc: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body_text: { type: 'string' },
        },
        required: ['to', 'subject', 'body_text'],
        additionalProperties: false,
      },
    },
    {
      actionId: 'trash_message',
      title: 'Trash Gmail message',
      description: 'Move a Gmail message to trash.',
      readOnly: false,
      risk: 'destructive',
      confirmation: 'strong_confirmation',
      requiredConfirmationText: 'trash-gmail-message',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['gmail.modify'],
      resourceClaims: [{ resource: 'remote', mode: 'exclusive' }],
      argumentsSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
        },
        required: ['message_id'],
        additionalProperties: false,
      },
    },
  ];
}

function buildMimeMessage(args: Record<string, unknown>, config: GmailPluginConfig): string {
  const to = stringArray(args.to);
  const cc = stringArray(args.cc);
  const bcc = stringArray(args.bcc);
  const subject = stringValue(args.subject);
  const bodyText = stringValue(args.body_text);
  if (!to || !subject || !bodyText) {
    throw new AssistantPluginError('PLUGIN_ACTION_ARGUMENT_INVALID', 'to, subject, and body_text are required.');
  }
  const headers = [
    `To: ${to.join(', ')}`,
    ...(cc ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc ? [`Bcc: ${bcc.join(', ')}`] : []),
    ...(config.accountEmail ? [`From: ${config.accountEmail}`] : []),
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    bodyText,
  ];
  return headers.join('\r\n');
}

function mockGmailProvider(): GmailProvider {
  return {
    async listMessages(args, config) {
      const messageId = stableMockId('gmail_msg', { query: args.query, labelIds: args.label_ids, provider: config.provider });
      return {
        provider: 'mock',
        mailbox: config.accountEmail ?? 'mock-user@example.com',
        messages: [{
          id: messageId,
          threadId: `${messageId}_thread`,
          snippet: `Mock Gmail result for ${String(args.query ?? config.defaultQuery ?? 'inbox')}`,
          labelIds: stringArray(args.label_ids) ?? ['INBOX'],
        }],
        nextPageToken: undefined,
      };
    },
    async getMessage(args, config) {
      const messageId = String(args.message_id);
      return {
        provider: 'mock',
        mailbox: config.accountEmail ?? 'mock-user@example.com',
        message: {
          id: messageId,
          threadId: `${messageId}_thread`,
          snippet: `Mock Gmail message ${messageId}`,
          payload: {
            headers: [
              { name: 'From', value: 'sender@example.com' },
              { name: 'To', value: config.accountEmail ?? 'mock-user@example.com' },
              { name: 'Subject', value: 'Mock subject' },
            ],
            body: { size: 32, data: 'Mock body preview' },
          },
        },
      };
    },
    async createDraft(args, config) {
      const draftId = stableMockId('gmail_draft', args);
      return {
        provider: 'mock',
        mailbox: config.accountEmail ?? 'mock-user@example.com',
        draft: {
          id: draftId,
          messageId: stableMockId('gmail_msg', { draftId }),
          subject: String(args.subject),
          to: stringArray(args.to) ?? [],
        },
      };
    },
    async sendMessage(args, config) {
      const messageId = stableMockId('gmail_sent', args);
      return {
        provider: 'mock',
        mailbox: config.accountEmail ?? 'mock-user@example.com',
        message: {
          id: messageId,
          threadId: `${messageId}_thread`,
          acceptedAt: now(),
          to: stringArray(args.to) ?? [],
          subject: String(args.subject),
        },
      };
    },
    async trashMessage(args) {
      return {
        provider: 'mock',
        message: {
          id: String(args.message_id),
          trashed: true,
          changedAt: now(),
        },
      };
    },
  };
}

function liveGmailProvider(config: GmailPluginConfig): GmailProvider {
  const auth = resolveGoogleAuth('gmail', config);
  if (!auth.ready || !auth.accessToken) {
    throw new AssistantPluginError('PLUGIN_AUTH_REQUIRED', auth.errors[0] ?? 'Gmail access token is required.', {
      retryable: false,
      details: {
        pluginId: GMAIL_PLUGIN_ID,
        provider: config.provider,
      },
    });
  }
  const accessToken = auth.accessToken;
  return {
    async listMessages(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'gmail',
        path: '/gmail/v1/users/me/messages',
        accessToken,
        query: {
          q: stringValue(args.query) ?? config.defaultQuery,
          pageToken: stringValue(args.page_token),
          maxResults: positiveNumber(args.max_results, 20),
          labelIds: stringArray(args.label_ids)?.join(','),
        },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async getMessage(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'gmail',
        path: `/gmail/v1/users/me/messages/${encodeURIComponent(String(args.message_id))}`,
        accessToken,
        query: {
          format: stringValue(args.format) ?? 'metadata',
        },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async createDraft(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'gmail',
        path: '/gmail/v1/users/me/drafts',
        method: 'POST',
        accessToken,
        body: {
          message: {
            raw: encodeBase64Url(buildMimeMessage(args, config)),
          },
        },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async sendMessage(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'gmail',
        path: '/gmail/v1/users/me/messages/send',
        method: 'POST',
        accessToken,
        body: {
          raw: encodeBase64Url(buildMimeMessage(args, config)),
        },
        timeoutMs: config.defaultTimeoutMs,
      });
    },
    async trashMessage(args) {
      return googleApiRequest<Record<string, unknown>>({
        service: 'gmail',
        path: `/gmail/v1/users/me/messages/${encodeURIComponent(String(args.message_id))}/trash`,
        method: 'POST',
        accessToken,
        timeoutMs: config.defaultTimeoutMs,
      });
    },
  };
}

function gmailProvider(config: GmailPluginConfig): GmailProvider {
  return config.provider === 'mock' ? mockGmailProvider() : liveGmailProvider(config);
}

export function buildGmailPluginManifest(previousRevision = 0, previousUpdatedAt?: string, repoRoot?: string): AssistantPluginManifest {
  const config = loadGmailPluginConfig(repoRoot ?? process.cwd());
  const auth = resolveGoogleAuth('gmail', config);
  const state = pluginStateFromGoogleAuth(config, auth);
  return {
    schemaVersion: 1,
    manifestVersion: 1,
    revision: Math.max(1, previousRevision || 1),
    pluginId: GMAIL_PLUGIN_ID,
    provider: 'google',
    displayName: 'Gmail Assistant Plugin',
    pluginVersion: '1.0.0',
    authority: {
      strategy: 'derived',
      duplicateStateAllowed: false,
      sourceOfTruth: [`repo-local:${gmailPluginConfigPath()}`, 'env:REPO_HARNESS_*_ACCESS_TOKEN'],
    },
    enabled: config.enabled,
    lifecycle: {
      state: state.lifecycleState,
      reason: !config.enabled
        ? 'Gmail plugin is disabled.'
        : auth.ready
          ? `Gmail plugin is ready via ${auth.credentialSource}.`
          : auth.errors[0],
    },
    health: state.health,
    permissions: gmailPermissions(auth.ready),
    capabilities: gmailCapabilities(),
    actions: gmailActions(),
    updatedAt: previousUpdatedAt ?? now(),
  };
}

export async function executeGmailPluginAction(input: AssistantPluginActionExecutionInput): Promise<Record<string, unknown>> {
  const current = loadGmailPluginConfig(input.repoRoot);
  switch (input.actionId) {
    case 'configure': {
      const args = input.args;
      const config = saveGmailPluginConfig(input.repoRoot, {
        enabled: typeof args.enabled === 'boolean' ? args.enabled : current.enabled,
        provider: args.provider === 'google-workspace' ? 'google-workspace' : args.provider === 'mock' ? 'mock' : current.provider,
        accountEmail: args.clear_account_email === true ? undefined : stringValue(args.account_email) ?? current.accountEmail,
        defaultQuery: args.clear_default_query === true ? undefined : stringValue(args.default_query) ?? current.defaultQuery,
        defaultTimeoutMs: typeof args.default_timeout_ms === 'number' ? positiveNumber(args.default_timeout_ms, 30_000) : current.defaultTimeoutMs,
      });
      return {
        config,
        auth: resolveGoogleAuth('gmail', config),
      };
    }
    case 'list_messages':
      return gmailProvider(current).listMessages(input.args, current);
    case 'get_message':
      return gmailProvider(current).getMessage(input.args, current);
    case 'create_draft':
      return gmailProvider(current).createDraft(input.args, current);
    case 'send_message':
      return gmailProvider(current).sendMessage(input.args, current);
    case 'trash_message':
      return gmailProvider(current).trashMessage(input.args, current);
    default:
      throw new AssistantPluginError('PLUGIN_ACTION_NOT_SUPPORTED', `gmail/${input.actionId} is not supported.`, {
        retryable: false,
      });
  }
}

export const gmailPluginAdapter = {
  pluginId: GMAIL_PLUGIN_ID,
  buildManifest: buildGmailPluginManifest,
  executeAction: executeGmailPluginAction,
};
