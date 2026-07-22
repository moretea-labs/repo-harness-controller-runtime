import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  RESPONSE_BUDGET,
  compactCommandOutput,
  compactErrorMessage,
  compactRepositoryRef,
  compactRuntimeStorageRef,
  artifactRef,
  evidenceRef,
} from '../../src/runtime/shared/response-budget';
import {
  withIdempotentRetry,
  classifyTransportFailure,
} from '../../src/runtime/shared/idempotent-retry';
import { boundExecutionResult, readExecutionArtifact } from '../../src/runtime/evidence/artifact-store';
import { summarizeExecutionJobForMcp } from '../../src/runtime/safe-tooling/job-summary';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';
import { claimsForCheck } from '../../src/runtime/execution/process-runtime/resource-claims';
import { checkRequiresDurableWorkflow, isSelfHostingNestedCheck } from '../../src/runtime/execution/process-runtime/check-facade';
import { controllerCheckConcurrencyClass } from '../../src/cli/controller/check-runner';
import { classifyRepositoryCommandRoute } from '../../src/runtime/execution/process-runtime/command-facade';

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function measure<T>(fn: () => T, runs = 3): { samples: number[]; avg: number; max: number; last: T } {
  const samples: number[] = [];
  let last!: T;
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    last = fn();
    samples.push(performance.now() - start);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const max = Math.max(...samples);
  return { samples, avg, max, last };
}

describe('response budget + performance baselines', () => {
  test('compact helpers stay within budgets and strip recursive JSON errors', () => {
    const huge = JSON.stringify({
      jobId: 'EJOB-1',
      repository: { canonicalRoot: '/tmp/x', runtimeStorage: { bindings: Array.from({ length: 50 }, (_, i) => ({ i })) } },
      structuredContent: { nested: 'y'.repeat(5000) },
    });
    const message = compactErrorMessage(new Error(huge));
    expect(message.length).toBeLessThan(RESPONSE_BUDGET.errorMessageChars + 20);
    expect(message).not.toContain('structuredContent');
    expect(message).toContain('jsonBytes=');

    const output = compactCommandOutput('ok\n', '', { ok: true });
    expect(output.stdout).toBe('ok\n');
    expect(output.externalized).toBe(false);

    const largeOut = compactCommandOutput('x'.repeat(RESPONSE_BUDGET.inlineOutputBytes + 4000), undefined, { ok: true });
    expect(largeOut.stdoutTruncated).toBe(true);
    expect(largeOut.stdoutBytes).toBeGreaterThan(RESPONSE_BUDGET.inlineOutputBytes);

    const repo = compactRepositoryRef({ repoId: 'r1', checkoutId: 'c1', displayName: 'Demo', defaultBranch: 'main' });
    expect(repo).toEqual({ repoId: 'r1', checkoutId: 'c1', displayName: 'Demo', defaultBranch: 'main' });
    expect(Object.keys(repo)).not.toContain('localRoot');

    const storage = compactRuntimeStorageRef({
      readyForExecution: true,
      usesStableRoot: true,
      warnings: ['a', 'b', 'c', 'd'],
    });
    expect(storage.warningCount).toBe(3);
    expect((storage.warnings as string[]).length).toBe(3);
  });

  test('evidenceId and artifactId are clearly distinguished', () => {
    const art = artifactRef({ artifactId: 'ART-1', repoId: 'repo_1', jobId: 'EJOB-1', byteLength: 12 });
    const evd = evidenceRef({ evidenceId: 'EVD-1', repoId: 'repo_1', jobId: 'EJOB-1' });
    expect(art.referenceType).toBe('artifact');
    expect(art.artifactId).toBe('ART-1');
    expect(String(art.next)).toContain('artifact_id=ART-1');
    expect(evd.referenceType).toBe('evidence');
    expect(evd.evidenceId).toBe('EVD-1');
    expect(String(evd.note)).toContain('not an artifactId');
    expect(String(evd.next)).toContain('ART-');
  });

  test('job-error externalizes without dumping stdout into default result', () => {
    const controllerHome = mkdtempSync(join(tmpdir(), 'resp-budget-art-'));
    try {
      const job = {
        jobId: 'EJOB-err',
        repoId: 'repo_budget',
        payload: { maxOutputBytes: 1024 },
      } as unknown as ExecutionJob;
      mkdirSync(join(controllerHome, 'repositories', 'repo_budget', 'artifacts', 'data'), { recursive: true });
      mkdirSync(join(controllerHome, 'repositories', 'repo_budget', 'artifacts', 'records'), { recursive: true });
      const bounded = boundExecutionResult(controllerHome, job, {
        stdout: `stdout-payload-${'x'.repeat(2000)}`,
        stderr: 'boom',
        repository: { runtimeStorage: { huge: true } },
      }, 'job-error');
      expect(bounded.artifact?.artifactId.startsWith('ART-')).toBe(true);
      expect(bounded.result.referenceType).toBe('artifact');
      expect(JSON.stringify(bounded.result)).not.toContain('stdout-payload');
      expect(JSON.stringify(bounded.result)).not.toContain('runtimeStorage');
      const loaded = readExecutionArtifact(controllerHome, 'repo_budget', String(bounded.artifact?.artifactId));
      expect(JSON.stringify(loaded.content)).toContain('stdout-payload');
    } finally {
      rmSync(controllerHome, { recursive: true, force: true });
    }
  });

  test('default job summary stays compact and separates evidence vs artifact', () => {
    const job = {
      jobId: 'EJOB-ok',
      repoId: 'repo_1',
      checkoutId: 'chk',
      type: 'repository-command',
      status: 'succeeded',
      priority: 'P1',
      requestId: 'req',
      semanticKey: 'sk',
      payload: { operation: 'repository_command_execute', target: 'runtime', timeoutMs: 1000 },
      origin: { surface: 'mcp' },
      resourceClaims: [{ resourceKey: 'workspace:chk', mode: 'read' }],
      dependencies: [],
      leaseRefs: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      queuedAt: new Date(0).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      evidenceIds: ['EVD-1', 'EVD-2'],
      result: {
        externalized: true,
        artifactId: 'ART-abc',
        artifactKind: 'job-result',
        byteLength: 99,
        next: 'Call get_artifact',
      },
    } as unknown as ExecutionJob;

    const measured = measure(() => summarizeExecutionJobForMcp(job, '/tmp/repo'), 3);
    const summary = measured.last;
    const size = bytes(summary);
    expect(size).toBeLessThan(RESPONSE_BUDGET.successBytes);
    expect(summary.evidenceIds).toEqual(['EVD-1', 'EVD-2']);
    expect(Array.isArray(summary.evidenceRefs)).toBe(true);
    expect(Array.isArray(summary.artifactRefs)).toBe(true);
    expect(JSON.stringify(summary.artifactRefs)).toContain('ART-abc');
    expect(JSON.stringify(summary.evidenceRefs)).toContain('EVD-1');
    expect(summary).not.toHaveProperty('origin');
    expect(summary).not.toHaveProperty('semanticKey');
    // Soft timing budget — machines vary; 3 samples should finish quickly for pure summarization.
    expect(measured.max).toBeLessThan(500);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      test: 'job_summary_compact',
      avgMs: Number(measured.avg.toFixed(3)),
      maxMs: Number(measured.max.toFixed(3)),
      responseBytes: size,
      durableJob: false,
      artifact: true,
    }));
  });

  test('error message never embeds full serialized job JSON', () => {
    const dump = JSON.stringify({
      jobId: 'EJOB-1',
      structuredContent: { repository: { a: 1 }, runtimeStorage: { bindings: [1, 2, 3] } },
      result: { stdout: 'x'.repeat(5000) },
    });
    const job = {
      jobId: 'EJOB-fail',
      repoId: 'repo_1',
      type: 'repository-command',
      status: 'failed',
      payload: { operation: 'repository_command_execute' },
      origin: { surface: 'mcp' },
      resourceClaims: [],
      dependencies: [],
      leaseRefs: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      queuedAt: new Date(0).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      evidenceIds: [],
      error: { code: 'COMMAND_FAILED', message: dump, retryable: false },
    } as unknown as ExecutionJob;
    const summary = summarizeExecutionJobForMcp(job);
    expect(String(summary.errorMessage).length).toBeLessThan(900);
    expect(JSON.stringify(summary)).not.toContain('structuredContent');
    expect(bytes(summary)).toBeLessThan(RESPONSE_BUDGET.failureBytes);
  });

  test('readonly commands classify as process_direct (no durable job)', () => {
    const route = classifyRepositoryCommandRoute(['git', 'status'], {});
    expect(route.route).toBe('process_direct');
    const rg = classifyRepositoryCommandRoute(['rg', '-n', 'export function Foo', 'src'], {});
    expect(['process_direct', 'process_managed']).toContain(rg.route);
    expect(rg.route).not.toBe('durable');
  });

  test('controller-v8 is self-hosting and does not take exclusive heavy-check claims', () => {
    expect(isSelfHostingNestedCheck('package:check:controller-v8')).toBe(true);
    expect(checkRequiresDurableWorkflow('package:check:controller-v8')).toBe(false);
    expect(controllerCheckConcurrencyClass('package:check:controller-v8')).toBe('light');
    const claims = claimsForCheck('package:check:controller-v8', undefined, 'repo_1', 'chk');
    expect(claims.some((c) => c.resourceKey.startsWith('heavy-check:'))).toBe(false);
    expect(claimsForCheck('check:ci', undefined, 'repo_1').some((c) => c.resourceKey.startsWith('heavy-check:'))).toBe(true);
  });

  test('idempotent transport retries 502 then succeeds; mutations do not retry', async () => {
    let attempts = 0;
    const value = await withIdempotentRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('HTTP_502: Bad Gateway');
        throw err;
      }
      return 'ok';
    }, {
      idempotent: true,
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      sleep: async () => undefined,
    });
    expect(value).toBe('ok');
    expect(attempts).toBe(3);

    let mutations = 0;
    await expect(withIdempotentRetry(async () => {
      mutations += 1;
      throw new Error('HTTP_502: Bad Gateway');
    }, {
      idempotent: false,
      maxAttempts: 3,
      baseDelayMs: 1,
      sleep: async () => undefined,
    })).rejects.toThrow(/502/);
    expect(mutations).toBe(1);

    const classification = classifyTransportFailure(new Error('bad gateway'), 502);
    expect(classification.retryable).toBe(true);
    expect(classification.code).toBe('GATEWAY_BAD_GATEWAY');
  });

  test('performance table: compact helpers (3 runs)', () => {
    const rows: Array<Record<string, unknown>> = [];
    const cases: Array<{ name: string; fn: () => unknown; durableJob: boolean; artifact: boolean }> = [
      {
        name: 'compact_stdout_small',
        fn: () => compactCommandOutput('type Foo\n', '', { ok: true }),
        durableJob: false,
        artifact: false,
      },
      {
        name: 'compact_error_message',
        fn: () => compactErrorMessage(new Error('plain failure')),
        durableJob: false,
        artifact: false,
      },
      {
        name: 'artifact_ref',
        fn: () => artifactRef({ artifactId: 'ART-1', repoId: 'r', jobId: 'j' }),
        durableJob: false,
        artifact: true,
      },
    ];
    for (const entry of cases) {
      const measured = measure(entry.fn, 3);
      const size = bytes(measured.last);
      rows.push({
        test: entry.name,
        avgMs: Number(measured.avg.toFixed(3)),
        maxMs: Number(measured.max.toFixed(3)),
        responseBytes: size,
        durableJob: entry.durableJob,
        artifact: entry.artifact,
      });
      expect(size).toBeLessThan(RESPONSE_BUDGET.successBytes);
      expect(measured.max).toBeLessThan(200);
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ performanceBaselines: rows }, null, 2));
  });
});

void writeFileSync;
void spawnSync;
