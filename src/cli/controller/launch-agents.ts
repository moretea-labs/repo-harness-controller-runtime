import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { runProcess } from '../../effects/process-runner';

export interface RepoLaunchAgent {
  label: string;
  plistPath: string;
}

export interface LaunchctlCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type LaunchctlCommandRunner = (args: string[]) => LaunchctlCommandResult;

export interface LaunchAgentFileSnapshot {
  path: string;
  content?: Buffer;
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

export function launchAgentPath(label: string, home = process.env.HOME?.trim() || homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function snapshotLaunchAgent(path: string): LaunchAgentFileSnapshot {
  try {
    return { path, content: readFileSync(path) };
  } catch {
    return { path };
  }
}

export function installLaunchAgent(sourcePath: string, label: string): LaunchAgentFileSnapshot {
  const target = launchAgentPath(label);
  const snapshot = snapshotLaunchAgent(target);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, readFileSync(sourcePath), { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
  renameSync(temporary, target);
  return snapshot;
}

export function restoreLaunchAgent(snapshot: LaunchAgentFileSnapshot): void {
  if (snapshot.content === undefined) {
    rmSync(snapshot.path, { force: true });
    return;
  }
  writeFileSync(snapshot.path, snapshot.content, { mode: 0o600 });
  try { chmodSync(snapshot.path, 0o600); } catch { /* best effort */ }
}

export async function bootstrapLaunchAgentWithRetry(
  input: { label: string; plistPath: string; domain: string; maxAttempts?: number; retryDelayMs?: number },
  dependencies: { run?: LaunchctlCommandRunner; wait?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const run = dependencies.run ?? runLaunchctl;
  const target = `${input.domain}/${input.label}`;
  const enabled = run(['enable', target]);
  if (!enabled.ok) {
    const detail = (enabled.stderr || enabled.stdout).trim();
    throw new Error(`launchctl enable failed for ${input.label}: ${detail || 'unknown error'}`);
  }
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 3, 3));
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? 250);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const bootstrap = run(['bootstrap', input.domain, input.plistPath]);
    if (bootstrap.ok) {
      const kickstart = run(['kickstart', '-k', target]);
      if (!kickstart.ok) {
        const detail = (kickstart.stderr || kickstart.stdout).trim();
        if (!/timed out|service could not be found|could not find service|no such process|operation now in progress/i.test(detail)) {
          throw new Error(`launchctl kickstart failed for ${input.label}: ${detail || 'unknown error'}`);
        }
      }
      return attempt;
    }
    const detail = (bootstrap.stderr || bootstrap.stdout).trim();
    const retryable = /bootstrap failed:\s*5\b/i.test(detail);
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`launchctl bootstrap failed for ${input.label}: ${detail || 'unknown error'}`);
    }
    await (dependencies.wait ?? ((ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms))))(retryDelayMs * attempt);
  }
  throw new Error(`launchctl bootstrap failed for ${input.label}: retry loop exhausted`);
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
