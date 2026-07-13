import { describe, expect, test } from 'bun:test';
import { isDirectHotReadTool, waitTimeoutMs, wantsWaitForResult } from '../../src/runtime/gateway/mcp/router';

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

  test('high-frequency reads bypass durable execution', () => {
    for (const name of ['get_job', 'work_get', 'work_list', 'controller_ready', 'rh_status', 'rh_context', 'controller_context_pack', 'git_diff_paths']) {
      expect(isDirectHotReadTool(name)).toBe(true);
    }
    expect(isDirectHotReadTool('run_check')).toBe(false);
    expect(isDirectHotReadTool('repository_command_execute')).toBe(false);
    // Explicit work_submit uses forceDurable and is tested in work-submit-hardening.
  });
});
