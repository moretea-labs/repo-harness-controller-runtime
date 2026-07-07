import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { buildGmailTriagePlan, readGmailTriageRules, upsertGmailTriageRule } from '../../src/runtime/personal-assistant/gmail-triage-manager';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-gmail-triage-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-gmail-triage-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  return registerRepository({ path: repoRoot, controllerHome });
}

describe('gmail triage manager', () => {
  it('provides default rules and builds a triage plan without mutating Gmail', () => {
    const repository = fixture();
    const rules = readGmailTriageRules(repository);
    expect(rules.rules.length).toBeGreaterThan(0);

    const plan = buildGmailTriagePlan(repository, {
      items: [
        { id: 'm1', subject: 'A new device logged into your account', from: 'security@example.com', snippet: 'Reset your password if this was not you.' },
        { id: 'm2', subject: 'Weekly newsletter', from: 'marketing@example.com', snippet: 'Premium survey webinar' },
      ],
    });

    expect(plan.summary.total).toBe(2);
    expect(plan.summary.byPriority.P0).toBe(1);
    expect(plan.plugin.ready).toBe(false);
    expect(plan.actionQueue.every((action) => action.executableByPlugin === false)).toBe(true);
  });

  it('persists user triage rules under repo-local assistant configuration', () => {
    const repository = fixture();
    const upserted = upsertGmailTriageRule(repository, {
      id: 'preply-lessons',
      order: 1,
      match: { actor_includes: ['preply'], title_includes: ['lesson'] },
      decision: { category: 'calendar', priority: 'P1', confidence: 0.95 },
    });

    expect(upserted.path).toBe('.repo-harness/assistant/gmail-triage-rules.json');
    expect(readGmailTriageRules(repository).rules[0].id).toBe('preply-lessons');
  });
});
