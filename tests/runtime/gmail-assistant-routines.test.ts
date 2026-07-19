import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseAssistantScheduleText } from '../../src/runtime/assistant/schedule-binding';
import { executeAssistantRoutineRuntime } from '../../src/runtime/assistant/routine-runtime';
import { createAssistantRoutine, listAssistantInbox } from '../../src/runtime/assistant/store';
import { cronDue } from '../../src/runtime/workflow/schedules/engine';
import {
  clearGoogleAuthCachesForTest,
  googleApiRequest,
  resolveGoogleAuth,
  type GmailPluginConfig,
} from '../../src/runtime/plugins/google-shared';

const originalFetch = globalThis.fetch;
const envKeys = [
  'REPO_HARNESS_GMAIL_ACCESS_TOKEN',
  'REPO_HARNESS_GMAIL_REFRESH_TOKEN',
  'REPO_HARNESS_GMAIL_CLIENT_ID',
  'REPO_HARNESS_GMAIL_CLIENT_SECRET',
];
const tempRoots: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) delete process.env[key];
  clearGoogleAuthCachesForTest();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Gmail assistant routines', () => {
  test('normalizes a daily local-time routine and honors DST-aware cron plus catch-up', () => {
    const parsed = parseAssistantScheduleText('每天 09:00 整理 Gmail', 'America/Los_Angeles');
    expect(parsed.trigger.cronExpression).toBe('0 9 * * *');
    expect(parsed.trigger.timezone).toBe('America/Los_Angeles');
    expect(cronDue('0 9 * * *', Date.parse('2026-07-19T16:00:00Z'), 'America/Los_Angeles', 0)).toBe(true);
    expect(cronDue('0 9 * * *', Date.parse('2026-07-19T16:30:00Z'), 'America/Los_Angeles', 60)).toBe(true);
    expect(cronDue('0 9 * * *', Date.parse('2026-07-19T17:30:00Z'), 'America/Los_Angeles', 60)).toBe(false);
  });

  test('refreshes an expired Google access token once and marks the provider verified', async () => {
    process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN = 'expired-token';
    process.env.REPO_HARNESS_GMAIL_REFRESH_TOKEN = 'refresh-token';
    process.env.REPO_HARNESS_GMAIL_CLIENT_ID = 'client-id';
    process.env.REPO_HARNESS_GMAIL_CLIENT_SECRET = 'client-secret';
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), { status: 200 });
      }
      if (calls.filter((entry) => entry.includes('gmail.googleapis.com')).length === 1) {
        return new Response(JSON.stringify({ error: { status: 'UNAUTHENTICATED' } }), { status: 401 });
      }
      return new Response(JSON.stringify({ labels: [{ id: 'INBOX' }] }), { status: 200 });
    }) as typeof fetch;

    const configured: GmailPluginConfig = { schemaVersion: 1, enabled: true, provider: 'google-workspace' };
    const beforeProbe = resolveGoogleAuth('gmail', configured);
    expect(beforeProbe.ready).toBe(true);
    expect(beforeProbe.probed).toBe(false);

    const result = await googleApiRequest<{ labels: Array<{ id: string }> }>({
      service: 'gmail',
      path: '/gmail/v1/users/me/labels',
      accessToken: 'expired-token',
      timeoutMs: 5_000,
    });
    expect(result.labels[0]?.id).toBe('INBOX');
    expect(calls).toHaveLength(3);
    const auth = resolveGoogleAuth('gmail', configured);
    expect(auth.ready).toBe(true);
    expect(auth.probed).toBe(true);
    expect(auth.credentialSource).toContain('refresh:');
  });

  test('collects mock Gmail incrementally and writes a final Assistant Inbox report', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-gmail-routine-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-controller-'));
    tempRoots.push(repoRoot, controllerHome);
    mkdirSync(join(repoRoot, '.repo-harness', 'plugins'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness', 'plugins', 'gmail.json'), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      provider: 'mock',
      accountEmail: 'mock@example.com',
    }));
    const routine = createAssistantRoutine(repoRoot, {
      name: '每日邮件整理',
      naturalLanguageGoal: '每天整理重要邮件',
      scheduleText: '每天 09:00',
      timezone: 'Asia/Shanghai',
      dataSources: ['gmail'],
      output: 'assistant_inbox',
      allowedActions: ['gmail.list_messages', 'gmail.get_message'],
      forbiddenActions: ['gmail.send_message', 'gmail.trash_message'],
    });
    const repository = {
      repoId: 'repo_test_gmail',
      canonicalRoot: repoRoot,
      activeCheckoutId: 'checkout_test',
    } as any;
    const result = await executeAssistantRoutineRuntime({
      controllerHome,
      repository,
      routineId: routine.routineId,
      requestId: 'test-routine-run',
      origin: { surface: 'assistant-routine', actor: routine.routineId },
    });
    expect(result.run.status).toBe('completed');
    expect(result.messages).toHaveLength(1);
    const inbox = listAssistantInbox(repoRoot).items;
    expect(inbox.some((item) => item.title.includes('Routine 已完成'))).toBe(true);
    const cursor = JSON.parse(readFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), 'utf-8'));
    expect(cursor.cursors[0].lastSuccessfulAt).toBeString();
    expect(cursor.cursors[0].processedMessageIds.length).toBe(1);
  });
});
