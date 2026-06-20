import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getAgentJob } from '../../src/cli/agent-jobs/job-manager';
import { createIssue } from '../../src/cli/controller/issue-store';
import {
  approveAndExecuteLocalBridgeJob,
  executeLocalBridgeJob,
  getLocalBridgeJob,
  listLocalBridgeJobs,
  submitLocalBridgeJob,
} from '../../src/cli/local-bridge/job-store';
import { startLocalBridgeServer, type LocalBridgeServerHandle } from '../../src/cli/local-bridge/server';

const roots: string[] = [];
const servers: LocalBridgeServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-local-bridge-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, '.ai/harness'), { recursive: true });
  writeFileSync(join(root, 'src/example.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'tasks/current.md'), '# Current\n');
  return root;
}

function fakeCodex(): { binRoot: string; restore(): void } {
  const binRoot = mkdtempSync(join(tmpdir(), 'repo-harness-local-bridge-bin-'));
  roots.push(binRoot);
  const originalPath = process.env.PATH;
  const executable = join(binRoot, 'codex');
  writeFileSync(executable, '#!/usr/bin/env bash\necho "local-bridge-codex-ok"\n');
  chmodSync(executable, 0o755);
  process.env.PATH = `${binRoot}:${originalPath ?? ''}`;
  return { binRoot, restore: () => { process.env.PATH = originalPath; } };
}

describe('Local Execution Bridge', () => {
  test('auto-dispatches a low-risk Task through the persistent Run system', async () => {
    const root = repo();
    const codex = fakeCodex();
    try {
      const issue = createIssue(root, {
        title: 'Local bridge task',
        summary: 'Run one local Task.',
        goals: ['Start Codex without a shell command.'],
        acceptanceCriteria: ['The Run succeeds.'],
        tasks: [{
          title: 'Execute',
          objective: 'Run the fake Codex worker.',
          allowedPaths: ['src/**'],
          checks: ['manual'],
          acceptanceCriteria: ['The Run succeeds.'],
          risk: 'low',
          recommendedAgent: 'codex',
        }],
      });
      const submitted = submitLocalBridgeJob(root, {
        action: 'launch-task',
        requestedBy: 'test',
        payload: { issueId: issue.id, taskId: 'T1', agent: 'codex', isolate: true, timeoutMs: 10_000 },
      });
      expect(submitted.status).toBe('approved');
      const dispatched = executeLocalBridgeJob(root, submitted.jobId);
      expect(dispatched.status).toBe('dispatched');
      expect(dispatched.runId).toBeTruthy();
      let run = getAgentJob(root, dispatched.runId as string);
      for (let attempt = 0; attempt < 80 && !['succeeded', 'failed'].includes(run.status); attempt += 1) {
        await Bun.sleep(25);
        run = getAgentJob(root, dispatched.runId as string);
      }
      expect(run.status).toBe('succeeded');
      expect(run.stdoutTail).toContain('local-bridge-codex-ok');
    } finally {
      codex.restore();
    }
  });

  test('keeps high-risk quick sessions in the local approval queue', () => {
    const root = repo();
    const job = submitLocalBridgeJob(root, {
      action: 'quick-agent-session',
      requestedBy: 'chatgpt',
      approval: 'auto',
      payload: {
        title: 'High risk local change',
        objective: 'Inspect a risky project-level change.',
        allowedPaths: ['src/**'],
        checks: ['manual'],
        risk: 'high',
        agent: 'codex',
      },
    });
    expect(job.status).toBe('pending_approval');
    expect(listLocalBridgeJobs(root)[0]?.jobId).toBe(job.jobId);
    expect(() => executeLocalBridgeJob(root, job.jobId)).toThrow('requires local approval');
  });

  test('allows manual-only Jobs only after explicit localhost-style approval', async () => {
    const root = repo();
    const codex = fakeCodex();
    try {
      const job = submitLocalBridgeJob(root, {
        action: 'quick-agent-session',
        approval: 'manual-only',
        requestedBy: 'local-ui',
        payload: {
          title: 'Manual local session',
          objective: 'Run only after explicit local approval.',
          allowedPaths: ['src/**'],
          checks: ['manual'],
          acceptanceCriteria: ['The local Run is dispatched.'],
          risk: 'low',
          agent: 'codex',
          isolate: true,
          timeoutMs: 10_000,
        },
      });
      expect(job.status).toBe('pending_approval');
      expect(() => approveAndExecuteLocalBridgeJob(root, job.jobId)).toThrow('localhost visual controller');
      const dispatched = approveAndExecuteLocalBridgeJob(root, job.jobId, true);
      expect(dispatched.status).toBe('dispatched');
      expect(dispatched.runId).toBeTruthy();
    } finally {
      codex.restore();
    }
  });

  test('serves a token-protected localhost visual control surface', async () => {
    const root = repo();
    const handle = await startLocalBridgeServer({ repoRoot: root, port: 0, openBrowser: false });
    servers.push(handle);
    const health = await fetch(new URL('/health', handle.url)).then((response) => response.json());
    expect(health.status).toBe('ok');
    const denied = await fetch(new URL('/api/snapshot', handle.url));
    expect(denied.status).toBe(403);
    const snapshot = await fetch(new URL('/api/snapshot', handle.url), {
      headers: { 'x-repo-harness-local-token': handle.token },
    }).then((response) => response.json());
    expect(snapshot.repoRoot).toBe(root);
    expect(snapshot.board).toBeDefined();
    expect(snapshot.toolSurface).toBe('controller-local-execution-v2');
    expect(snapshot.timeoutPolicy).toEqual({ defaultTimeoutMs: 3_600_000, maxTimeoutMs: 43_200_000 });
  });
});
