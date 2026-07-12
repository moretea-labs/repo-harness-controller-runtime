import { describe, expect, test } from 'bun:test';
import {
  decideMcpPortOwnership,
  isExpectedLocalControllerHealth,
} from '../../src/cli/mcp/keepalive';
import {
  buildMcpRestartKeepaliveArgs,
  buildMcpRestartKeepaliveEnv,
  isPeerMcpProcessForBinding,
  isStaleControllerDaemonForRestart,
  requiredRestartSmokeTools,
  type McpProcessBindingConfig,
} from '../../src/cli/mcp/restart';
import {
  mergeNoProxy,
  withDirectNetworkProxyBypass,
} from '../../src/cli/mcp/proxy-env';
import { normalizeKeepalivePublicEndpoint } from '../../src/cli/mcp/keepalive';

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

  test('treats generation-mismatched MCP ownership as incompatible', () => {
    const decision = decideMcpPortOwnership({
      health: {
        status: 'ok',
        server: 'repo-harness-mcp',
        toolSurface: 'controller-chatgpt-bridge-v8',
        schemaVersion: 8,
        toolSurfaceVersion: 8,
        toolset: 'full',
        profile: 'controller',
        generation: 'runtime-old',
      },
      expected: {
        toolSurface: 'controller-chatgpt-bridge-v8',
        schemaVersion: 8,
        toolSurfaceVersion: 8,
        toolset: 'full',
        profile: 'controller',
        generation: 'runtime-new',
      },
    });
    expect(decision.action).toBe('abort');
  });

  test('passes the resolved controller home and proxy bypass to detached keepalive restarts', () => {
    const env = buildMcpRestartKeepaliveEnv(
      { controllerHome: '/controller/home' },
      {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        HTTPS_PROXY: 'http://127.0.0.1:7897',
        NO_PROXY: '127.0.0.1,localhost',
      },
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    expect(env.REPO_HARNESS_CONTROLLER_HOME).toBe('/controller/home');
    expect(env.NO_PROXY).toContain('.ts.net');
    expect(env.NO_PROXY).toContain('127.0.0.1');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  test('passes configured toolset on keepalive restart args', () => {
    const args = buildMcpRestartKeepaliveArgs({
      controllerHome: '/controller/home',
      repoRoot: '/repos/current',
      host: '127.0.0.1',
      port: 8765,
      profile: 'controller',
      authMode: 'oauth',
      toolset: 'full',
      publicEndpoint: 'https://greysons-macbook-air.tail95bb5c.ts.net/mcp',
      defaultServerName: 'repo-harness',
      expectedToolSurface: 'controller-chatgpt-bridge-v8',
      devRunner: true,
      devRunnerAgents: ['codex'],
      devRunnerTimeoutMs: 3_600_000,
      devRunnerMaxTimeoutMs: 43_200_000,
      localUiEnabled: false,
      localUiHost: '127.0.0.1',
      localUiPort: 8766,
      localUiAutoOpen: false,
      tunnelMode: 'none',
      oauthFile: 'mcp/mcp.oauth.json',
      tokenFile: 'mcp/mcp.tokens.json',
      stdoutLogPath: '/tmp/out.log',
      stderrLogPath: '/tmp/err.log',
    });
    expect(args).toContain('--toolset');
    expect(args[args.indexOf('--toolset') + 1]).toBe('full');
    expect(args).toContain('--public-endpoint');
  });

  test('smoke tools match toolset exposure', () => {
    expect(requiredRestartSmokeTools('core')).toContain('rh_status');
    expect(requiredRestartSmokeTools('core')).not.toContain('controller_capabilities');
    expect(requiredRestartSmokeTools('full')).toContain('controller_capabilities');
  });

  test('requires matching generation for local controller health', () => {
    expect(isExpectedLocalControllerHealth({
      status: 'ok',
      toolSurface: 'controller-chatgpt-bridge-v8',
      schemaVersion: 8,
      toolSurfaceVersion: 8,
      generation: 'runtime-a',
    }, { generation: 'runtime-b' })).toBe(false);
  });
});

describe('proxy bypass and public endpoint normalization', () => {
  test('merges direct-network NO_PROXY entries without losing existing values', () => {
    const merged = mergeNoProxy('127.0.0.1,localhost', '.ts.net', '127.0.0.1');
    expect(merged.split(',')).toEqual(['127.0.0.1', 'localhost', '.ts.net']);
    const env = withDirectNetworkProxyBypass({
      NO_PROXY: 'mirrors.aliyun.com',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
    });
    expect(env.NO_PROXY).toContain('mirrors.aliyun.com');
    expect(env.NO_PROXY).toContain('.ts.net');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
  });

  test('drops placeholder ChatGPT public endpoints', () => {
    expect(normalizeKeepalivePublicEndpoint('https://repo-harness-mcp.example.com/mcp')).toBeUndefined();
    expect(normalizeKeepalivePublicEndpoint('https://greysons-macbook-air.tail95bb5c.ts.net/mcp'))
      .toBe('https://greysons-macbook-air.tail95bb5c.ts.net/mcp');
  });
});
