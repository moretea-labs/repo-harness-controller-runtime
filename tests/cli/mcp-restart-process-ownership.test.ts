import { describe, expect, test } from 'bun:test';
import {
  buildMcpRestartKeepaliveEnv,
  isPeerMcpProcessForBinding,
  isStaleControllerDaemonForRestart,
  type McpProcessBindingConfig,
} from '../../src/cli/mcp/restart';

const config: McpProcessBindingConfig = {
  repoRoot: '/repos/current',
  host: '127.0.0.1',
  port: 8765,
  profile: 'controller',
};

describe('mcp restart process ownership', () => {
  test('detects peer keepalive on the same binding', () => {
    const command = 'bun src/cli/index.ts mcp keepalive --repo /repos/peer --host 127.0.0.1 --port 8765 --profile controller';
    expect(isPeerMcpProcessForBinding(command, config)).toBe(true);
  });

  test('does not detect current repo keepalive as peer', () => {
    const command = 'bun src/cli/index.ts mcp keepalive --repo /repos/current --host 127.0.0.1 --port 8765 --profile controller';
    expect(isPeerMcpProcessForBinding(command, config)).toBe(false);
  });

  test('does not detect a peer keepalive on a different port', () => {
    const command = 'bun src/cli/index.ts mcp keepalive --repo /repos/peer --host 127.0.0.1 --port 8767 --profile controller';
    expect(isPeerMcpProcessForBinding(command, config)).toBe(false);
  });

  test('detects detached daemons using a temp controller home', () => {
    const command = '/usr/bin/bun /repos/current/src/runtime/control-plane/daemon-entry.ts --controller-home /var/tmp/repo-harness-controller-home-abc123';
    expect(isStaleControllerDaemonForRestart(command, '/repos/current')).toBe(true);
  });

  test('detects detached daemons using another repo local controller home', () => {
    const command = '/usr/bin/bun /repos/current/src/runtime/control-plane/daemon-entry.ts --controller-home /repos/peer/.ai/local/controller-home';
    expect(isStaleControllerDaemonForRestart(command, '/repos/current')).toBe(true);
  });

  test('does not detect the current controller home as stale', () => {
    const command = '/usr/bin/bun /repos/current/src/runtime/control-plane/daemon-entry.ts --controller-home /repos/current/_ops/controller-home';
    expect(isStaleControllerDaemonForRestart(command, '/repos/current')).toBe(false);
  });

  test('passes the resolved controller home to detached keepalive restarts', () => {
    expect(buildMcpRestartKeepaliveEnv(
      { controllerHome: '/controller/home' },
      { PATH: '/usr/bin', LANG: 'en_US.UTF-8' },
    )).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      REPO_HARNESS_CONTROLLER_HOME: '/controller/home',
    });
  });
});
