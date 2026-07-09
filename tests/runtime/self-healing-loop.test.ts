import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSelfHealingLoop } from '../../src/runtime/control-plane/facade/self-healing-loop';
import { listHandoffItems } from '../../src/runtime/control-plane/facade/handoff-inbox-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-self-heal-'));
  roots.push(root);
  return {
    ctx: {
      repoId: 'repo_test',
      handoffStore: { root: join(root, 'handoff') },
    },
  };
}

describe('self-healing loop', () => {
  test('diagnose defaults to dry_run and never marks acceptance failure', () => {
    const { ctx } = fixture();
    const result = runSelfHealingLoop(ctx, {
      operation: 'diagnose',
      issues: [{
        kind: 'stale_local_job',
        summary: 'Stale local job detected',
        severity: 'warning',
        safeToAutoRepair: true,
        requiresApproval: false,
        suggestedAction: 'reconcile_local_jobs',
      }],
    });

    expect(result.status).toBe('ok');
    expect((result.data as { dryRun: boolean; isAcceptanceFailure: boolean }).dryRun).toBe(true);
    expect((result.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
    expect(result.suggestedNextActions.some((action) => action.operation === 'repair' || action.tool === 'rh_status')).toBe(true);
  });

  test('repair defaults to dry_run preview and requires approval for destructive restart', () => {
    const { ctx } = fixture();
    const dry = runSelfHealingLoop(ctx, {
      operation: 'repair',
      issues: [{
        kind: 'controller_daemon_health',
        summary: 'Daemon unhealthy',
        severity: 'error',
        safeToAutoRepair: false,
        requiresApproval: true,
        suggestedAction: 'restart_controller_or_bridge',
      }],
    });
    expect((dry.data as { dryRun: boolean; applied: boolean }).dryRun).toBe(true);
    expect((dry.data as { applied: boolean }).applied).toBe(false);

    const blocked = runSelfHealingLoop(ctx, {
      operation: 'repair',
      dryRun: false,
      processKillOrRestart: true,
      issues: [{
        kind: 'controller_daemon_health',
        summary: 'Daemon unhealthy',
        severity: 'error',
        safeToAutoRepair: false,
        requiresApproval: true,
        suggestedAction: 'restart_controller_or_bridge',
      }],
    });
    expect(blocked.status).toBe('approval_required');
    expect((blocked.data as { applied: boolean; isAcceptanceFailure: boolean }).applied).toBe(false);
    expect((blocked.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
    expect(listHandoffItems(ctx.handoffStore).length).toBe(1);
  });

  test('safe maintenance can apply and suggests verification', () => {
    const { ctx } = fixture();
    const result = runSelfHealingLoop(ctx, {
      operation: 'repair',
      dryRun: false,
      issues: [{
        kind: 'runtime_projection_dirty',
        summary: 'Projection dirty',
        severity: 'warning',
        safeToAutoRepair: true,
        requiresApproval: false,
        suggestedAction: 'rebuild_projection',
      }],
    });
    expect((result.data as { applied: boolean }).applied).toBe(true);
    expect(result.suggestedNextActions.some((action) => action.tool === 'rh_status' && action.operation === 'get')).toBe(true);
  });

  test('ChatGPT pull failure is not task acceptance failure', () => {
    const { ctx } = fixture();
    const result = runSelfHealingLoop(ctx, {
      operation: 'diagnose',
      chatgptPullFailed: true,
    });
    expect((result.data as { isAcceptanceFailure: boolean; chatgptPullFailed: boolean }).isAcceptanceFailure).toBe(false);
    expect((result.data as { chatgptPullFailed: boolean }).chatgptPullFailed).toBe(true);
    expect(result.warnings.some((warning) => warning.toLowerCase().includes('pull failure'))).toBe(true);
  });

  test('handoff operation creates pending decision without acceptance failure', () => {
    const { ctx } = fixture();
    const result = runSelfHealingLoop(ctx, {
      operation: 'handoff',
      issues: [{
        kind: 'codex_claude_unavailable',
        summary: 'Worker unavailable',
        severity: 'error',
        safeToAutoRepair: false,
        requiresApproval: false,
        suggestedAction: 'handoff_or_retry_later',
      }],
    });
    expect(result.status).toBe('blocked');
    expect((result.data as { isAcceptanceFailure: boolean }).isAcceptanceFailure).toBe(false);
    expect(listHandoffItems(ctx.handoffStore)).toHaveLength(1);
  });
});
