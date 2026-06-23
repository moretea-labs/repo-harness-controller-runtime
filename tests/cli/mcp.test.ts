import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMcpRestartKeepaliveArgs, defaultMcpRestartLogPath } from '../../src/cli/mcp/restart';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');

function runMcp(args: string[]) {
  return spawnSync('bun', [CLI, 'mcp', ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
}

describe('mcp command', () => {
  test('prints help for command group and subcommands', () => {
    const root = runMcp(['--help']);
    expect(root.status).toBe(0);
    expect(root.stdout).toContain('Run and configure the repo-harness MCP workflow sidecar');
    expect(root.stdout).toContain('serve');
    expect(root.stdout).toContain('restart');
    expect(root.stdout).toContain('doctor');
    expect(root.stdout).toContain('setup');

    const serve = runMcp(['serve', '--help']);
    expect(serve.status).toBe(0);
    expect(serve.stdout).toContain('--transport <transport>');
    expect(serve.stdout).toContain('--profile <profile>');
    expect(serve.stdout).toContain('--enable-dev-runner');

    const doctor = runMcp(['doctor', '--help']);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('Check repo-harness MCP setup status');

    const restart = runMcp(['restart', '--help']);
    expect(restart.status).toBe(0);
    expect(restart.stdout).toContain('--skip-tools-smoke');
    expect(restart.stdout).toContain('--github-repo <owner/repo>');

    const setup = runMcp(['setup', '--help']);
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain('chatgpt');
    expect(setup.stdout).toContain('codex');
    expect(root.stdout).toContain('prepare-goal');
  });

  test('rejects invalid subcommands with a useful error', () => {
    const result = runMcp(['missing']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command 'missing'");
  });

  test('prepare-goal writes Codex handoff and prints host-native /goal prompt', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-mcp-goal-'));
    try {
      mkdirSync(join(repoRoot, '.ai/harness'), { recursive: true });
      mkdirSync(join(repoRoot, 'plans/prds'), { recursive: true });
      mkdirSync(join(repoRoot, 'plans/sprints'), { recursive: true });
      writeFileSync(join(repoRoot, '.ai/harness/policy.json'), '{}\n');
      writeFileSync(join(repoRoot, 'plans/prds/example.prd.md'), '# Example PRD\n');
      writeFileSync(join(repoRoot, 'plans/sprints/example.sprint.md'), '# Example Sprint\n\n- [ ] Task\n');

      const result = runMcp([
        'prepare-goal',
        '--repo',
        repoRoot,
        '--prd',
        join(repoRoot, 'plans/prds/example.prd.md'),
        '--sprint',
        join(repoRoot, 'plans/sprints/example.sprint.md'),
        '--reference-repo',
        '/tmp/reference-repo',
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('/goal');
      expect(result.stdout).toContain(`Read: ${join(repoRoot, 'plans/prds/example.prd.md')}`);
      expect(result.stdout).toContain(`Open or use a worktree and complete: ${join(repoRoot, 'plans/sprints/example.sprint.md')}`);
      expect(result.stdout).toContain('After each completed phase, stage the result before continuing.');
      expect(result.stdout).toContain("Use the user's language for status reports unless repo-local instructions require otherwise.");
      expect(result.stdout).not.toContain('阅读：');
      expect(result.stdout).not.toContain('开worktree完整执行');
      const goalPath = join(repoRoot, '.ai/harness/handoff/codex-goal.md');
      expect(existsSync(goalPath)).toBe(true);
      expect(readFileSync(goalPath, 'utf-8')).toContain('## Host-native /goal prompt');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('builds restart keepalive args from resolved config', () => {
    const args = buildMcpRestartKeepaliveArgs({
      repoRoot: '/tmp/example-repo',
      host: '127.0.0.1',
      port: 8765,
      profile: 'controller',
      authMode: 'oauth',
      publicEndpoint: 'https://example.test/mcp',
      defaultServerName: 'repo-harness-controller-v8',
      expectedToolSurface: 'controller-chatgpt-bridge-v8',
      devRunner: true,
      devRunnerAgents: ['codex', 'claude'],
      devRunnerTimeoutMs: 3600000,
      devRunnerMaxTimeoutMs: 43200000,
      localUiEnabled: true,
      localUiHost: '127.0.0.1',
      localUiPort: 8766,
      localUiAutoOpen: false,
      tunnelMode: 'named',
      tunnelName: 'repo-harness-mcp',
      oauthFile: '.repo-harness/mcp.oauth.json',
      tokenFile: '.repo-harness/mcp.tokens.json',
      stdoutLogPath: '/tmp/repo-harness-mcp.log',
      stderrLogPath: '/tmp/repo-harness-mcp.log',
    });
    expect(args).toContain('--enable-dev-runner');
    expect(args).toContain('--cloudflare-tunnel-name');
    expect(args).toContain('repo-harness-mcp');
    expect(args).toContain('--local-ui-port');
    expect(args).toContain('8766');
  });

  test('uses a deterministic default restart log path inside repo-local logs', () => {
    expect(defaultMcpRestartLogPath('/tmp/example-repo')).toBe('/tmp/example-repo/.ai/local/logs/repo-harness-mcp.log');
  });
});
