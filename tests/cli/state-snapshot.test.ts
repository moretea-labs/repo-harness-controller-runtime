import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import type { StateSnapshot } from '../../src/cli/hook/state-snapshot';

const ROOT = join(import.meta.dir, '../..');
const HOOK_ENTRY = join(ROOT, 'src/cli/hook-entry.ts');

function withTempRepo(fn: (cwd: string) => void): void {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-state-')));
  try {
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    mkdirSync(join(cwd, 'plans'), { recursive: true });
    mkdirSync(join(cwd, 'tasks/contracts'), { recursive: true });
    mkdirSync(join(cwd, '.ai/harness'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, 'docs/spec.md'), '# Spec\n');
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function planContent(status: 'Draft' | 'Approved' | 'Executing'): string {
  return [
    '# Plan: Snapshot Fixture',
    '',
    `> **Status**: ${status}`,
    '',
    '## Task Breakdown',
    '- [ ] fixture task',
    '',
    '## Evidence Contract',
    '- **State/progress path**: `plans/plan-20260612-0100-snapshot-fixture.md`',
    '- **Verification evidence**: `bun test tests/cli/state-snapshot.test.ts`',
    '- **Evaluator rubric**: review must recommend pass',
    '- **Stop condition**: snapshot fixture passes',
    '- **Rollback surface**: remove fixture files',
    '',
  ].join('\n');
}

function writePlan(
  cwd: string,
  status: 'Draft' | 'Approved' | 'Executing',
): string {
  const planPath = `plans/plan-20260612-0100-${status.toLowerCase()}-fixture.md`;
  writeFileSync(join(cwd, planPath), planContent(status));
  writeFileSync(join(cwd, '.ai/harness/active-plan'), planPath);
  writeFileSync(join(cwd, '.claude/.active-plan'), planPath);
  writeFileSync(join(cwd, '.ai/harness/active-worktree'), `${cwd}\n`);
  return planPath;
}

function writeContract(cwd: string, status: 'Approved' | 'Executing'): string {
  const contractPath = `tasks/contracts/20260612-0100-${status.toLowerCase()}-fixture.contract.md`;
  writeFileSync(join(cwd, contractPath), '# Contract\n');
  return contractPath;
}

function runSnapshot(cwd: string): StateSnapshot {
  const res = spawnSync(process.execPath, [HOOK_ENTRY, 'state-snapshot', '--json'], {
    cwd,
    encoding: 'utf-8',
  });
  expect(res.status).toBe(0);
  expect(res.stderr).toBe('');
  const line = res.stdout.trim();
  expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(1024);
  return JSON.parse(line) as StateSnapshot;
}

describe('state-snapshot hook command', () => {
  test('reports no active plan state', () => {
    withTempRepo((cwd) => {
      expect(runSnapshot(cwd)).toEqual({
        protocol: 1,
        kind: 'repo-harness-state-snapshot',
        states: {
          spec: 'present',
          plan: 'none',
          pending: 'none',
          worktree: 'current',
          contract: 'missing',
          contract_path: 'missing',
          evidence: 'unchecked',
        },
        paths: { active_plan: null, contract: null },
        marker: { problem: 'none' },
      });
    });
  });

  test('reports draft active plan state with derived contract path', () => {
    withTempRepo((cwd) => {
      const planPath = writePlan(cwd, 'Draft');
      expect(runSnapshot(cwd)).toEqual({
        protocol: 1,
        kind: 'repo-harness-state-snapshot',
        states: {
          spec: 'present',
          plan: 'draft',
          pending: 'none',
          worktree: 'current',
          contract: 'missing',
          contract_path: 'present',
          evidence: 'complete',
        },
        paths: {
          active_plan: planPath,
          contract: 'tasks/contracts/20260612-0100-draft-fixture.contract.md',
        },
        marker: { problem: 'none' },
      });
    });
  });

  test('reports approved active plan state with present contract', () => {
    withTempRepo((cwd) => {
      const planPath = writePlan(cwd, 'Approved');
      const contractPath = writeContract(cwd, 'Approved');
      expect(runSnapshot(cwd)).toEqual({
        protocol: 1,
        kind: 'repo-harness-state-snapshot',
        states: {
          spec: 'present',
          plan: 'approved',
          pending: 'none',
          worktree: 'current',
          contract: 'present',
          contract_path: 'present',
          evidence: 'complete',
        },
        paths: { active_plan: planPath, contract: contractPath },
        marker: { problem: 'none' },
      });
    });
  });

  test('reports executing active plan state with present contract', () => {
    withTempRepo((cwd) => {
      const planPath = writePlan(cwd, 'Executing');
      const contractPath = writeContract(cwd, 'Executing');
      expect(runSnapshot(cwd)).toEqual({
        protocol: 1,
        kind: 'repo-harness-state-snapshot',
        states: {
          spec: 'present',
          plan: 'executing',
          pending: 'none',
          worktree: 'current',
          contract: 'present',
          contract_path: 'present',
          evidence: 'complete',
        },
        paths: { active_plan: planPath, contract: contractPath },
        marker: { problem: 'none' },
      });
    });
  });

  test('reports stale active-plan marker without treating it as active execution', () => {
    withTempRepo((cwd) => {
      const missingPlan = 'plans/plan-20260612-0100-missing.md';
      writeFileSync(join(cwd, '.ai/harness/active-plan'), missingPlan);
      writeFileSync(join(cwd, '.claude/.active-plan'), missingPlan);
      expect(runSnapshot(cwd)).toEqual({
        protocol: 1,
        kind: 'repo-harness-state-snapshot',
        states: {
          spec: 'present',
          plan: 'stale_marker',
          pending: 'none',
          worktree: 'current',
          contract: 'missing',
          contract_path: 'missing',
          evidence: 'unchecked',
        },
        paths: { active_plan: missingPlan, contract: null },
        marker: { problem: 'deleted' },
      });
    });
  });

  test('reports active-plan marker owned by another worktree', () => {
    withTempRepo((cwd) => {
      const planPath = writePlan(cwd, 'Approved');
      writeFileSync(join(cwd, '.ai/harness/active-worktree'), '/tmp/other-worktree\n');
      expect(runSnapshot(cwd)).toEqual({
        protocol: 1,
        kind: 'repo-harness-state-snapshot',
        states: {
          spec: 'present',
          plan: 'foreign_worktree',
          pending: 'none',
          worktree: 'foreign_marker',
          contract: 'missing',
          contract_path: 'missing',
          evidence: 'unchecked',
        },
        paths: { active_plan: planPath, contract: null },
        marker: { problem: 'foreign_worktree' },
      });
    });
  });

  test('rejects unknown flags', () => {
    withTempRepo((cwd) => {
      const res = spawnSync(process.execPath, [HOOK_ENTRY, 'state-snapshot', '--yaml'], {
        cwd,
        encoding: 'utf-8',
      });
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('state-snapshot --json');
    });
  });
});
