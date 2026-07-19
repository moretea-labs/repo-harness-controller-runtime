import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  approveAssistantActionProposal,
  createAssistantActionProposals,
  listAssistantActionProposals,
  rejectAssistantActionProposal,
} from '../../src/runtime/assistant/action-proposals';
import { executeAssistantRoutineRuntime } from '../../src/runtime/assistant/routine-runtime';
import { createAssistantRoutine } from '../../src/runtime/assistant/store';
import { clearGoogleAuthCachesForTest } from '../../src/runtime/plugins/google-shared';
import { completeGoogleOAuthLogin, prepareGoogleOAuthLogin } from '../../src/runtime/safe-tooling/google-oauth-broker';
import {
  setGoogleCredentialStoreAdapterForTest,
  type GoogleCredentialStoreAdapter,
  type StoredGoogleService,
} from '../../src/runtime/safe-tooling/google-credential-store';

const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];
const envKeys = [
  'REPO_HARNESS_GOOGLE_CLIENT_ID',
  'REPO_HARNESS_GOOGLE_CLIENT_SECRET',
  'REPO_HARNESS_GMAIL_ACCESS_TOKEN',
];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) delete process.env[key];
  setGoogleCredentialStoreAdapterForTest();
  clearGoogleAuthCachesForTest();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(root: string, id = 'repo_assistant_test') {
  return { repoId: id, canonicalRoot: root, activeCheckoutId: 'checkout_test' } as any;
}

describe('Google OAuth, Gmail History, and Assistant proposals', () => {
  test('uses expiring one-time PKCE state and stores refresh credentials outside Controller state', async () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-oauth-'));
    tempRoots.push(controllerHome);
    process.env.REPO_HARNESS_GOOGLE_CLIENT_ID = 'client-id';
    process.env.REPO_HARNESS_GOOGLE_CLIENT_SECRET = 'client-secret';
    const stored = new Map<StoredGoogleService, string>();
    const adapter: GoogleCredentialStoreAdapter = {
      available: () => true,
      read: (service) => stored.get(service),
      write: (service, refreshToken) => { stored.set(service, refreshToken); },
    };
    setGoogleCredentialStoreAdapterForTest(adapter);
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toContain('oauth2.googleapis.com/token');
      return new Response(JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
        scope: 'gmail.readonly gmail.modify',
      }), { status: 200 });
    }) as typeof fetch;

    expect(() => prepareGoogleOAuthLogin(controllerHome, {
      service: 'gmail', scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      redirectUri: 'https://example.com/oauth/google/callback',
    })).toThrow('NOT_LOCAL');
    expect(() => prepareGoogleOAuthLogin(controllerHome, {
      service: 'gmail', scopes: ['https://www.googleapis.com/auth/drive'],
      redirectUri: 'http://127.0.0.1:8766/oauth/google/callback',
    })).toThrow('SCOPE_NOT_ALLOWED');

    const prepared = prepareGoogleOAuthLogin(controllerHome, {
      service: 'gmail',
      scopes: ['gmail.readonly', 'gmail.modify'],
      redirectUri: 'http://127.0.0.1:8766/oauth/google/callback',
    });
    expect(prepared.pkce).toBe(true);
    const authorizationUrl = new URL(String(prepared.authorizationUrl));
    const state = authorizationUrl.searchParams.get('state');
    expect(state).toBeString();
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const completed = await completeGoogleOAuthLogin(controllerHome, { state: state!, code: 'authorization-code' });
    expect(completed.authenticated).toBe(true);
    expect(stored.get('gmail')).toBe('refresh-secret');
    const stateFiles = Array.from(new Bun.Glob('auth/google-oauth/requests/*.json').scanSync({ cwd: controllerHome, absolute: true }));
    expect(stateFiles).toHaveLength(1);
    const stateRecord = readFileSync(stateFiles[0]!, 'utf-8');
    expect(stateRecord).not.toContain('access-secret');
    expect(stateRecord).not.toContain('refresh-secret');
    await expect(completeGoogleOAuthLogin(controllerHome, { state: state!, code: 'replay' })).rejects.toThrow('REPLAYED');
  });

  test('uses Gmail History as the primary incremental source and persists structured proposals', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-history-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-controller-'));
    tempRoots.push(repoRoot, controllerHome);
    mkdirSync(join(repoRoot, '.repo-harness', 'plugins'), { recursive: true });
    mkdirSync(join(repoRoot, '.repo-harness', 'assistant'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness', 'plugins', 'gmail.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'google-workspace' }));
    process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN = 'valid-token';
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith('/profile')) {
        return new Response(JSON.stringify({ emailAddress: 'me@example.com', historyId: '101' }), { status: 200 });
      }
      if (url.pathname.endsWith('/history')) {
        expect(url.searchParams.get('startHistoryId')).toBe('100');
        return new Response(JSON.stringify({
          historyId: '101',
          history: [{ id: '101', messagesAdded: [{ message: { id: 'message-1', threadId: 'thread-1', labelIds: ['INBOX'] } }] }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith('/messages/message-1')) {
        return new Response(JSON.stringify({
          id: 'message-1', threadId: 'thread-1', snippet: 'Weekly newsletter', labelIds: ['INBOX'],
          payload: { headers: [{ name: 'From', value: 'news@example.com' }, { name: 'Subject', value: 'Weekly newsletter' }], body: {} },
        }), { status: 200 });
      }
      throw new Error(`Unexpected Gmail request: ${url}`);
    }) as typeof fetch;
    const routine = createAssistantRoutine(repoRoot, {
      name: 'History Routine', naturalLanguageGoal: 'read incremental mail', scheduleText: '每天 09:00', timezone: 'UTC',
      dataSources: ['gmail'], output: 'assistant_inbox', allowedActions: ['gmail.list_messages', 'gmail.get_message'],
      forbiddenActions: ['gmail.send_message', 'gmail.trash_message'],
    });
    writeFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), JSON.stringify({
      schemaVersion: 1, updatedAt: new Date().toISOString(), cursors: [{
        schemaVersion: 1, routineId: routine.routineId, lastSuccessfulAt: new Date(Date.now() - 60_000).toISOString(),
        historyId: '100', processedMessageIds: [], updatedAt: new Date().toISOString(),
      }],
    }));

    const result = await executeAssistantRoutineRuntime({
      controllerHome, repository: repo(repoRoot, 'repo_history'), routineId: routine.routineId,
      requestId: 'history-run', origin: { surface: 'assistant-routine' },
    });
    expect(result.messages).toHaveLength(1);
    expect(calls.some((path) => path.endsWith('/history'))).toBe(true);
    expect(calls.some((path) => path.endsWith('/messages'))).toBe(false);
    const cursor = JSON.parse(readFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), 'utf-8')).cursors[0];
    expect(cursor.historyId).toBe('101');
    const proposals = listAssistantActionProposals(controllerHome, repo(repoRoot, 'repo_history')).proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.actionId).toBe('archive_message');
    expect(proposals[0]?.evidenceMessageIds).toEqual(['message-1']);
  });

  test('continues Gmail History after the five-page cap without advancing the history cursor early', async () => {
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

  test('approves proposals idempotently through a separate authorized plugin Job and supports rejection', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-proposals-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-controller-'));
    tempRoots.push(repoRoot, controllerHome);
    mkdirSync(join(repoRoot, '.repo-harness', 'plugins'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness', 'plugins', 'gmail.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'mock' }));
    const repository = repo(repoRoot, 'repo_proposals');
    const created = createAssistantActionProposals(controllerHome, repository, {
      routineId: 'routine-1', runId: 'run-1', proposals: [
        { pluginId: 'gmail', actionId: 'archive_message', arguments: { message_id: 'message-1' }, evidenceMessageIds: ['message-1'], reason: 'Archive newsletter', confidence: 0.9 },
        { pluginId: 'gmail', actionId: 'archive_message', arguments: { message_id: 'message-2' }, evidenceMessageIds: ['message-2'], reason: 'Archive digest', confidence: 0.8 },
      ],
    });
    const approved = approveAssistantActionProposal(controllerHome, repository, {
      proposalId: created[0]!.proposalId,
      requestId: 'proposal-approval-1',
    });
    const repeated = approveAssistantActionProposal(controllerHome, repository, {
      proposalId: created[0]!.proposalId,
      requestId: 'proposal-approval-1',
    });
    expect(approved.executionJobId).toBeString();
    expect(repeated.executionJobId).toBe(approved.executionJobId);
    const rejected = rejectAssistantActionProposal(controllerHome, repository, created[1]!.proposalId, 'Not useful');
    expect(rejected.status).toBe('rejected');
    expect(listAssistantActionProposals(controllerHome, repository).proposals).toHaveLength(2);
  });
});
