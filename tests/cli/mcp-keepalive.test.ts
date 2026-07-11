import { describe, expect, test } from 'bun:test';
import {
  decideMcpPortOwnership,
  extractCloudflareQuickTunnelUrl,
  inferMcpTunnelMode,
  DEFAULT_MCP_UNHEALTHY_RESTART_WINDOW_MS,
  DEFAULT_MCP_TUNNEL_UNHEALTHY_RESTART_WINDOW_MS,
  isAddressInUseFailure,
  isExpectedLocalControllerHealth,
  mcpServerRestartDelayMs,
  normalizeKeepalivePublicEndpoint,
  shouldRestartMcpServer,
  shouldRestartMcpTunnel,
} from '../../src/cli/mcp/keepalive';
import { runtimePolicy } from '../../src/cli/mcp/multi-repository';
import { controllerExpectedToolNames } from '../../src/cli/mcp/tools';
import { controllerToolSurfaceFingerprint } from '../../src/cli/controller/runtime-config';

describe('mcp keepalive helpers', () => {
  test('extracts quick tunnel URLs from cloudflared logs', () => {
    const line = 'INF +--------------------------------------------------------------------------------------------+\nINF |  https://industries-renaissance-advertisements-hand.trycloudflare.com                     |\nINF +--------------------------------------------------------------------------------------------+';
    expect(extractCloudflareQuickTunnelUrl(line)).toBe('https://industries-renaissance-advertisements-hand.trycloudflare.com');
    expect(extractCloudflareQuickTunnelUrl('no tunnel here')).toBeUndefined();
  });

  test('infers tunnel mode from endpoint and named tunnel presence', () => {
    expect(inferMcpTunnelMode(undefined, undefined, undefined)).toBe('quick');
    expect(inferMcpTunnelMode(undefined, 'https://repo-harness-mcp.acme.dev/mcp', 'repo-harness-mcp')).toBe('named');
    expect(inferMcpTunnelMode(undefined, 'https://repo-harness-mcp.acme.dev/mcp', undefined)).toBe('none');
    expect(inferMcpTunnelMode('none', 'https://repo-harness-mcp.acme.dev/mcp', 'repo-harness-mcp')).toBe('none');
    expect(() => inferMcpTunnelMode('bad-mode', undefined, undefined)).toThrow('invalid --tunnel');
  });

  test('validates keepalive public endpoint values', () => {
    expect(normalizeKeepalivePublicEndpoint('https://repo-harness-mcp.acme.dev/mcp')).toBe(
      'https://repo-harness-mcp.acme.dev/mcp',
    );
    expect(normalizeKeepalivePublicEndpoint(undefined)).toBeUndefined();
    expect(() => normalizeKeepalivePublicEndpoint('http://repo-harness-mcp.acme.dev/mcp')).toThrow(
      'invalid --public-endpoint',
    );
    expect(() => normalizeKeepalivePublicEndpoint('https://repo-harness-mcp.acme.dev/not-mcp')).toThrow(
      'invalid --public-endpoint',
    );
  });

  test('supports operator-managed fixed public endpoints with no managed tunnel', () => {
    expect(normalizeKeepalivePublicEndpoint('https://mcp.acme.dev/mcp')).toBe('https://mcp.acme.dev/mcp');
    expect(inferMcpTunnelMode('none', 'https://mcp.acme.dev/mcp', undefined)).toBe('none');
  });

  test('does not restart a live gateway during transient health failures', () => {
    const now = 1_000_000;
    expect(shouldRestartMcpServer(true, 1, now, now)).toBe(false);
    expect(shouldRestartMcpServer(true, 2, now, now + 30_000)).toBe(false);
  });

  test('restarts immediately when the gateway process has exited', () => {
    expect(shouldRestartMcpServer(false, 0, undefined, Date.now())).toBe(true);
    expect(mcpServerRestartDelayMs(false, 2_000)).toBe(0);
    expect(mcpServerRestartDelayMs(true, 2_000)).toBe(2_000);
  });

  test('detects address-in-use bind failures for fail-fast', () => {
    expect(isAddressInUseFailure('Failed to start server. Is port 8765 in use?')).toBe(true);
    expect(isAddressInUseFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:8765')).toBe(true);
    expect(isAddressInUseFailure('local MCP health is degraded')).toBe(false);
  });

  test('aborts when another healthy MCP already owns the port', () => {
    const expected = {
      toolSurface: 'controller-chatgpt-bridge-v8',
      schemaVersion: 10,
      toolSurfaceVersion: 8,
      toolSurfaceFingerprint: 'abc',
      runtimeToolSurfaceFingerprint: 'def',
      toolset: 'full',
      profile: 'controller',
    };
    const foreign = decideMcpPortOwnership({
      health: {
        status: 'ok',
        server: 'repo-harness-mcp',
        toolSurface: 'controller-chatgpt-bridge-v8',
        schemaVersion: 10,
        toolSurfaceVersion: 8,
        toolSurfaceFingerprint: 'abc',
        runtimeToolSurfaceFingerprint: 'def',
        toolset: 'core',
        profile: 'controller',
      },
      expected,
      previousOwnedPid: undefined,
      isPidAlive: () => false,
    });
    expect(foreign.action).toBe('abort');
    if (foreign.action === 'abort') {
      expect(foreign.reason).toContain('incompatible');
      expect(foreign.reason).toContain('One MCP control plane');
    }

    const sameSurfaceUnowned = decideMcpPortOwnership({
      health: {
        status: 'ok',
        server: 'repo-harness-mcp',
        ...expected,
      },
      expected,
      previousOwnedPid: undefined,
      isPidAlive: () => false,
    });
    expect(sameSurfaceUnowned.action).toBe('abort');

    const takeover = decideMcpPortOwnership({
      health: {
        status: 'ok',
        server: 'repo-harness-mcp',
        instanceId: 'instance-a',
        ...expected,
      },
      expected,
      previousOwnedPid: 42_001,
      previousOwnedInstanceId: 'instance-a',
      isPidAlive: (pid) => pid === 42_001,
    });
    expect(takeover).toEqual({ action: 'takeover', pid: 42_001 });

    const reusedPid = decideMcpPortOwnership({
      health: {
        status: 'ok',
        server: 'repo-harness-mcp',
        instanceId: 'instance-b',
        ...expected,
      },
      expected,
      previousOwnedPid: 42_001,
      previousOwnedInstanceId: 'instance-a',
      isPidAlive: (pid) => pid === 42_001,
    });
    expect(reusedPid.action).toBe('abort');

    expect(decideMcpPortOwnership({
      health: null,
      expected,
      isPidAlive: () => false,
    }).action).toBe('free');
  });

  test('restarts a live gateway only after the continuous unhealthy window', () => {
    const unhealthySinceAt = 2_000_000;
    expect(shouldRestartMcpServer(
      true,
      2,
      unhealthySinceAt,
      unhealthySinceAt + DEFAULT_MCP_UNHEALTHY_RESTART_WINDOW_MS - 1,
    )).toBe(false);
    expect(shouldRestartMcpServer(
      true,
      2,
      unhealthySinceAt,
      unhealthySinceAt + DEFAULT_MCP_UNHEALTHY_RESTART_WINDOW_MS,
    )).toBe(true);
    expect(shouldRestartMcpServer(
      true,
      2,
      unhealthySinceAt,
      unhealthySinceAt + 4_999,
      5_000,
    )).toBe(false);
    expect(shouldRestartMcpServer(
      true,
      2,
      unhealthySinceAt,
      unhealthySinceAt + 5_000,
      5_000,
    )).toBe(true);
  });

  test('does not restart a live tunnel while the local gateway is unhealthy', () => {
    const now = 3_000_000;
    expect(shouldRestartMcpTunnel(false, true, 20, now - 60_000, now)).toBe(false);
  });

  test('restarts a dead tunnel immediately and a live unhealthy tunnel only after its window', () => {
    const since = 4_000_000;
    expect(shouldRestartMcpTunnel(true, false, 0, undefined, since)).toBe(true);
    expect(shouldRestartMcpTunnel(true, true, 2, since, since + DEFAULT_MCP_TUNNEL_UNHEALTHY_RESTART_WINDOW_MS - 1)).toBe(false);
    expect(shouldRestartMcpTunnel(true, true, 2, since, since + DEFAULT_MCP_TUNNEL_UNHEALTHY_RESTART_WINDOW_MS)).toBe(true);
  });

  test('recognizes the expected local controller health payload', () => {
    const fingerprint = controllerToolSurfaceFingerprint(
      controllerExpectedToolNames(runtimePolicy(process.cwd(), { profile: 'controller' })),
    );
    expect(
      isExpectedLocalControllerHealth({
        status: 'ok',
        toolSurface: 'controller-chatgpt-bridge-v8',
        schemaVersion: 10,
        toolSurfaceVersion: 8,
        toolSurfaceFingerprint: fingerprint,
      }),
    ).toBe(true);
    expect(
      isExpectedLocalControllerHealth({
        status: 'ok',
        toolSurface: 'wrong-surface',
      }),
    ).toBe(false);
  });
});
