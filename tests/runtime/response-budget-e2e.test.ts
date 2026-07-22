/**
 * End-to-end response budget tests.
 *
 * Measures full MCP tool responses (text + structuredContent serialization),
 * not intermediate compact helpers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { getMcpPolicy } from '../../src/cli/mcp/policy';
import { callRepositoryTool } from '../../src/cli/mcp/repository-tools';
import type { MultiRepositoryMcpToolContext } from '../../src/cli/mcp/multi-repository';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import {
  writeMcpLocalConfig,
  writeMcpRuntimeState,
  writeMcpServiceLocalConfig,
  writeMcpServiceRuntimeState,
} from '../../src/cli/mcp/auth';
import { callRuntimeTool } from '../../src/runtime/gateway/mcp/runtime-tools';
import { RESPONSE_BUDGET, artifactRef } from '../../src/runtime/shared/response-budget';
import { resolveLocalBridgeSurface, summarizeRecentJobs } from '../../src/runtime/shared/local-bridge-surface';
import { allocateSlotPorts, slotPortDefaults } from '../../src/cli/controller/runtime-slots';
import { summarizeExecutionJobForMcp } from '../../src/runtime/safe-tooling/job-summary';
import type { ExecutionJob } from '../../src/runtime/execution/jobs/types';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function measureBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function measureRuns<T>(fn: () => T | Promise<T>, runs = 3): Promise<{ samples: number[]; avg: number; max: number; last: T }> {
  return (async () => {
    const samples: number[] = [];
    let last!: T;
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      last = await fn();
      samples.push(performance.now() - start);
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const max = Math.max(...samples);
    return { samples, avg, max, last };
  })();
}

function fullToolBytes(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown }): {
  fullBytes: number;
  textBytes: number;
  structuredBytes: number;
  structured: Record<string, unknown>;
  text: string;
} {
  const text = result.content?.[0] && 'text' in (result.content[0] ?? {})
    ? String(result.content[0].text ?? '')
    : '';
  const structured = (result.structuredContent
    ?? (text ? JSON.parse(text) : {})) as Record<string, unknown>;
  // Full MCP tool response shape (what clients serialize).
  const full = {
    content: result.content ?? [{ type: 'text', text }],
    structuredContent: structured,
  };
  return {
    fullBytes: measureBytes(full),
    textBytes: Buffer.byteLength(text, 'utf8'),
    structuredBytes: measureBytes(structured),
    structured,
    text,
  };
}

function hasDuplicateStdout(payload: Record<string, unknown>): boolean {
  const top = typeof payload.stdout === 'string';
  const nested = payload.process && typeof payload.process === 'object'
    && typeof (payload.process as Record<string, unknown>).stdout === 'string';
  return top && nested === true;
}

function gitInit(repoRoot: string): void {
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Budget Test'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'budget@example.com'], { cwd: repoRoot, stdio: 'ignore' });
  writeFileSync(join(repoRoot, 'README.md'), 'budget\n');
  spawnSync('git', ['add', 'README.md'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'resp-budget-e2e-'));
  const controllerHome = join(workspace, 'controller-home');
  const repoRoot = join(workspace, 'repo');
  roots.push(workspace);
  mkdirSync(controllerHome, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  ensureControllerHome(controllerHome);
  gitInit(repoRoot);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'budget-e2e' });
  const policy = getMcpPolicy('controller', { repoRoot });
  const ctx = {
    repoRoot,
    controllerHome,
    policy,
    toolset: 'core' as const,
    enableChatgptBrowser: false,
    explicitRepository: repository,
    audit: () => undefined,
  } as unknown as MultiRepositoryMcpToolContext;
  return { workspace, controllerHome, repoRoot, repository, ctx };
}

describe('E2E response budgets (full MCP tool responses)', () => {
  test('process_direct success: one stdout authority, no durable jobs, under 8KB', async () => {
    const { controllerHome, repository } = fixture();
    const command = "printf 'ok-direct\\n'";
    const preview = JSON.parse((await callRepositoryTool(controllerHome, 'repository_command_preview', {
      repo_id: repository.repoId,
      command,
    }))!.content[0]!.text);

    const measured = await measureRuns(async () => {
      const result = await callRepositoryTool(controllerHome, 'repository_command_execute', {
        repo_id: repository.repoId,
        command,
        approval_token: preview.approvalToken,
        request_id: `budget-pd-ok-${Math.random().toString(16).slice(2)}`,
      });
      return fullToolBytes(result!);
    }, 3);

    const { structured, fullBytes, textBytes, structuredBytes } = measured.last;
    expect(structured.mode === 'process_direct' || structured.route === 'process_direct').toBe(true);
    expect(structured.ok).toBe(true);
    expect(String(structured.stdout)).toContain('ok-direct');
    expect(hasDuplicateStdout(structured)).toBe(false);
    expect(structured.process).toBeUndefined();
    expect(structured.repository).toBeUndefined();
    expect(structured.runtimeStorage).toBeUndefined();
    expect(structured.jobId).toBeUndefined();
    const effects = (structured.durableSideEffects as Record<string, number> | undefined) ?? {};
    expect(effects.executionJobCount ?? 0).toBe(0);
    expect(effects.localJobCount ?? 0).toBe(0);
    expect(fullBytes).toBeLessThan(RESPONSE_BUDGET.processDirectSuccessBytes);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      test: 'process_direct_success_e2e',
      fullBytes,
      textBytes,
      structuredBytes,
      avgMs: Number(measured.avg.toFixed(3)),
      maxMs: Number(measured.max.toFixed(3)),
      executionJobCount: effects.executionJobCount ?? 0,
      localJobCount: effects.localJobCount ?? 0,
      artifact: false,
      duplicateStdout: hasDuplicateStdout(structured),
    }));
  });

  test('process_direct detail restores diagnostics without duplicating stdout', async () => {
    const { controllerHome, repository } = fixture();
    const command = "printf 'detail\\n'";
    const preview = JSON.parse((await callRepositoryTool(controllerHome, 'repository_command_preview', {
      repo_id: repository.repoId,
      command,
    }))!.content[0]!.text);
    const result = await callRepositoryTool(controllerHome, 'repository_command_execute', {
      repo_id: repository.repoId,
      command,
      approval_token: preview.approvalToken,
      request_id: 'budget-pd-detail',
      detail_level: 'detail',
    });
    const { structured, fullBytes } = fullToolBytes(result!);
    expect(structured.detailLevel).toBe('detail');
    expect(String(structured.stdout)).toContain('detail');
    expect(hasDuplicateStdout(structured)).toBe(false);
    expect(structured.routing).toBeTruthy();
    expect(structured.durableSideEffects).toBeTruthy();
    expect(fullBytes).toBeLessThan(RESPONSE_BUDGET.failureBytes);
  });

  test('process_direct failure keeps error code, exitCode, bounded stderr, process ref', async () => {
    const { controllerHome, repository } = fixture();
    const command = 'git rev-parse --verify does-not-exist-budget-ref';
    const preview = JSON.parse((await callRepositoryTool(controllerHome, 'repository_command_preview', {
      repo_id: repository.repoId,
      command,
    }))!.content[0]!.text);
    // Failing allowlisted readonly command still returns compact process_direct failure.
    const result = await callRepositoryTool(controllerHome, 'repository_command_execute', {
      repo_id: repository.repoId,
      command,
      approval_token: preview.approvalToken,
      request_id: 'budget-pd-fail',
    });
    const { structured, fullBytes } = fullToolBytes(result!);
    if (structured.mode === 'process_direct' || structured.route === 'process_direct') {
      expect(structured.ok).toBe(false);
      expect(structured.error).toBeTruthy();
      expect((structured.error as { code?: string }).code).toBeTruthy();
      expect(typeof structured.exitCode === 'number').toBe(true);
      expect(structured.exitCode).not.toBe(0);
      expect(typeof structured.processId === 'string' || structured.processId === undefined).toBe(true);
      expect(hasDuplicateStdout(structured)).toBe(false);
      expect(fullBytes).toBeLessThan(RESPONSE_BUDGET.processDirectFailureBytes);
    }
  });

  test('local_bridge_status summary omits repository/runtimeStorage/bindings; detail retains', async () => {
    const { ctx, repository, controllerHome, repoRoot } = fixture();
    writeMcpServiceRuntimeState(controllerHome, {
      version: 1,
      repo: repoRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      tunnelMode: 'none',
      generation: 'gen-test',
      server: {
        endpoint: 'http://127.0.0.1:8765/',
        running: true,
        healthy: true,
        restartCount: 0,
      },
      localController: {
        endpoint: 'http://127.0.0.1:8776/',
        running: true,
        mode: 'embedded',
        pid: 12345,
        generation: 'gen-test',
      },
    });
    writeMcpServiceLocalConfig(controllerHome, {
      localController: {
        enabled: true,
        mode: 'embedded',
        host: '127.0.0.1',
        port: 8776,
      },
    });

    const summaryMeasured = await measureRuns(async () => {
      const result = await callRuntimeTool(ctx, 'local_bridge_status', {
        repo_id: repository.repoId,
      });
      return fullToolBytes(result!);
    }, 3);
    const summary = summaryMeasured.last.structured;
    expect(summary.detailLevel).toBe('summary');
    expect(summary.mode).toBe('embedded');
    expect(summary.endpoint).toBe('http://127.0.0.1:8776/');
    expect(summary.endpointConfigured).toBe(true);
    expect(summary.requiredForReadiness).toBe(false);
    expect(summary.repository).toBeUndefined();
    expect(summary.runtimeStorage).toBeUndefined();
    expect(summary.bindings).toBeUndefined();
    expect(summary.recentJobs).toBeUndefined();
    expect(summary.recentJobSummary).toBeTruthy();
    expect(summaryMeasured.last.fullBytes).toBeLessThan(RESPONSE_BUDGET.statusSummaryBytes);
    // Historical job failures must not appear as active blockers in summary.
    const warnings = (summary.warnings as Array<{ code?: string }> | undefined) ?? [];
    expect(warnings.some((w) => w.code === 'HISTORICAL_JOB_FAILED')).toBe(false);

    const detailResult = await callRuntimeTool(ctx, 'local_bridge_status', {
      repo_id: repository.repoId,
      detail_level: 'detail',
    });
    const detail = fullToolBytes(detailResult!).structured;
    expect(detail.detailLevel).toBe('detail');
    expect(detail.capability || detail.recentJobs || detail.repository).toBeTruthy();
    expect(detail.runtimeStorage || detail.repository).toBeTruthy();

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      test: 'local_bridge_status_summary_e2e',
      fullBytes: summaryMeasured.last.fullBytes,
      textBytes: summaryMeasured.last.textBytes,
      structuredBytes: summaryMeasured.last.structuredBytes,
      avgMs: Number(summaryMeasured.avg.toFixed(3)),
      maxMs: Number(summaryMeasured.max.toFixed(3)),
      hasRepository: Boolean(summary.repository),
      hasRuntimeStorage: Boolean(summary.runtimeStorage),
      hasBindings: Boolean(summary.bindings),
    }));
  });

  test('embedded mode does not invent legacy 8766; disabled non-required has no misleading warning', () => {
    const { controllerHome, repoRoot } = fixture();
    writeMcpServiceRuntimeState(controllerHome, {
      version: 1,
      repo: repoRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      tunnelMode: 'none',
      server: { endpoint: 'http://127.0.0.1:8765/', running: true, healthy: true, restartCount: 0 },
      localController: {
        endpoint: 'http://127.0.0.1:8776/',
        running: true,
        mode: 'embedded',
      },
    });
    const embedded = resolveLocalBridgeSurface({ controllerHome, repoRoot, allowProcessScan: false });
    expect(embedded.mode).toBe('embedded');
    expect(embedded.endpoint).toBe('http://127.0.0.1:8776/');
    expect(embedded.requiredForReadiness).toBe(false);
    expect(embedded.endpoint).not.toContain(':8766');

    // Isolated homes — do not share fixture repoRoot (may carry unrelated mcp config).
    const disabledHome = mkdtempSync(join(tmpdir(), 'lb-disabled-'));
    const disabledRepo = join(disabledHome, 'repo');
    roots.push(disabledHome);
    mkdirSync(disabledRepo, { recursive: true });
    ensureControllerHome(disabledHome);
    writeMcpServiceLocalConfig(disabledHome, {
      localController: { enabled: false, mode: 'disabled', host: '127.0.0.1', port: 8766 },
    });
    const disabled = resolveLocalBridgeSurface({
      controllerHome: disabledHome,
      repoRoot: disabledRepo,
      allowProcessScan: false,
    });
    expect(disabled.mode).toBe('disabled');
    expect(disabled.requiredForReadiness).toBe(false);
    expect(disabled.enabled).toBe(false);

    // Standalone required keeps readiness gate.
    const standHome = mkdtempSync(join(tmpdir(), 'lb-stand-'));
    const standRepo = join(standHome, 'repo');
    roots.push(standHome);
    mkdirSync(standRepo, { recursive: true });
    ensureControllerHome(standHome);
    writeMcpServiceLocalConfig(standHome, {
      localController: { enabled: true, mode: 'standalone', host: '127.0.0.1', port: 8766 },
    });
    const standalone = resolveLocalBridgeSurface({
      controllerHome: standHome,
      repoRoot: standRepo,
      allowProcessScan: false,
    });
    expect(standalone.mode).toBe('standalone');
    expect(standalone.requiredForReadiness).toBe(true);
    expect(standalone.endpoint).toBe('http://127.0.0.1:8766/');

    // Ports come from slot allocation, not hardcoded 8776 as truth.
    const base = slotPortDefaults();
    expect(base.localControllerPort).toBe(8766);
    const greenInactive = allocateSlotPorts('green', 'blue', base);
    expect(greenInactive.localControllerPort).toBe(8776);
    const greenActive = allocateSlotPorts('green', 'green', base);
    expect(greenActive.localControllerPort).toBe(8766);
  });

  test('active blue/green slot home wins over root controller-home runtime', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lb-slot-authority-'));
    roots.push(workspace);
    const controllerHome = join(workspace, 'controller-home');
    const repoRoot = join(workspace, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    ensureControllerHome(controllerHome);
    // Root home points at legacy 8766 (stale template).
    writeMcpServiceRuntimeState(controllerHome, {
      version: 1,
      repo: repoRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      tunnelMode: 'none',
      generation: 'gen-root',
      server: { endpoint: 'http://127.0.0.1:8765/', running: true, healthy: true, restartCount: 0 },
      localController: {
        endpoint: 'http://127.0.0.1:8766/',
        running: false,
        mode: 'embedded',
        generation: 'gen-root',
      },
    });
    writeMcpServiceLocalConfig(controllerHome, {
      localController: { enabled: true, mode: 'embedded', host: '127.0.0.1', port: 8766 },
    });
    // Active green slot has live 8776.
    const { writeActiveSlotAuthority, ensureSlotHome } = require('../../src/cli/controller/runtime-slots') as typeof import('../../src/cli/controller/runtime-slots');
    writeActiveSlotAuthority(controllerHome, {
      activeSlot: 'green',
      previousSlot: 'blue',
      generation: 'gen-green',
      reason: 'test',
    });
    const greenHome = ensureSlotHome(controllerHome, 'green');
    writeMcpServiceRuntimeState(greenHome, {
      version: 1,
      repo: repoRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      tunnelMode: 'none',
      generation: 'gen-green',
      server: { endpoint: 'http://127.0.0.1:8775/', running: true, healthy: true, restartCount: 0 },
      localController: {
        endpoint: 'http://127.0.0.1:8776/',
        running: true,
        mode: 'embedded',
        pid: 4242,
        generation: 'gen-green',
      },
    });
    writeMcpServiceLocalConfig(greenHome, {
      localController: { enabled: true, mode: 'embedded', host: '127.0.0.1', port: 8776 },
    });

    const surface = resolveLocalBridgeSurface({ controllerHome, repoRoot, allowProcessScan: false });
    expect(surface.endpoint).toBe('http://127.0.0.1:8776/');
    expect(surface.mode).toBe('embedded');
    expect(surface.processRunning).toBe(true);
    expect(surface.activeSlot).toBe('green');
    expect(surface.requiredForReadiness).toBe(false);
    expect(surface.endpoint).not.toContain(':8766');
  });

  test('standalone required endpoint not reachable remains degraded/blocked observation', async () => {
    const { ctx, repository, controllerHome, repoRoot } = fixture();
    writeMcpServiceRuntimeState(controllerHome, {
      version: 1,
      repo: repoRoot,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      tunnelMode: 'none',
      generation: 'gen-stand',
      server: { endpoint: 'http://127.0.0.1:8765/', running: true, healthy: true, restartCount: 0 },
      localController: {
        endpoint: 'http://127.0.0.1:18766/',
        running: false,
        mode: 'standalone',
        generation: 'gen-stand',
      },
    });
    writeMcpServiceLocalConfig(controllerHome, {
      localController: { enabled: true, mode: 'standalone', host: '127.0.0.1', port: 18766 },
    });
    const result = await callRuntimeTool(ctx, 'local_bridge_status', {
      repo_id: repository.repoId,
    });
    const summary = fullToolBytes(result!).structured;
    expect(summary.mode).toBe('standalone');
    expect(summary.requiredForReadiness).toBe(true);
    expect(summary.endpoint).toContain('18766');
    // Unreachable endpoint must not report healthy ready when required.
    expect(summary.ready === false || summary.running === false || summary.health === 'unavailable' || summary.health === 'warning').toBe(true);
  });

  test('recent historical failures are stats, not active readiness blockers', () => {
    const jobs = [
      { status: 'failed' },
      { status: 'failed' },
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'running' },
    ];
    const { activeJobCount, recentJobSummary } = summarizeRecentJobs(jobs);
    expect(activeJobCount).toBe(1);
    expect(recentJobSummary.failed).toBe(2);
    expect(recentJobSummary.succeeded).toBe(2);
    // failed count must not be conflated with active
    expect(activeJobCount).not.toBe(recentJobSummary.failed);
  });

  test('get_job summary and artifact ref stay within budgets', async () => {
    const job = {
      jobId: 'EJOB-budget',
      repoId: 'repo_budget',
      checkoutId: 'chk',
      type: 'repository-command',
      status: 'succeeded',
      priority: 'P1',
      requestId: 'req',
      semanticKey: 'sk',
      payload: { operation: 'repository_command_execute', target: 'runtime', timeoutMs: 1000 },
      origin: { surface: 'mcp' },
      resourceClaims: [],
      dependencies: [],
      leaseRefs: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      queuedAt: new Date(0).toISOString(),
      attempt: 0,
      maxAttempts: 1,
      evidenceIds: ['EVD-1'],
      result: {
        externalized: true,
        artifactId: 'ART-budget',
        artifactKind: 'job-result',
        byteLength: 40,
        next: 'Call get_artifact',
      },
    } as unknown as ExecutionJob;

    const measured = await measureRuns(() => summarizeExecutionJobForMcp(job, '/tmp/repo'), 3);
    const summaryBytes = measureBytes(measured.last);
    expect(summaryBytes).toBeLessThan(RESPONSE_BUDGET.statusSummaryBytes);

    const art = artifactRef({ artifactId: 'ART-budget', repoId: 'repo_budget', jobId: 'EJOB-budget', byteLength: 40 });
    const artBytes = measureBytes(art);
    expect(artBytes).toBeLessThan(RESPONSE_BUDGET.artifactRefBytes);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      test: 'get_job_and_artifact_ref_e2e',
      getJobSummaryBytes: summaryBytes,
      artifactRefBytes: artBytes,
      avgMs: Number(measured.avg.toFixed(3)),
      maxMs: Number(measured.max.toFixed(3)),
      executionJobCount: 0,
      localJobCount: 0,
      artifact: true,
    }));
  });

  test('rh_status summary stays under 32KB', async () => {
    const { ctx, repository } = fixture();
    const measured = await measureRuns(async () => {
      const result = await callRuntimeTool(ctx, 'rh_status', {
        repo_id: repository.repoId,
        operation: 'get',
      });
      return fullToolBytes(result!);
    }, 3);
    expect(measured.last.fullBytes).toBeLessThan(RESPONSE_BUDGET.rhStatusSummaryBytes);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      test: 'rh_status_summary_e2e',
      fullBytes: measured.last.fullBytes,
      textBytes: measured.last.textBytes,
      structuredBytes: measured.last.structuredBytes,
      avgMs: Number(measured.avg.toFixed(3)),
      maxMs: Number(measured.max.toFixed(3)),
    }));
  });
});
