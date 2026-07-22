import { describe, expect, test } from 'bun:test';
import {
  executionTimeoutPolicyForMcpCall,
  operationExecutionTimeoutMsForMcpCall,
  isDirectHotReadTool,
  isGatewayIsolatedTool,
  isSelfManagedDurableTool,
  waitTimeoutMs,
  wantsWaitForResult,
} from '../../src/runtime/gateway/mcp/router';

describe('MCP durable routing hot path', () => {
  test('wait_ms configures but never enables waiting', () => {
    expect(wantsWaitForResult({ wait_ms: 30_000 })).toBe(false);
    expect(wantsWaitForResult({ wait: false, wait_ms: 30_000 })).toBe(false);
    expect(wantsWaitForResult({ wait: true, wait_ms: 30_000 })).toBe(true);
  });

  test('explicit wait timeout remains bounded', () => {
    expect(waitTimeoutMs({ wait: true, wait_ms: 10 })).toBe(200);
    expect(waitTimeoutMs({ wait: true, wait_ms: 30_000 })).toBe(30_000);
    expect(waitTimeoutMs({ wait: true, wait_ms: 999_999 })).toBe(120_000);
  });

  test('Agent execution timeout is preserved independently from the parent Job', () => {
    const args = {
      execution_timeout_ms: 3_600_000,
      wait: true,
      interactive_wait_ms: 30_000,
    };
    const policy = executionTimeoutPolicyForMcpCall('quick_agent_session', args);
    expect(operationExecutionTimeoutMsForMcpCall('quick_agent_session', args)).toBe(3_600_000);
    expect(policy).toEqual({
      admissionTimeoutMs: 300_000,
      queueTimeoutMs: 24 * 60 * 60_000,
      executionTimeoutMs: 120_000,
      interactiveWaitMs: 30_000,
    });

    const normal = executionTimeoutPolicyForMcpCall('run_check', { timeout_ms: 600_000 });
    expect(normal.admissionTimeoutMs).toBe(600_000);
    expect(normal.queueTimeoutMs).toBe(600_000);
    expect(normal.executionTimeoutMs).toBe(600_000);
  });

  test('high-frequency reads bypass durable execution', () => {
    for (const name of ['get_job', 'work_get', 'work_list', 'controller_ready', 'rh_status', 'rh_context', 'controller_context_pack', 'git_diff_paths']) {
      expect(isDirectHotReadTool(name)).toBe(true);
    }
    expect(isDirectHotReadTool('run_check')).toBe(false);
    expect(isDirectHotReadTool('repository_command_execute')).toBe(false);
  });

  test('host-blocking runtime tools are isolated from the Gateway event loop', () => {
    for (const name of [
      'ios_xcode_status', 'ios_simulators_list', 'ios_app_build', 'ios_simulator_screenshot',
      'workflow_watchdog_report', 'runtime_cleanup_apply',
      'runtime_maintenance_apply', 'release_gate', 'runtime_recovery',
    ]) {
      expect(isGatewayIsolatedTool(name)).toBe(true);
    }
    expect(isGatewayIsolatedTool('plugin_action_execute')).toBe(false);
    expect(isGatewayIsolatedTool('rh_status')).toBe(false);
    expect(isGatewayIsolatedTool('repository_git_status')).toBe(false);
  });

  test('plugin actions keep one durable owner and preserve the public request id', () => {
    expect(isSelfManagedDurableTool('plugin_action_execute')).toBe(true);
    expect(isSelfManagedDurableTool('run_check')).toBe(false);
  });
});
