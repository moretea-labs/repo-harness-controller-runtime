import { describe, expect, test } from 'bun:test';
import {
  extractCloudflareQuickTunnelUrl,
  inferMcpTunnelMode,
  isExpectedLocalControllerHealth,
  normalizeKeepalivePublicEndpoint,
} from '../../src/cli/mcp/keepalive';

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

  test('recognizes the expected local controller health payload', () => {
    expect(
      isExpectedLocalControllerHealth({
        status: 'ok',
        toolSurface: 'controller-chatgpt-bridge-v8',
        schemaVersion: 10,
        toolSurfaceVersion: 8,
        toolSurfaceFingerprint: '13b4720825d62e08',
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
