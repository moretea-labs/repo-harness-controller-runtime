import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listWebTargets, previewBrowserDomainAccess, resolveWebTargetUrl, summarizePluginForLowInterception, summarizeJobResultForLowInterception } from '../../src/runtime/safe-tooling';
import { buildModelClientSummary, buildModelControlPlaneSummary, deepSeekControllerManifest, deepSeekFunctionToolManifest, prepareDeepSeekControllerHandoff, prepareDeepSeekControllerRequest, prepareDeepSeekToolCall } from '../../src/runtime/model-clients';
import type { AssistantPluginManifest } from '../../src/runtime/plugins/types';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

function repoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-safe-tools-'));
  mkdirSync(join(root, '.repo-harness/plugins'), { recursive: true });
  writeFileSync(join(root, '.repo-harness/plugins/browser.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    provider: 'playwright',
    allowedDomains: ['www.jd.com', 'search.jd.com'],
  }, null, 2));
  return root;
}

const manifest: AssistantPluginManifest = {
  schemaVersion: 1,
  manifestVersion: 1,
  revision: 1,
  pluginId: 'browser',
  provider: 'local-browser',
  displayName: 'Browser',
  pluginVersion: '1.0.0',
  authority: { strategy: 'derived', duplicateStateAllowed: false, sourceOfTruth: [] },
  enabled: true,
  lifecycle: { state: 'enabled' },
  health: { state: 'ready', checkedAt: new Date(0).toISOString(), ready: true, probed: true, errors: [], warnings: [], details: { allowedDomains: ['www.jd.com'] } },
  permissions: [
    { scope: 'browser.read', mode: 'read', description: 'read', granted: true, required: true },
    { scope: 'browser.interact', mode: 'write', description: 'write', granted: true, required: true },
  ],
  capabilities: [],
  actions: [
    { actionId: 'open_page', title: 'Open page', description: 'open', readOnly: true, risk: 'readonly', confirmation: 'none', defaultTimeoutMs: 1, cancellable: true, idempotent: false, scopes: [], resourceClaims: [], argumentsSchema: { type: 'object', properties: { url: { type: 'string' } } } },
    { actionId: 'click', title: 'Click', description: 'click', readOnly: false, risk: 'remote_write', confirmation: 'authorization', defaultTimeoutMs: 1, cancellable: true, idempotent: false, scopes: [], resourceClaims: [], argumentsSchema: { type: 'object', properties: { selector: { type: 'string' } } } },
  ],
  updatedAt: new Date(0).toISOString(),
};

describe('low-interception safe tool surface', () => {
  test('lists parameterized web targets and rejects arbitrary absolute paths', () => {
    const root = repoRoot();
    const targets = listWebTargets(root);
    expect(targets.map((entry) => entry.targetKey)).toContain('www_jd_com');
    expect(resolveWebTargetUrl(root, 'www_jd_com', '/search', { q: 'milk' })).toBe('https://www.jd.com/search?q=milk');
    expect(() => resolveWebTargetUrl(root, 'www_jd_com', 'https://evil.example/')).toThrow('WEB_TARGET_PATH_ONLY');
  });

  test('previews domain grants without returning raw config', () => {
    const root = repoRoot();
    const preview = previewBrowserDomainAccess(root, 'https://item.jd.com/product/1', 'shopping research');
    expect(preview.normalizedDomain).toBe('item.jd.com');
    expect(preview.safety.arbitraryUrlAccepted).toBe(false);
    expect(preview.safety.sensitiveConfigReturned).toBe(false);
  });

  test('summarizes plugin manifests without raw config schemas', () => {
    const summary = summarizePluginForLowInterception(manifest);
    expect(summary.actionSummary.requiresApproval).toBe(1);
    expect(summary.actions.find((entry) => entry.actionKey === 'browser.click')?.requiresExplicitApproval).toBe(true);
    expect(summary.redaction.configContentReturned).toBe(false);
  });

  test('summarizes browser action results with safe page previews', () => {
    const textJob = {
      jobId: 'EJOB-text', repoId: 'repo_1', type: 'plugin-action', status: 'succeeded',
      payload: { operation: 'plugin_action_execute', arguments: { pluginId: 'browser', actionId: 'get_text' } },
      evidenceIds: ['EVD-text'],
      result: { provider: 'playwright', sessionId: 'browser_abc', url: 'https://appstoreconnect.apple.com/access/integrations/api', text: { text: 'Keys\nIssuer ID\nKey ID', truncated: false, charCount: 22 } },
    } as unknown as ExecutionJob;
    const textSummary = summarizeJobResultForLowInterception(textJob);
    expect(textSummary.resultPreview?.text).toMatchObject({ text: 'Keys\nIssuer ID\nKey ID', truncated: false });

    const screenshotJob = {
      jobId: 'EJOB-shot', repoId: 'repo_1', type: 'plugin-action', status: 'succeeded',
      payload: { operation: 'plugin_action_execute', arguments: { pluginId: 'browser', actionId: 'screenshot' } },
      evidenceIds: ['EVD-shot'],
      result: { provider: 'playwright', screenshot: { url: 'https://appstoreconnect.apple.com/access/integrations/api', title: 'App Store Connect', path: 'redacted-root/.repo-harness/browser/screenshots/shot.png', relativePath: '.repo-harness/browser/screenshots/shot.png', bytes: 123 } },
    } as unknown as ExecutionJob;
    const screenshotSummary = summarizeJobResultForLowInterception(screenshotJob);
    expect(screenshotSummary.resultPreview?.screenshot).toMatchObject({ title: 'App Store Connect', relativePath: '.repo-harness/browser/screenshots/shot.png', bytes: 123 });
    expect(JSON.stringify(screenshotSummary)).not.toContain('redacted-root');
  });

  test('summarizes playwright failure as dependency missing', () => {
    const job = {
      jobId: 'EJOB-1', repoId: 'repo_1', type: 'plugin-action', status: 'failed', payload: { operation: 'plugin_action_execute', arguments: { pluginId: 'browser', actionId: 'open_page' } }, evidenceIds: [], error: { code: 'PLUGIN_ACTION_FAILED', message: "launchPersistentContext: Executable doesn't exist. Please run npx playwright install", retryable: true },
    } as unknown as ExecutionJob;
    const summary = summarizeJobResultForLowInterception(job);
    expect(summary.safeError?.class).toBe('dependency_missing');
    expect(summary.safeError?.suggestedFixes.join(' ')).toContain('playwright install chromium');
  });

  test('provides DeepSeek function-call adapter metadata without executing locally', () => {
    expect(buildModelClientSummary({ DEEPSEEK_API_KEY: 'x' } as NodeJS.ProcessEnv).find((client) => client.clientId === 'deepseek-function-calling')?.configured).toBe(true);
    expect(deepSeekFunctionToolManifest().length).toBeGreaterThan(0);
    const prepared = prepareDeepSeekToolCall('repo_harness_web_target_snapshot', { target_key: 'www_jd_com', path: '/' });
    expect(prepared.accepted).toBe(true);
    expect(prepared.mappedOperation).toBe('web_target_snapshot');
    expect(prepared.safety.executesLocally).toBe(false);
  });

  test('models DeepSeek as a backup primary controller handoff target', () => {
    const summary = buildModelControlPlaneSummary({ DEEPSEEK_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(summary.backupControllers).toContain('deepseek-backup-controller');
    expect(summary.concurrencyPolicy.workspaceWriteRequiresLease).toBe(true);
    const manifest = deepSeekControllerManifest();
    expect(manifest).toMatchObject({ controllerClientId: 'deepseek-backup-controller', policyOwner: 'repo-harness' });
    const handoff = prepareDeepSeekControllerHandoff({ reason: 'chatgpt_platform_blocked', objective: 'Continue safe browser diagnosis.' }, { DEEPSEEK_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(handoff.role).toBe('backup_primary_controller');
    expect(handoff.safety.executesToolsDirectly).toBe(false);
    const request = prepareDeepSeekControllerRequest({ userMessage: 'Check the allowed web targets.', objective: 'Diagnose browser capability.' }, { DEEPSEEK_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(request.configured).toBe(true);
    expect(request.sendsRawRepositoryContent).toBe(false);
    expect(request.request.tools.length).toBeGreaterThan(0);
  });
});
