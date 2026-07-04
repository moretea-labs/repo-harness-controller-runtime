import { describe, expect, test } from 'bun:test';
import { isHighCpuPeerMcpProcess, isStaleControllerDaemonProcess, type RuntimeProcessSample } from '../../src/runtime/diagnostics/performance';

function sample(overrides: Partial<RuntimeProcessSample>): RuntimeProcessSample {
  return {
    pid: 100,
    ppid: 1,
    pgid: 100,
    elapsed: '00:01',
    cpu: 0,
    mem: 0,
    command: 'repo-harness mcp serve',
    kind: 'mcp-server',
    repoRoot: '/repos/current',
    orphan: false,
    highCpu: false,
    ...overrides,
  };
}

describe('runtime performance diagnostics', () => {
  test('detects high-CPU MCP servers from peer repositories', () => {
    expect(isHighCpuPeerMcpProcess(sample({
      cpu: 98,
      highCpu: true,
      repoRoot: '/repos/peer',
      kind: 'mcp-server',
    }), '/repos/current')).toBe(true);
  });

  test('detects high-CPU MCP keepalive processes from peer repositories', () => {
    expect(isHighCpuPeerMcpProcess(sample({
      cpu: 91,
      highCpu: true,
      repoRoot: '/repos/peer',
      kind: 'mcp-keepalive',
    }), '/repos/current')).toBe(true);
  });

  test('does not flag the current repository MCP process', () => {
    expect(isHighCpuPeerMcpProcess(sample({
      cpu: 99,
      highCpu: true,
      repoRoot: '/repos/current/',
      kind: 'mcp-server',
    }), '/repos/current')).toBe(false);
  });

  test('does not flag low-CPU peer MCP processes', () => {
    expect(isHighCpuPeerMcpProcess(sample({
      cpu: 1,
      highCpu: false,
      repoRoot: '/repos/peer',
      kind: 'mcp-server',
    }), '/repos/current')).toBe(false);
  });

  test('does not flag non-MCP high-CPU processes', () => {
    expect(isHighCpuPeerMcpProcess(sample({
      cpu: 95,
      highCpu: true,
      repoRoot: '/repos/peer',
      kind: 'worker',
    }), '/repos/current')).toBe(false);
  });

  test('detects detached daemons using a temp controller home', () => {
    expect(isStaleControllerDaemonProcess(sample({
      kind: 'controller-daemon',
      ppid: 1,
      command: '/usr/bin/bun /repos/current/src/runtime/control-plane/daemon-entry.ts --controller-home /var/tmp/repo-harness-controller-home-abc123',
    }), '/repos/current')).toBe(true);
  });

  test('detects detached daemons using another repo local controller home', () => {
    expect(isStaleControllerDaemonProcess(sample({
      kind: 'controller-daemon',
      ppid: 1,
      command: '/usr/bin/bun /repos/current/src/runtime/control-plane/daemon-entry.ts --controller-home /repos/peer/.ai/local/controller-home',
    }), '/repos/current')).toBe(true);
  });

  test('does not flag the current controller home as stale', () => {
    expect(isStaleControllerDaemonProcess(sample({
      kind: 'controller-daemon',
      ppid: 1,
      command: '/usr/bin/bun /repos/current/src/runtime/control-plane/daemon-entry.ts --controller-home /repos/current/_ops/controller-home',
    }), '/repos/current')).toBe(false);
  });
});
