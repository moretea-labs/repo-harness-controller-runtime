import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  controllerHomeHasAuthoritativeMcpState,
  loadMcpServiceRuntimeState,
  resolveMcpRuntimeAuthority,
} from '../../src/cli/mcp/auth';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('controller-home MCP authority', () => {
  test('controller-home authority suppresses legacy runtime fallback once any live MCP state exists', () => {
    const repoRoot = tempRoot('repo-harness-mcp-authority-repo-');
    const controllerHome = tempRoot('repo-harness-mcp-authority-home-');
    mkdirSync(join(repoRoot, '.repo-harness'), { recursive: true });
    mkdirSync(join(controllerHome, 'mcp'), { recursive: true });

    writeFileSync(join(repoRoot, '.repo-harness', 'mcp.runtime.json'), JSON.stringify({
      version: 1,
      repo: repoRoot,
      startedAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
      status: 'running',
      tunnelMode: 'none',
      server: { endpoint: 'http://127.0.0.1:8765/mcp', running: true, healthy: true, restartCount: 0 },
    }, null, 2));
    writeFileSync(join(controllerHome, 'mcp', 'mcp.tokens.json'), JSON.stringify({ bearerToken: 'controller-home-token' }));

    expect(controllerHomeHasAuthoritativeMcpState(controllerHome)).toBe(true);
    expect(loadMcpServiceRuntimeState(controllerHome, repoRoot)).toBeNull();

    const authority = resolveMcpRuntimeAuthority(controllerHome, repoRoot, 'runtime-state');
    expect(authority.authority).toBe('controller-home');
    expect(authority.warning).toContain('Controller Home is authoritative');
  });
});
