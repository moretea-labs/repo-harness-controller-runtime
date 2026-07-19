from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))

# OAuth broker: restrict callback/scopes, prune stale state, and redact the verifier after use.
replace_once(
    'src/runtime/safe-tooling/google-oauth-broker.ts',
    "import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';",
    "import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';",
)
replace_once(
    'src/runtime/safe-tooling/google-oauth-broker.ts',
    "const REQUEST_TTL_MS = 10 * 60_000;",
    """const REQUEST_TTL_MS = 10 * 60_000;
const RETAIN_CONSUMED_REQUEST_MS = 24 * 60 * 60_000;
const ALLOWED_SCOPES: Record<GoogleOAuthService, Set<string>> = {
  gmail: new Set([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
  ]),
  calendar: new Set(['https://www.googleapis.com/auth/calendar']),
  tasks: new Set(['https://www.googleapis.com/auth/tasks']),
  'google-workspace': new Set([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
  ]),
};

function validateRedirectUri(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('GOOGLE_OAUTH_REDIRECT_INVALID: redirect URI must be a URL'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_NOT_LOCAL: redirect URI must use loopback HTTP');
  }
  if (parsed.pathname !== '/oauth/google/callback' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_INVALID: use the local /oauth/google/callback endpoint');
  }
  return parsed.toString();
}

function validateScopes(service: GoogleOAuthService, scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  const invalid = normalized.filter((scope) => !ALLOWED_SCOPES[service].has(scope));
  if (invalid.length > 0) throw new Error(`GOOGLE_OAUTH_SCOPE_NOT_ALLOWED: ${invalid.join(', ')}`);
  if (normalized.length === 0) throw new Error('GOOGLE_OAUTH_SCOPE_REQUIRED');
  return normalized;
}

function pruneOAuthRequests(controllerHome: string): void {
  const root = join(oauthRoot(controllerHome), 'requests');
  try {
    for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json')).slice(0, 2_000)) {
      const path = join(root, name);
      try {
        const record = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GoogleOAuthRequestRecord>;
        const expired = Date.parse(String(record.expiresAt ?? '')) <= Date.now();
        const consumedOld = record.consumedAt && Date.now() - Date.parse(record.consumedAt) > RETAIN_CONSUMED_REQUEST_MS;
        if (expired || consumedOld) unlinkSync(path);
      } catch { unlinkSync(path); }
    }
  } catch { /* no request store yet */ }
}""",
)
replace_once(
    'src/runtime/safe-tooling/google-oauth-broker.ts',
    "  const configuredClientId = clientId();",
    "  pruneOAuthRequests(controllerHome);\n  const redirectUri = validateRedirectUri(input.redirectUri);\n  const scopes = validateScopes(input.service, input.scopes);\n  const configuredClientId = clientId();",
)
replace_once(
    'src/runtime/safe-tooling/google-oauth-broker.ts',
    "    redirectUri: input.redirectUri,\n    scopes: [...new Set(input.scopes)],",
    "    redirectUri,\n    scopes,",
)
replace_once(
    'src/runtime/safe-tooling/google-oauth-broker.ts',
    "  selected.record.consumedAt = new Date().toISOString();\n  writeRecord(selected.path, selected.record);",
    "  const codeVerifier = selected.record.codeVerifier;\n  if (!codeVerifier) throw new Error('GOOGLE_OAUTH_STATE_INVALID: PKCE verifier is missing');\n  selected.record.codeVerifier = '';\n  selected.record.consumedAt = new Date().toISOString();\n  writeRecord(selected.path, selected.record);",
)
replace_once(
    'src/runtime/safe-tooling/google-oauth-broker.ts',
    "    code_verifier: selected.record.codeVerifier,",
    "    code_verifier: codeVerifier,",
)

# Workspace auth: normalize safe aliases, keep legacy guidance, and let broker enforce loopback/scopes.
replace_once(
    'src/runtime/safe-tooling/workspace-auth.ts',
    "};\n\nfunction normalizeService",
    """};

const SCOPE_ALIASES: Record<string, string> = {
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.compose': 'https://www.googleapis.com/auth/gmail.compose',
  'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'calendar.events.readonly': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.write': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.delete': 'https://www.googleapis.com/auth/calendar',
  'tasks.readonly': 'https://www.googleapis.com/auth/tasks',
  'tasks.write': 'https://www.googleapis.com/auth/tasks',
  'tasks.delete': 'https://www.googleapis.com/auth/tasks',
};

function normalizeService""",
)
old_body = """  const service = normalizeService(input.service);
  const redirectUri = input.redirectUri || process.env.REPO_HARNESS_GOOGLE_REDIRECT_URI || 'http://127.0.0.1:8766/oauth/google/callback';
  const requestedScopes = Array.isArray(input.scopes) && input.scopes.length > 0
    ? input.scopes.map(String).filter(Boolean)
    : SERVICE_SCOPES[service];
  return prepareGoogleOAuthLogin(controllerHome, {
    service,
    scopes: requestedScopes,
    redirectUri,
  });"""
new_body = """  const service = normalizeService(input.service);
  const redirectUri = input.redirectUri || process.env.REPO_HARNESS_GOOGLE_REDIRECT_URI || 'http://127.0.0.1:8766/oauth/google/callback';
  const requestedScopes = Array.isArray(input.scopes) && input.scopes.length > 0
    ? input.scopes.map((scope) => SCOPE_ALIASES[String(scope)] ?? String(scope)).filter(Boolean)
    : SERVICE_SCOPES[service];
  const prepared = prepareGoogleOAuthLogin(controllerHome, { service, scopes: requestedScopes, redirectUri });
  const priorSafety = prepared.safety && typeof prepared.safety === 'object' && !Array.isArray(prepared.safety)
    ? prepared.safety as Record<string, unknown>
    : {};
  return {
    ...prepared,
    tokenEnvironmentVariables: service === 'gmail'
      ? ['REPO_HARNESS_GMAIL_ACCESS_TOKEN', 'REPO_HARNESS_GMAIL_REFRESH_TOKEN']
      : ['REPO_HARNESS_GOOGLE_WORKSPACE_ACCESS_TOKEN', 'REPO_HARNESS_GOOGLE_WORKSPACE_REFRESH_TOKEN'],
    safety: {
      ...priorSafety,
      credentialMaterialPersisted: false,
      credentialMaterialPersistedInRepository: false,
    },
  };"""
replace_once('src/runtime/safe-tooling/workspace-auth.ts', old_body, new_body)

# Google env aliases for Calendar/Tasks refresh credentials.
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "    service === 'gmail' ? 'REPO_HARNESS_GMAIL_REFRESH_TOKEN' : '',",
    "    service === 'gmail' ? 'REPO_HARNESS_GMAIL_REFRESH_TOKEN' : '',\n    service === 'calendar' ? 'REPO_HARNESS_GOOGLE_CALENDAR_REFRESH_TOKEN' : '',\n    service === 'tasks' ? 'REPO_HARNESS_GOOGLE_TASKS_REFRESH_TOKEN' : '',",
)
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "  return [`REPO_HARNESS_${service.toUpperCase()}_CLIENT_ID`, 'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID', 'REPO_HARNESS_GOOGLE_CLIENT_ID'];",
    "  return [\n    `REPO_HARNESS_${service.toUpperCase()}_CLIENT_ID`,\n    service === 'calendar' ? 'REPO_HARNESS_GOOGLE_CALENDAR_CLIENT_ID' : '',\n    service === 'tasks' ? 'REPO_HARNESS_GOOGLE_TASKS_CLIENT_ID' : '',\n    'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID', 'REPO_HARNESS_GOOGLE_CLIENT_ID',\n  ].filter(Boolean);",
)
replace_once(
    'src/runtime/plugins/google-shared.ts',
    "  return [`REPO_HARNESS_${service.toUpperCase()}_CLIENT_SECRET`, 'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET', 'REPO_HARNESS_GOOGLE_CLIENT_SECRET'];",
    "  return [\n    `REPO_HARNESS_${service.toUpperCase()}_CLIENT_SECRET`,\n    service === 'calendar' ? 'REPO_HARNESS_GOOGLE_CALENDAR_CLIENT_SECRET' : '',\n    service === 'tasks' ? 'REPO_HARNESS_GOOGLE_TASKS_CLIENT_SECRET' : '',\n    'REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET', 'REPO_HARNESS_GOOGLE_CLIENT_SECRET',\n  ].filter(Boolean);",
)

# Gmail cursor continuation prevents page-cap starvation and cursor advancement before a full drain.
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "  historyId?: string;\n  processedMessageIds: string[];",
    "  historyId?: string;\n  continuation?: { mode: 'history' | 'query'; pageToken: string };\n  processedMessageIds: string[];",
)
path = Path('src/runtime/assistant/routine-runtime.ts')
text = path.read_text()
start = text.index("    const profile = await gmailAction(")
end = text.index("    const messages: GmailMessageSummary[] = [];", start)
collection = """    const profile = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:profile`, 'get_profile', {});
    const known = new Set(cursor.processedMessageIds);
    const messageIds: string[] = [];
    const startingContinuation = cursor.continuation;
    let nextContinuation: GmailRoutineCursor['continuation'];
    let historyFallback = !cursor.historyId;
    let historyInvalid = false;
    if (cursor.historyId) {
      try {
        let historyPageToken = startingContinuation?.mode === 'history' ? startingContinuation.pageToken : undefined;
        for (let page = 0; page < 5 && messageIds.length < 100; page += 1) {
          const history = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:history:${page}`, 'list_history', {
            start_history_id: cursor.historyId, max_results: 100, label_id: 'INBOX', history_type: 'messageAdded',
            ...(historyPageToken ? { page_token: historyPageToken } : {}),
          });
          for (const entry of Array.isArray(history.history) ? history.history.map(recordValue) : []) {
            for (const added of Array.isArray(entry.messagesAdded) ? entry.messagesAdded.map(recordValue) : []) {
              const id = stringValue(recordValue(added.message).id);
              if (id && !known.has(id) && !messageIds.includes(id)) messageIds.push(id);
            }
          }
          historyPageToken = stringValue(history.nextPageToken);
          if (!historyPageToken) break;
        }
        if (historyPageToken) nextContinuation = { mode: 'history', pageToken: historyPageToken };
      } catch (error) {
        const status = isAssistantPluginError(error) ? Number(error.details?.status) : undefined;
        if (status !== 404) throw error;
        historyFallback = true;
        historyInvalid = true;
        nextContinuation = undefined;
      }
    }
    if (historyFallback) {
      const overlapStart = Math.max(0, Date.parse(windowStart) - 5 * 60_000);
      const query = `in:inbox -in:spam -in:trash after:${Math.floor(overlapStart / 1000)}`;
      let pageToken = startingContinuation?.mode === 'query' ? startingContinuation.pageToken : undefined;
      for (let page = 0; page < 5 && messageIds.length < 100; page += 1) {
        const listed = await gmailAction(input.controllerHome, input.repository, input.origin, `${input.requestId}:list:${page}`, 'list_messages', {
          query, max_results: 25, ...(pageToken ? { page_token: pageToken } : {}),
        });
        for (const message of Array.isArray(listed.messages) ? listed.messages.map(recordValue) : []) {
          const id = stringValue(message.id);
          if (id && !known.has(id) && !messageIds.includes(id)) messageIds.push(id);
        }
        pageToken = stringValue(listed.nextPageToken);
        if (!pageToken) break;
      }
      nextContinuation = pageToken ? { mode: 'query', pageToken } : undefined;
    }
"""
path.write_text(text[:start] + collection + text[end:])
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    const truncated = messageIds.length > messages.length;",
    "    const hydrationTruncated = messageIds.length > messages.length;\n    const paginationIncomplete = Boolean(nextContinuation);\n    const truncated = hydrationTruncated || paginationIncomplete;\n    const savedContinuation = truncated\n      ? hydrationTruncated ? startingContinuation : nextContinuation\n      : undefined;",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "      historyId: truncated ? cursor.historyId : stringValue(profile.historyId) ?? cursor.historyId,\n      processedMessageIds:",
    "      historyId: truncated ? historyInvalid ? undefined : cursor.historyId : stringValue(profile.historyId) ?? cursor.historyId,\n      continuation: savedContinuation,\n      processedMessageIds:",
)

# Preserve the true approval surface in audit/job origin.
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "  input: { proposalId: string; requestId: string; confirmationText?: string },",
    "  input: { proposalId: string; requestId: string; confirmationText?: string; origin?: { surface: 'mcp' | 'local-ui'; actor: string } },",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "      origin: { surface: 'local-ui', actor: 'assistant-action-approval', correlationId: proposal.proposalId },",
    "      origin: {\n        surface: input.origin?.surface ?? 'local-ui',\n        actor: input.origin?.actor ?? 'assistant-action-approval',\n        correlationId: proposal.proposalId,\n      },",
)
replace_once(
    'src/cli/local-bridge/server.ts',
    "        confirmationText: queryString(request.body?.confirmationText),\n      }) });",
    "        confirmationText: queryString(request.body?.confirmationText),\n        origin: { surface: 'local-ui', actor: 'assistant-proposal-api' },\n      }) });",
)
replace_once(
    'src/runtime/gateway/mcp/runtime-tools.ts',
    "          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,\n        }) });",
    "          confirmationText: typeof args.confirmation_text === 'string' ? args.confirmation_text : undefined,\n          origin: { surface: 'mcp', actor: 'assistant_action_proposal_resolve' },\n        }) });",
)

# Tests: OAuth restrictions and History continuation across the five-page cap.
test = Path('tests/runtime/google-oauth-history-proposals.test.ts')
text = test.read_text()
anchor = "    const prepared = prepareGoogleOAuthLogin(controllerHome, {"
insert = """    expect(() => prepareGoogleOAuthLogin(controllerHome, {
      service: 'gmail', scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      redirectUri: 'https://example.com/oauth/google/callback',
    })).toThrow('NOT_LOCAL');
    expect(() => prepareGoogleOAuthLogin(controllerHome, {
      service: 'gmail', scopes: ['https://www.googleapis.com/auth/drive'],
      redirectUri: 'http://127.0.0.1:8766/oauth/google/callback',
    })).toThrow('SCOPE_NOT_ALLOWED');

"""
if anchor not in text:
    raise SystemExit('OAuth restriction test anchor missing')
text = text.replace(anchor, insert + anchor, 1)
insert_before = "  test('approves proposals idempotently through a separate authorized plugin Job and supports rejection', () => {"
continuation_test = r'''  test('continues Gmail History after the five-page cap without advancing the history cursor early', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-history-pages-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-controller-'));
    tempRoots.push(repoRoot, controllerHome);
    mkdirSync(join(repoRoot, '.repo-harness', 'plugins'), { recursive: true });
    mkdirSync(join(repoRoot, '.repo-harness', 'assistant'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness', 'plugins', 'gmail.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'google-workspace' }));
    process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN = 'valid-token';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: 'me@example.com', historyId: '106' }), { status: 200 });
      if (url.pathname.endsWith('/history')) {
        const token = url.searchParams.get('pageToken');
        const page = token ? Number(token.slice(1)) : 1;
        return new Response(JSON.stringify({
          history: [{ id: String(100 + page), messagesAdded: [{ message: { id: `message-${page}`, threadId: `thread-${page}`, labelIds: ['INBOX'] } }] }],
          historyId: '106',
          ...(page < 6 ? { nextPageToken: `p${page + 1}` } : {}),
        }), { status: 200 });
      }
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? 'unknown');
      return new Response(JSON.stringify({
        id, threadId: `${id}-thread`, snippet: `Message ${id}`, labelIds: ['INBOX'],
        payload: { headers: [{ name: 'From', value: 'sender@example.com' }, { name: 'Subject', value: `Subject ${id}` }], body: {} },
      }), { status: 200 });
    }) as typeof fetch;
    const routine = createAssistantRoutine(repoRoot, {
      name: 'Paged History Routine', naturalLanguageGoal: 'drain history pages', scheduleText: '每天 09:00', timezone: 'UTC',
      dataSources: ['gmail'], output: 'assistant_inbox', allowedActions: ['gmail.list_messages', 'gmail.get_message'],
      forbiddenActions: ['gmail.send_message', 'gmail.trash_message'],
    });
    writeFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), JSON.stringify({
      schemaVersion: 1, updatedAt: new Date().toISOString(), cursors: [{ schemaVersion: 1, routineId: routine.routineId,
        lastSuccessfulAt: new Date(Date.now() - 60_000).toISOString(), historyId: '100', processedMessageIds: [], updatedAt: new Date().toISOString() }],
    }));
    const repository = repo(repoRoot, 'repo_history_pages');
    const first = await executeAssistantRoutineRuntime({ controllerHome, repository, routineId: routine.routineId, requestId: 'pages-1', origin: { surface: 'assistant-routine' } });
    expect(first.messages).toHaveLength(5);
    let cursor = JSON.parse(readFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), 'utf-8')).cursors[0];
    expect(cursor.historyId).toBe('100');
    expect(cursor.continuation).toEqual({ mode: 'history', pageToken: 'p6' });
    const second = await executeAssistantRoutineRuntime({ controllerHome, repository, routineId: routine.routineId, requestId: 'pages-2', origin: { surface: 'assistant-routine' } });
    expect(second.messages).toHaveLength(1);
    cursor = JSON.parse(readFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), 'utf-8')).cursors[0];
    expect(cursor.historyId).toBe('106');
    expect(cursor.continuation).toBeUndefined();
  });

'''
if insert_before not in text:
    raise SystemExit('History continuation test anchor missing')
text = text.replace(insert_before, continuation_test + insert_before, 1)
test.write_text(text)
print('Hardened OAuth, History cursor continuation, and proposal audit origin.')
