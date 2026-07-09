import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { buildGmailPluginManifest, executeGmailPluginAction } from '../../src/runtime/plugins/gmail-adapter';
import { buildGoogleCalendarPluginManifest } from '../../src/runtime/plugins/google-calendar-adapter';
import { buildGoogleTasksPluginManifest } from '../../src/runtime/plugins/google-tasks-adapter';
import { submitAssistantPluginAction } from '../../src/runtime/plugins/store';
import { executeExecutionJob } from '../../src/runtime/execution/workers/executor';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
  delete process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN;
  delete process.env.REPO_HARNESS_GOOGLE_ACCESS_TOKEN;
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-gmail-ready-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-gmail-ready-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  mkdirSync(join(repoRoot, '.repo-harness/plugins'), { recursive: true });
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), '# t\n');
  const repository = registerRepository({ path: repoRoot, controllerHome });
  return { repoRoot, controllerHome, repository };
}

describe('gmail plugin readiness and gates', () => {
  test('mock mode reports ready and executes all core actions', async () => {
    const { repoRoot, controllerHome, repository } = fixture();
    await executeGmailPluginAction({
      controllerHome, repoId: repository.repoId, repoRoot, pluginId: 'gmail', actionId: 'configure', requestId: 'c1',
      args: { enabled: true, provider: 'mock', account_email: 'assistant@example.com' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    const manifest = buildGmailPluginManifest(0, undefined, repoRoot);
    expect(manifest.health.ready).toBe(true);
    expect(manifest.health.details).toMatchObject({ readinessMode: 'mock_provider_ready', userFacingStatus: 'mock ready' });
    expect(manifest.health.state).toBe('ready');

    for (const [actionId, args] of [
      ['list_messages', {}],
      ['get_message', { message_id: 'm1' }],
      ['list_labels', {}],
      ['create_draft', { to: ['a@example.com'], subject: 's', body_text: 'b' }],
      ['modify_message_labels', { message_id: 'm1', add_label_ids: ['STARRED'] }],
      ['archive_message', { message_id: 'm1' }],
      ['mark_message_read', { message_id: 'm1' }],
      ['mark_message_unread', { message_id: 'm1' }],
    ] as const) {
      const submitted = submitAssistantPluginAction(controllerHome, repository, {
        pluginId: 'gmail',
        actionId,
        requestId: `gmail-${actionId}`,
        args: args as Record<string, unknown>,
        confirmAuthorization: true,
        origin: { surface: 'local-ui', actor: 'test' },
      });
      const execution = await executeExecutionJob(controllerHome, submitted.job);
      expect(execution.ok).toBe(true);
    }

    const send = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'gmail',
      actionId: 'send_message',
      requestId: 'gmail-send',
      args: { to: ['a@example.com'], subject: 's', body_text: 'b' },
      confirmAuthorization: true,
      confirmationText: 'send-gmail-message',
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((await executeExecutionJob(controllerHome, send.job)).ok).toBe(true);

    const trash = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'gmail',
      actionId: 'trash_message',
      requestId: 'gmail-trash',
      args: { message_id: 'm1' },
      confirmAuthorization: true,
      confirmationText: 'trash-gmail-message',
      origin: { surface: 'local-ui', actor: 'test' },
    });
    expect((await executeExecutionJob(controllerHome, trash.job)).ok).toBe(true);
  });

  test('live mode without token is not generically failed and returns structured auth_required', async () => {
    const { repoRoot, controllerHome, repository } = fixture();
    await executeGmailPluginAction({
      controllerHome, repoId: repository.repoId, repoRoot, pluginId: 'gmail', actionId: 'configure', requestId: 'c2',
      args: { enabled: true, provider: 'google-workspace' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    const manifest = buildGmailPluginManifest(0, undefined, repoRoot);
    expect(manifest.health.ready).toBe(false);
    expect(manifest.health.state).toBe('degraded');
    expect(manifest.health.details).toMatchObject({
      readinessMode: 'missing_token',
      userFacingStatus: 'live token missing',
    });
    expect(manifest.health.errors).toEqual([]);
    expect(manifest.health.warnings.some((entry) => /ACCESS_TOKEN/i.test(entry))).toBe(true);

    const submitted = submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'gmail',
      actionId: 'list_messages',
      requestId: 'gmail-auth-required',
      args: {},
      origin: { surface: 'local-ui', actor: 'test' },
    });
    const execution = await executeExecutionJob(controllerHome, submitted.job);
    expect(execution.ok).toBe(false);
    expect(execution.error?.code).toBe('PLUGIN_AUTH_REQUIRED');
  });

  test('send and trash require strong confirmation text', async () => {
    const { repoRoot, controllerHome, repository } = fixture();
    await executeGmailPluginAction({
      controllerHome, repoId: repository.repoId, repoRoot, pluginId: 'gmail', actionId: 'configure', requestId: 'c3',
      args: { enabled: true, provider: 'mock' },
      origin: { surface: 'local-ui', actor: 'test' },
    });

    expect(() => submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'gmail',
      actionId: 'send_message',
      requestId: 'send-bad',
      args: { to: ['a@example.com'], subject: 's', body_text: 'b' },
      confirmAuthorization: true,
      origin: { surface: 'local-ui', actor: 'test' },
    })).toThrow('PLUGIN_CONFIRMATION_TEXT_REQUIRED');

    expect(() => submitAssistantPluginAction(controllerHome, repository, {
      pluginId: 'gmail',
      actionId: 'trash_message',
      requestId: 'trash-bad',
      args: { message_id: 'm1' },
      confirmAuthorization: true,
      confirmationText: 'nope',
      origin: { surface: 'local-ui', actor: 'test' },
    })).toThrow('PLUGIN_CONFIRMATION_TEXT_REQUIRED');
  });

  test('calendar and tasks mock mode are usable when enabled', async () => {
    const { repoRoot } = fixture();
    writeFileSync(join(repoRoot, '.repo-harness/plugins/google-calendar.json'), JSON.stringify({
      schemaVersion: 1, enabled: true, provider: 'mock', calendarId: 'primary',
    }));
    writeFileSync(join(repoRoot, '.repo-harness/plugins/google-tasks.json'), JSON.stringify({
      schemaVersion: 1, enabled: true, provider: 'mock', taskListId: '@default',
    }));
    const calendar = buildGoogleCalendarPluginManifest(0, undefined, repoRoot);
    const tasks = buildGoogleTasksPluginManifest(0, undefined, repoRoot);
    expect(calendar.health.ready).toBe(true);
    expect(calendar.health.details).toMatchObject({ readinessMode: 'mock_provider_ready' });
    expect(tasks.health.ready).toBe(true);
    expect(tasks.health.details).toMatchObject({ readinessMode: 'mock_provider_ready' });
  });
});
