from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))

# Export safe tooling modules.
replace_once(
    'src/runtime/safe-tooling/index.ts',
    "export * from './workspace-auth';",
    "export * from './workspace-auth';\nexport * from './google-oauth-broker';\nexport * from './google-credential-store';",
)

# Google provider: Keychain refresh credentials and proactive refresh after restart.
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';",
    "import { bootstrapManagedRuntimeEnv } from '../shared/managed-env';\nimport { readStoredGoogleRefreshToken } from '../safe-tooling/google-credential-store';",
)
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "const CONFIG_ROOT = '.repo-harness/plugins';",
    "const CONFIG_ROOT = '.repo-harness/plugins';\nconst REFRESH_REQUIRED_ACCESS_TOKEN = '__repo_harness_refresh_required__';",
)
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "function refreshCredentialsReady(service: GoogleService): boolean {\n  return Boolean(firstEnv(refreshTokenEnvNames(service)) && firstEnv(clientIdEnvNames(service)) && firstEnv(clientSecretEnvNames(service)));\n}",
    "function refreshCredential(service: GoogleService): { name: string; value: string } | undefined {\n  const fromEnv = firstEnv(refreshTokenEnvNames(service));\n  if (fromEnv) return fromEnv;\n  const stored = readStoredGoogleRefreshToken(service);\n  return stored ? { name: stored.source, value: stored.token } : undefined;\n}\n\nfunction refreshCredentialsReady(service: GoogleService): boolean {\n  return Boolean(refreshCredential(service) && firstEnv(clientIdEnvNames(service)) && firstEnv(clientSecretEnvNames(service)));\n}\n\nexport function installGoogleAccessToken(service: GoogleService, accessToken: string, expiresInSeconds = 3600, source = 'oauth'): void {\n  const token = accessToken.trim();\n  if (!token) throw new Error('GOOGLE_ACCESS_TOKEN_REQUIRED');\n  GOOGLE_ACCESS_TOKEN_CACHE.set(service, {\n    accessToken: token,\n    expiresAt: Date.now() + Math.max(60, expiresInSeconds) * 1000,\n    source,\n  });\n}",
)
old_auth_tail = """  return {
    provider: 'google-workspace', ready: false, authenticated: false, probed: false, refreshReady,
    errors: [`Set one of ${tokenEnvNames(service).join(', ')} before invoking ${service} Google Workspace actions.`],
    warnings: refreshReady ? ['Refresh credentials are configured but an initial access token or authorization handoff is still required.'] : [],
  };"""
new_auth_tail = """  if (refreshReady) {
    const refresh = refreshCredential(service);
    return {
      provider: 'google-workspace', ready: true, authenticated: true, probed: false, refreshReady: true,
      credentialSource: refresh?.name,
      accessToken: REFRESH_REQUIRED_ACCESS_TOKEN,
      errors: [],
      warnings: ['A stored refresh credential is available; the next provider request will refresh and verify an access token.'],
    };
  }
  return {
    provider: 'google-workspace', ready: false, authenticated: false, probed: false, refreshReady: false,
    errors: [`Complete workspace_auth_login_prepare or set one of ${tokenEnvNames(service).join(', ')}.`],
    warnings: [],
  };"""
replace_once('src/runtime/plugins/google-shared.ts', old_auth_tail, new_auth_tail)
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "  const refreshToken = firstEnv(refreshTokenEnvNames(service));",
    "  const refreshToken = refreshCredential(service);",
)
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "    GOOGLE_ACCESS_TOKEN_CACHE.set(service, {\n      accessToken,\n      expiresAt: Date.now() + expiresIn * 1000,\n      source: `refresh:${refreshToken.name}`,\n    });",
    "    installGoogleAccessToken(service, accessToken, expiresIn, `refresh:${refreshToken.name}`);",
)
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "    let accessToken = cached?.accessToken ?? options.accessToken;\n    let attempt = await googleFetch(options, accessToken);",
    "    let accessToken = cached?.accessToken ?? options.accessToken;\n    if (accessToken === REFRESH_REQUIRED_ACCESS_TOKEN && refreshCredentialsReady(options.service)) {\n      accessToken = await refreshGoogleAccessToken(options.service, options.timeoutMs ?? 60_000) ?? accessToken;\n    }\n    let attempt = await googleFetch(options, accessToken);",
)

# Gmail profile/history actions.
replace_once(
    'src/runtime/plugins/gmail-adapter.ts',
    "  listLabels(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;",
    "  listLabels(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;\n  getProfile(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;\n  listHistory(args: Record<string, unknown>, config: GmailPluginConfig): Promise<Record<string, unknown>>;",
)
replace_once(
    'src/runtime/plugins/gmail-adapter.ts',
    "      actions: ['list_messages', 'get_message', 'list_labels'],",
    "      actions: ['list_messages', 'get_message', 'list_labels', 'get_profile', 'list_history'],",
)
profile_actions = """    {
      actionId: 'get_profile',
      title: 'Get Gmail profile',
      description: 'Read mailbox identity and the current Gmail history ID.',
      readOnly: true,
      risk: 'readonly',
      confirmation: 'none',
      defaultTimeoutMs: 30_000,
      cancellable: true,
      idempotent: true,
      scopes: ['gmail.readonly'],
      resourceClaims: [{ resource: 'remote', mode: 'read' }],
      argumentsSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      actionId: 'list_history',
      title: 'List Gmail history',
      description: 'List incremental Gmail mailbox changes after a history ID.',
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
          start_history_id: { type: 'string' },
          page_token: { type: 'string' },
          max_results: { type: 'number' },
          label_id: { type: 'string' },
          history_type: { type: 'string', enum: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'] },
        },
        required: ['start_history_id'],
        additionalProperties: false,
      },
    },
"""
replace_once(
    'src/runtime/plugins/gmail-adapter.ts',
    "    {\n      actionId: 'create_draft',",
    profile_actions + "    {\n      actionId: 'create_draft',",
)
replace_once(
    'src/runtime/plugins/gmail-adapter.ts',
    "    async createDraft(args, config) {",
    "    async getProfile(_args, config) {\n      return { provider: 'mock', emailAddress: config.accountEmail ?? 'mock-user@example.com', messagesTotal: 1, threadsTotal: 1, historyId: '1000' };\n    },\n    async listHistory(args) {\n      const messageId = stableMockId('gmail_history_msg', { startHistoryId: args.start_history_id });\n      return { history: [{ id: '1001', messagesAdded: [{ message: { id: messageId, threadId: `${messageId}_thread`, labelIds: ['INBOX'] } }] }], historyId: '1001' };\n    },\n    async createDraft(args, config) {",
)
replace_once(
    'src/runtime/plugins/gmail-adapter.ts',
    "    async createDraft(args) {\n      return googleApiRequest<Record<string, unknown>>({",
    "    async getProfile() {\n      return googleApiRequest<Record<string, unknown>>({\n        service: 'gmail', path: '/gmail/v1/users/me/profile', accessToken, timeoutMs: config.defaultTimeoutMs,\n      });\n    },\n    async listHistory(args) {\n      return googleApiRequest<Record<string, unknown>>({\n        service: 'gmail',\n        path: '/gmail/v1/users/me/history',\n        accessToken,\n        query: {\n          startHistoryId: requiredString(args.start_history_id, 'start_history_id'),\n          pageToken: stringValue(args.page_token),\n          maxResults: positiveNumber(args.max_results, 100),\n          labelId: stringValue(args.label_id),\n          historyTypes: stringValue(args.history_type) ?? 'messageAdded',\n        },\n        timeoutMs: config.defaultTimeoutMs,\n      });\n    },\n    async createDraft(args) {\n      return googleApiRequest<Record<string, unknown>>({",
)
replace_once(
    'src/runtime/plugins/gmail-adapter.ts',
    "    case 'list_labels':\n      return gmailProvider(current, input.repoRoot).listLabels(input.args, current);",
    "    case 'list_labels':\n      return gmailProvider(current, input.repoRoot).listLabels(input.args, current);\n    case 'get_profile':\n      return gmailProvider(current, input.repoRoot).getProfile(input.args, current);\n    case 'list_history':\n      return gmailProvider(current, input.repoRoot).listHistory(input.args, current);",
)

# Routine Runtime: History cursor and durable proposals.
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "import { executeAssistantPluginAction } from '../plugins/store';",
    "import { executeAssistantPluginAction } from '../plugins/store';\nimport { isAssistantPluginError } from '../plugins/errors';\nimport {\n  createAssistantActionProposals,\n  type AssistantActionProposal,\n  type AssistantActionProposalInput,\n} from './action-proposals';",
)
start = "interface AssistantActionProposal {\n  type: 'reply_candidate' | 'task_candidate' | 'archive_candidate';\n  messageId: string;\n  summary: string;\n  risk: 'proposal_only';\n}\n\n"
replace_once('src/runtime/assistant/routine-runtime.ts', start, '')
old_proposals = """function proposalsFor(messages: GmailMessageSummary[]): AssistantActionProposal[] {
  const proposals: AssistantActionProposal[] = [];
  for (const message of messages) {
    const text = `${message.subject} ${message.snippet} ${message.bodyPreview ?? ''}`.toLowerCase();
    if (/(please reply|reply requested|请回复|需要回复|your response)/i.test(text)) {
      proposals.push({ type: 'reply_candidate', messageId: message.id, summary: `Prepare a reviewable reply draft for “${message.subject}”.`, risk: 'proposal_only' });
    }
    if (/(action required|todo|deadline|due date|需要处理|截止|待办)/i.test(text)) {
      proposals.push({ type: 'task_candidate', messageId: message.id, summary: `Create a task candidate from “${message.subject}”.`, risk: 'proposal_only' });
    }
    if (/(newsletter|digest|marketing|unsubscribe|推广|营销|周报)/i.test(text)) {
      proposals.push({ type: 'archive_candidate', messageId: message.id, summary: `Review “${message.subject}” as an archive candidate.`, risk: 'proposal_only' });
    }
  }
  return proposals.slice(0, 50);
}"""
new_proposals = """function senderAddress(value: string): string | undefined {
  return value.match(/<([^>]+@[^>]+)>/)?.[1] ?? value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)?.[0];
}

function proposalsFor(messages: GmailMessageSummary[]): AssistantActionProposalInput[] {
  const proposals: AssistantActionProposalInput[] = [];
  for (const message of messages) {
    const text = `${message.subject} ${message.snippet} ${message.bodyPreview ?? ''}`.toLowerCase();
    if (/(please reply|reply requested|请回复|需要回复|your response)/i.test(text)) {
      const to = senderAddress(message.from);
      proposals.push({
        pluginId: 'gmail', actionId: 'create_draft', evidenceMessageIds: [message.id],
        reason: `Prepare a reviewable reply draft for “${message.subject}”.`, confidence: 0.75,
        executable: Boolean(to),
        arguments: to ? { to: [to], subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`, body_text: '[Draft response pending review]' } : {},
      });
    }
    if (/(action required|todo|deadline|due date|需要处理|截止|待办)/i.test(text)) {
      proposals.push({
        pluginId: 'google_tasks', actionId: 'create_task', evidenceMessageIds: [message.id],
        reason: `Create a task from “${message.subject}”.`, confidence: 0.8,
        arguments: { title: message.subject, notes: `${message.from}\\n${message.snippet}`.slice(0, 2_000) },
      });
    }
    if (/(newsletter|digest|marketing|unsubscribe|推广|营销|周报)/i.test(text)) {
      proposals.push({
        pluginId: 'gmail', actionId: 'archive_message', evidenceMessageIds: [message.id],
        reason: `Archive candidate: “${message.subject}”.`, confidence: 0.7,
        arguments: { message_id: message.id },
      });
    }
  }
  return proposals.slice(0, 50);
}"""
replace_once('src/runtime/assistant/routine-runtime.ts', old_proposals, new_proposals)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "function renderReport(messages: GmailMessageSummary[], proposals: AssistantActionProposal[], windowStart: string, windowEnd: string): string {",
    "function renderReport(messages: GmailMessageSummary[], proposals: AssistantActionProposalInput[], windowStart: string, windowEnd: string): string {",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "...(proposals.length > 0 ? proposals.slice(0, 20).map((proposal) => `- ${proposal.summary}`) : ['- 暂无。']),",
    "...(proposals.length > 0 ? proposals.slice(0, 20).map((proposal) => `- ${proposal.reason}`) : ['- 暂无。']),",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    const profile = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:profile`, 'list_labels', {});\n    const overlapStart = Math.max(0, Date.parse(windowStart) - 5 * 60_000);\n    const query = `in:inbox -in:spam -in:trash after:${Math.floor(overlapStart / 1000)}`;\n    const known = new Set(cursor.processedMessageIds);\n    const messageIds: string[] = [];\n    let pageToken: string | undefined;\n    for (let page = 0; page < 5 && messageIds.length < 100; page += 1) {\n      const listed = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:list:${page}`, 'list_messages', {\n        query,\n        max_results: 25,\n        ...(pageToken ? { page_token: pageToken } : {}),\n      });\n      const listedMessages = Array.isArray(listed.messages) ? listed.messages.map(recordValue) : [];\n      for (const message of listedMessages) {\n        const id = stringValue(message.id);\n        if (id && !known.has(id) && !messageIds.includes(id)) messageIds.push(id);\n      }\n      pageToken = stringValue(listed.nextPageToken);\n      if (!pageToken) break;\n    }",
    "    const profile = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:profile`, 'get_profile', {});\n    const known = new Set(cursor.processedMessageIds);\n    const messageIds: string[] = [];\n    let historyFallback = !cursor.historyId;\n    if (cursor.historyId) {\n      try {\n        let historyPageToken: string | undefined;\n        for (let page = 0; page < 5 && messageIds.length < 100; page += 1) {\n          const history = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:history:${page}`, 'list_history', {\n            start_history_id: cursor.historyId, max_results: 100, label_id: 'INBOX', history_type: 'messageAdded',\n            ...(historyPageToken ? { page_token: historyPageToken } : {}),\n          });\n          for (const entry of Array.isArray(history.history) ? history.history.map(recordValue) : []) {\n            for (const added of Array.isArray(entry.messagesAdded) ? entry.messagesAdded.map(recordValue) : []) {\n              const id = stringValue(recordValue(added.message).id);\n              if (id && !known.has(id) && !messageIds.includes(id)) messageIds.push(id);\n            }\n          }\n          historyPageToken = stringValue(history.nextPageToken);\n          if (!historyPageToken) break;\n        }\n      } catch (error) {\n        const status = isAssistantPluginError(error) ? Number(error.details?.status) : undefined;\n        if (status !== 404) throw error;\n        historyFallback = true;\n      }\n    }\n    if (historyFallback) {\n      const overlapStart = Math.max(0, Date.parse(windowStart) - 5 * 60_000);\n      const query = `in:inbox -in:spam -in:trash after:${Math.floor(overlapStart / 1000)}`;\n      let pageToken: string | undefined;\n      for (let page = 0; page < 5 && messageIds.length < 100; page += 1) {\n        const listed = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:list:${page}`, 'list_messages', {\n          query, max_results: 25, ...(pageToken ? { page_token: pageToken } : {}),\n        });\n        for (const message of Array.isArray(listed.messages) ? listed.messages.map(recordValue) : []) {\n          const id = stringValue(message.id);\n          if (id && !known.has(id) && !messageIds.includes(id)) messageIds.push(id);\n        }\n        pageToken = stringValue(listed.nextPageToken);\n        if (!pageToken) break;\n      }\n    }",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    const proposals = proposalsFor(messages);\n    const truncated = messageIds.length > messages.length;",
    "    const proposalInputs = proposalsFor(messages);\n    const proposals = createAssistantActionProposals(input.controllerHome, input.repository, { routineId: routine.routineId, runId, proposals: proposalInputs });\n    const truncated = messageIds.length > messages.length;",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "      historyId: stringValue(profile.historyId),",
    "      historyId: truncated ? cursor.historyId : stringValue(profile.historyId) ?? cursor.historyId,",
)

# Local Bridge OAuth callback and proposal endpoints.
replace_once(
    'src/cli/local-bridge/server.ts',
    "import { assistantOpenApiSchema } from \"../../runtime/assistant/openapi\";",
    "import { assistantOpenApiSchema } from \"../../runtime/assistant/openapi\";\nimport { completeGoogleOAuthLogin } from \"../../runtime/safe-tooling/google-oauth-broker\";\nimport { approveAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from \"../../runtime/assistant/action-proposals\";",
)
oauth_route = """  app.get("/oauth/google/callback", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const result = await completeGoogleOAuthLogin(controllerHome, {
        state: queryString(request.query.state),
        code: queryString(request.query.code),
        error: queryString(request.query.error),
        errorDescription: queryString(request.query.error_description),
      });
      response.status(200).type("html").send(`<!doctype html><meta charset="utf-8"><title>Google authorization complete</title><h1>Google authorization complete</h1><p>${String(result.service)} is connected. You can close this window.</p>`);
    } catch (error) {
      response.status(400).type("html").send(`<!doctype html><meta charset="utf-8"><title>Google authorization failed</title><h1>Google authorization failed</h1><p>${errorMessage(error).replace(/[<>&]/g, "")}</p>`);
    }
  });

"""
replace_once('src/cli/local-bridge/server.ts', '  app.use("/api", requireToken);', oauth_route + '  app.use("/api", requireToken);')
proposal_routes = """  app.get("/api/assistant/proposals", (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json(listAssistantActionProposals(controllerHome, repository, {
        status: typeof request.query.status === "string" ? request.query.status as any : undefined,
        limit: Number(request.query.limit) || undefined,
      }));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/assistant/proposals/:proposalId/approve", (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.status(202).json({ proposal: approveAssistantActionProposal(controllerHome, repository, {
        proposalId: request.params.proposalId,
        requestId: queryString(request.body?.requestId) ?? `proposal-approval-${request.params.proposalId}`,
        confirmationText: queryString(request.body?.confirmationText),
      }) });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/assistant/proposals/:proposalId/reject", (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json({ proposal: rejectAssistantActionProposal(controllerHome, repository, request.params.proposalId, queryString(request.body?.reason)) });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

"""
replace_once('src/cli/local-bridge/server.ts', '  app.get("/api/assistant/routines", (request, response) => {', proposal_routes + '  app.get("/api/assistant/routines", (request, response) => {')

# MCP tool surface for OAuth prepare and proposal resolution.
replace_once(
    'src/runtime/gateway/mcp/runtime-tools.ts',
    "import { buildAssistantReadinessReport } from '../../assistant/readiness';",
    "import { buildAssistantReadinessReport } from '../../assistant/readiness';\nimport { approveAssistantActionProposal, getAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from '../../assistant/action-proposals';",
)
replace_once(
    'src/runtime/gateway/mcp/runtime-tools.ts',
    "  definition('workspace_auth_login_prepare', 'Prepare a local Google Workspace/Gmail OAuth login handoff without receiving or storing secrets.', {",
    "  definition('workspace_auth_login_prepare', 'Prepare a state-protected local Google Workspace/Gmail OAuth login with PKCE and Keychain persistence.', {",
)
proposal_defs = """  definition('assistant_action_proposals', 'List or get structured Assistant action proposals and execution status.', {
    repo_id: repoId,
    proposal_id: { type: 'string' },
    status: { type: 'string', enum: ['proposed', 'approved', 'rejected', 'executed', 'failed', 'expired'] },
    limit: { type: 'number' },
  }),
  definition('assistant_action_proposal_resolve', 'Approve or reject one Assistant action proposal. Approval submits a separate user-authorized plugin Job.', {
    repo_id: repoId,
    proposal_id: { type: 'string' },
    decision: { type: 'string', enum: ['approve', 'reject'] },
    request_id: { type: 'string' },
    reason: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
    confirmation_text: { type: 'string' },
  }, ['proposal_id', 'decision'], false),
"""
replace_once('src/runtime/gateway/mcp/runtime-tools.ts', "  definition('external_filesystem_targets_list'", proposal_defs + "  definition('external_filesystem_targets_list'")
replace_once(
    'src/runtime/gateway/mcp/runtime-tools.ts',
    "        return result(prepareWorkspaceAuthLogin({",
    "        return result(prepareWorkspaceAuthLogin(ctx.controllerHome, {",
)
proposal_cases = """      case 'assistant_action_proposals': {
        const repository = selected(ctx, args);
        const proposalId = typeof args.proposal_id === 'string' ? args.proposal_id.trim() : '';
        return result(proposalId
          ? { proposal: getAssistantActionProposal(ctx.controllerHome, repository, proposalId) }
          : listAssistantActionProposals(ctx.controllerHome, repository, {
              status: typeof args.status === 'string' ? args.status as any : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
            }));
      }
      case 'assistant_action_proposal_resolve': {
        const repository = selected(ctx, args);
        const proposalId = String(args.proposal_id ?? '').trim();
        if (args.decision === 'reject') {
          return result({ proposal: rejectAssistantActionProposal(ctx.controllerHome, repository, proposalId, typeof args.reason === 'string' ? args.reason : undefined) });
        }
        if (args.confirm_authorization !== true) throw new Error('ASSISTANT_ACTION_APPROVAL_REQUIRED: confirm_authorization=true');
        const requestId = String(args.request_id ?? `assistant-proposal:${proposalId}`).trim();
        return result({ proposal: approveAssistantActionProposal(ctx.controllerHome, repository, {
          proposalId,
          requestId,
          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,
        }) });
      }
"""
replace_once('src/runtime/gateway/mcp/runtime-tools.ts', "      case 'external_filesystem_targets_list': {", proposal_cases + "      case 'external_filesystem_targets_list': {")

replace_once(
    'src/cli/mcp/toolset-names.ts',
    "  'workspace_auth_login_prepare',",
    "  'workspace_auth_login_prepare',\n  'assistant_action_proposals',\n  'assistant_action_proposal_resolve',",
)

print('Applied Google OAuth, Gmail History, and Assistant Proposal integration.')
