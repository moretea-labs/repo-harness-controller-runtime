import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { runProcess } from '../../effects/process-runner';

export interface RepoLaunchAgent {
  label: string;
  plistPath: string;
}

function launchctlDomain(): string {
  const uid = typeof process.getuid === 'function'
    ? process.getuid()
    : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1024 }).stdout.trim());
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error('Unable to resolve current uid for launchctl.');
  }
  return `gui/${uid}`;
}

function runLaunchctl(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcess('launchctl', args, {
    timeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
  });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function findRepoLaunchAgents(repoRoot: string): RepoLaunchAgent[] {
  const home = process.env.HOME?.trim();
  if (!home) return [];
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  if (!existsSync(launchAgentsDir)) return [];

  const agents: RepoLaunchAgent[] = [];
  for (const entry of readdirSync(launchAgentsDir)) {
    if (!entry.endsWith('.plist')) continue;
    const plistPath = join(launchAgentsDir, entry);
    let plistText = '';
    try {
      plistText = readFileSync(plistPath, 'utf-8');
    } catch (_error) {
      continue;
    }
    if (!plistText.includes(repoRoot)) continue;
    if (!plistText.includes('repo-harness-mcp-launch.sh') && !(plistText.includes('repo-harness') && plistText.includes('keepalive'))) continue;
    const label = /<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/i.exec(plistText)?.[1]?.trim();
    if (!label) continue;
    agents.push({ label, plistPath });
  }
  return agents;
}

export function bootoutRepoLaunchAgents(agents: RepoLaunchAgent[]): void {
  if (agents.length === 0) return;
  const domain = launchctlDomain();
  for (const agent of agents) {
    const result = runLaunchctl(['bootout', domain, agent.plistPath]);
    if (!result.ok) {
      const detail = (result.stderr || result.stdout).trim();
      if (!/not loaded|no such process|service could not be found|could not find service|input\/output error/i.test(detail)) {
        throw new Error(`launchctl bootout failed for ${agent.label}: ${detail || 'unknown error'}`);
      }
    }
  }
}

export function bootstrapRepoLaunchAgents(agents: RepoLaunchAgent[]): void {
  if (agents.length === 0) return;
  const domain = launchctlDomain();
  for (const agent of agents) {
    const bootstrap = runLaunchctl(['bootstrap', domain, agent.plistPath]);
    if (!bootstrap.ok) {
      const detail = (bootstrap.stderr || bootstrap.stdout).trim();
      throw new Error(`launchctl bootstrap failed for ${agent.label}: ${detail || 'unknown error'}`);
    }
    const kickstart = runLaunchctl(['kickstart', '-k', `${domain}/${agent.label}`]);
    if (!kickstart.ok) {
      const detail = (kickstart.stderr || kickstart.stdout).trim();
      if (!/timed out|service could not be found|could not find service|no such process|operation now in progress/i.test(detail)) {
        throw new Error(`launchctl kickstart failed for ${agent.label}: ${detail || 'unknown error'}`);
      }
    }
  }
}
