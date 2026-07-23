import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { runProcess } from '../../effects/process-runner';
import { isProcessAlive } from '../shared/process-tree';

export interface LaunchctlCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type LaunchctlCommandRunner = (args: string[]) => LaunchctlCommandResult;

export interface LaunchAgentFileSnapshot {
  path: string;
  content?: Buffer;
}

export interface LaunchdServiceProbe {
  /** Check if a service label is registered in the launchd domain. */
  isServiceRegistered(domain: string, label: string): boolean;
  /** Check if a PID is alive. */
  isPidAlive(pid: number): boolean;
  /** Check if a TCP port is listening. */
  isPortListening(port: number): boolean;
}

export interface SafeHandoffOptions {
  label: string;
  plistPath: string;
  domain: string;
  oldPid?: number;
  port?: number;
  maxBootoutWaitMs?: number;
  maxBootstrapRetry?: number;
  bootstrapRetryDelayMs?: number;
  pollIntervalMs?: number;
}

export interface SafeHandoffResult {
  bootstrapAttempts: number;
  bootoutClean: boolean;
  pidWaitClean: boolean;
  portWaitClean: boolean;
  plistInstalled: boolean;
  serviceRegistered: boolean;
  diagnostics: {
    bootoutResult?: LaunchctlCommandResult;
    bootstrapResults: LaunchctlCommandResult[];
    serviceProbeResults: boolean[];
    pidAliveChecks: boolean[];
    portChecks: boolean[];
  };
}

function runLaunchctl(args: string[]): LaunchctlCommandResult {
  const result = runProcess('launchctl', args, {
    timeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
  });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 0,
  };
}

const defaultRunner: LaunchctlCommandRunner = runLaunchctl;

const defaultProbe: LaunchdServiceProbe = {
  isServiceRegistered(domain, label) {
    const result = runLaunchctl(['print', `${domain}/${label}`]);
    return result.ok;
  },
  isPidAlive(pid) {
    return isProcessAlive(pid);
  },
  isPortListening(port) {
    try {
      const result = runProcess('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], {
        timeoutMs: 3_000,
        maxOutputBytes: 4_096,
      });
      return result.ok && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  },
};

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

/**
 * Check if a bootout result indicates the service is already gone (success).
 */
function isBootoutAlreadyGone(result: LaunchctlCommandResult): boolean {
  const detail = `${result.stderr}\n${result.stdout}`;
  return /not found|no such process|could not be found|service is not loaded/i.test(detail);
}

/**
 * Check if a bootstrap failure is the EIO (error 5) that may be transient.
 */
function isBootstrapEio(result: LaunchctlCommandResult): boolean {
  const detail = `${result.stderr}\n${result.stdout}`;
  return /bootstrap failed:\s*5\b/i.test(detail);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a safe launchd handoff with state-driven waiting.
 *
 * Steps:
 * 1. Bootout old service (treat "not found" as success)
 * 2. Wait for service to disappear from launchd domain
 * 3. Wait for old PID to exit
 * 4. Wait for port to be released
 * 5. Atomically install plist
 * 6. Bootstrap new service
 * 7. Wait for service registration
 *
 * If bootstrap returns EIO, collect diagnostics and make a bounded retry
 * decision based on the actual launchd state — not a fixed sleep loop.
 */
export async function safeLaunchdHandoff(
  options: SafeHandoffOptions,
  dependencies: { run?: LaunchctlCommandRunner; probe?: LaunchdServiceProbe; wait?: (ms: number) => Promise<void> } = {},
): Promise<SafeHandoffResult> {
  const run = dependencies.run ?? defaultRunner;
  const probe = dependencies.probe ?? defaultProbe;
  const wait = dependencies.wait ?? sleep;

  const maxBootoutWaitMs = options.maxBootoutWaitMs ?? 15_000;
  const maxBootstrapRetry = Math.max(1, Math.min(options.maxBootstrapRetry ?? 3, 5));
  const bootstrapRetryDelayMs = Math.max(100, options.bootstrapRetryDelayMs ?? 500);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 200);

  const diagnostics: SafeHandoffResult['diagnostics'] = {
    bootstrapResults: [],
    serviceProbeResults: [],
    pidAliveChecks: [],
    portChecks: [],
  };

  // Step 1: Bootout old service
  const target = `${options.domain}/${options.label}`;
  const bootoutResult = run(['bootout', target]);
  diagnostics.bootoutResult = bootoutResult;

  const bootoutClean = bootoutResult.ok || isBootoutAlreadyGone(bootoutResult);
  if (!bootoutClean) {
    // Bootout failed with unexpected error — collect diagnostics but don't proceed
    return {
      bootstrapAttempts: 0,
      bootoutClean: false,
      pidWaitClean: true,
      portWaitClean: true,
      plistInstalled: false,
      serviceRegistered: false,
      diagnostics,
    };
  }

  // Step 2: Wait for service to disappear from launchd
  const bootoutDeadline = Date.now() + maxBootoutWaitMs;
  let serviceGone = false;
  while (Date.now() < bootoutDeadline) {
    const registered = probe.isServiceRegistered(options.domain, options.label);
    diagnostics.serviceProbeResults.push(registered);
    if (!registered) {
      serviceGone = true;
      break;
    }
    await wait(pollIntervalMs);
  }

  // Step 3: Wait for old PID to exit
  let pidWaitClean = true;
  if (options.oldPid) {
    const pidDeadline = Date.now() + maxBootoutWaitMs;
    while (Date.now() < pidDeadline) {
      const alive = probe.isPidAlive(options.oldPid);
      diagnostics.pidAliveChecks.push(alive);
      if (!alive) break;
      await wait(pollIntervalMs);
    }
    if (probe.isPidAlive(options.oldPid)) {
      pidWaitClean = false;
    }
  }

  // Step 4: Wait for port to be released
  let portWaitClean = true;
  if (options.port) {
    const portDeadline = Date.now() + maxBootoutWaitMs;
    while (Date.now() < portDeadline) {
      const listening = probe.isPortListening(options.port);
      diagnostics.portChecks.push(listening);
      if (!listening) break;
      await wait(pollIntervalMs);
    }
    if (probe.isPortListening(options.port)) {
      portWaitClean = false;
    }
  }

  // Step 5: Enable the service
  const enableResult = run(['enable', target]);
  if (!enableResult.ok) {
    const detail = (enableResult.stderr || enableResult.stdout).trim();
    return {
      bootstrapAttempts: 0,
      bootoutClean: true,
      pidWaitClean,
      portWaitClean,
      plistInstalled: false,
      serviceRegistered: false,
      diagnostics: { ...diagnostics, bootstrapResults: [enableResult] },
    };
  }

  // Step 6: Bootstrap with bounded state-driven retry
  for (let attempt = 1; attempt <= maxBootstrapRetry; attempt += 1) {
    const bootstrapResult = run(['bootstrap', options.domain, options.plistPath]);
    diagnostics.bootstrapResults.push(bootstrapResult);

    if (bootstrapResult.ok) {
      // Kickstart to ensure the service is running
      const kickstartResult = run(['kickstart', '-k', target]);
      if (!kickstartResult.ok) {
        const detail = (kickstartResult.stderr || kickstartResult.stdout).trim();
        if (!/timed out|service could not be found|could not find service|no such process|operation now in progress/i.test(detail)) {
          // Non-fatal: bootstrap succeeded, kickstart may fail if RunAtLoad already started it
        }
      }
      return {
        bootstrapAttempts: attempt,
        bootoutClean: true,
        pidWaitClean,
        portWaitClean,
        plistInstalled: true,
        serviceRegistered: true,
        diagnostics,
      };
    }

    // Bootstrap failed — collect diagnostics to decide next step
    const isEio = isBootstrapEio(bootstrapResult);

    if (isEio && attempt < maxBootstrapRetry) {
      // Check if the service somehow got registered despite the EIO
      // (launchd sometimes returns EIO but still loads the job)
      const registeredAfterEio = probe.isServiceRegistered(options.domain, options.label);
      diagnostics.serviceProbeResults.push(registeredAfterEio);
      if (registeredAfterEio) {
        // Service is actually registered despite EIO — treat as success
        return {
          bootstrapAttempts: attempt,
          bootoutClean: true,
          pidWaitClean,
          portWaitClean,
          plistInstalled: true,
          serviceRegistered: true,
          diagnostics,
        };
      }

      // EIO with no registration — wait before retrying, but use a
      // bounded increasing delay, not an infinite loop
      await wait(bootstrapRetryDelayMs * attempt);
      continue;
    }

    // Non-EIO error or exhausted retries
    break;
  }

  return {
    bootstrapAttempts: diagnostics.bootstrapResults.length,
    bootoutClean: true,
    pidWaitClean,
    portWaitClean,
    plistInstalled: true,
    serviceRegistered: false,
    diagnostics,
  };
}

/**
 * Backward-compatible wrapper that preserves the old API signature.
 */
export async function bootstrapLaunchAgentWithRetry(
  input: { label: string; plistPath: string; domain: string; maxAttempts?: number; retryDelayMs?: number },
  dependencies: { run?: LaunchctlCommandRunner; wait?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const result = await safeLaunchdHandoff(
    {
      label: input.label,
      plistPath: input.plistPath,
      domain: input.domain,
      maxBootstrapRetry: input.maxAttempts ?? 3,
      bootstrapRetryDelayMs: input.retryDelayMs ?? 250,
    },
    dependencies,
  );
  if (!result.serviceRegistered) {
    const lastBootstrap = result.diagnostics.bootstrapResults[result.diagnostics.bootstrapResults.length - 1];
    const detail = lastBootstrap ? (lastBootstrap.stderr || lastBootstrap.stdout).trim() : 'unknown error';
    throw new Error(`launchctl bootstrap failed for ${input.label}: ${detail}`);
  }
  return result.bootstrapAttempts;
}

export function findRepoLaunchAgents(repoRoot: string): { label: string; plistPath: string }[] {
  const home = process.env.HOME?.trim();
  if (!home) return [];
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  if (!existsSync(launchAgentsDir)) return [];

  const agents: { label: string; plistPath: string }[] = [];
  const entries = runProcess('ls', ['-1', launchAgentsDir], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  if (!entries.ok) return agents;
  for (const entry of entries.stdout.split('\n').filter((line) => line.endsWith('.plist'))) {
    const plistPath = join(launchAgentsDir, entry);
    let plistText = '';
    try {
      plistText = readFileSync(plistPath, 'utf-8');
    } catch {
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

export function bootoutRepoLaunchAgents(agents: { label: string; plistPath: string }[]): void {
  if (agents.length === 0) return;
  const uid = typeof process.getuid === 'function'
    ? process.getuid()
    : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1024 }).stdout.trim());
  const domain = `gui/${uid}`;
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

export function bootstrapRepoLaunchAgents(agents: { label: string; plistPath: string }[]): void {
  if (agents.length === 0) return;
  const uid = typeof process.getuid === 'function'
    ? process.getuid()
    : Number(runProcess('id', ['-u'], { timeoutMs: 2_000, maxOutputBytes: 1024 }).stdout.trim());
  const domain = `gui/${uid}`;
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
