import { describe, expect, test } from 'bun:test';
import {
  extractCloudflareQuickTunnelUrl,
  inferMcpTunnelMode,
  DEFAULT_MCP_UNHEALTHY_RESTART_WINDOW_MS,
  isExpectedLocalControllerHealth,
  normalizeKeepalivePublicEndpoint,
  shouldRestartMcpServer,
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
    expect(inferMcpTunnelMode(undefined, 'https://repo-harness-mcp.example.com/mcp', 'repo-harness-mcp')).toBe('named');
    expect(inferMcpTunnelMode('none', 'https://repo-harness-mcp.example.com/mcp', 'repo-harness-mcp')).toBe('none');
    expect(() => inferMcpTunnelMode('bad-mode', undefined, undefined)).toThrow('invalid --tunnel');
  });

  test('validates keepalive public endpoint values', () => {
    expect(normalizeKeepalivePublicEndpoint('https://repo-harness-mcp.example.com/mcp')).toBe(
      'https://repo-harness-mcp.example.com/mcp',
    );
    expect(normalizeKeepalivePublicEndpoint(undefined)).toBeUndefined();
    expect(() => normalizeKeepalivePublicEndpoint('http://repo-harness-mcp.example.com/mcp')).toThrow(
      'invalid --public-endpoint',
    );
    expect(() => normalizeKeepalivePublicEndpoint('https://repo-harness-mcp.example.com/not-mcp')).toThrow(
      'invalid --public-endpoint',
    );
  });

  test('does not restart a live gateway during transient health failures', () => {
    const now = 1_000_000;
    expect(shouldRestartMcpServer(true, 1, now, now)).toBe(false);
    expect(shouldRestartMcpServer(true, 2, now, now + 30_000)).toBe(false);
  });

  test('restarts immediately when the gateway process has exited', () => {
    expect(shouldRestartMcpServer(false, 0, undefined, Date.now())).toBe(true);
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
