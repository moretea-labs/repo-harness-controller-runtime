import { spawnSync } from 'child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import type {
  AgentAuthenticationReadiness,
  AgentExecutableIdentity,
} from './types';
import type { ControllerAgent } from '../controller/types';

export type LocalAgent = Exclude<ControllerAgent, 'github-copilot'>;

export class AgentExecutableError extends Error {
  constructor(
    public readonly code:
      | 'AGENT_EXECUTABLE_NOT_FOUND'
      | 'AGENT_EXECUTABLE_NOT_EXECUTABLE'
      | 'AGENT_EXECUTABLE_VERSION_FAILED'
      | 'AGENT_EXECUTABLE_IDENTITY_CHANGED'
      | 'AGENT_AUTHENTICATION_REQUIRED'
      | 'AGENT_AUTHENTICATION_UNVERIFIED',
    message: string,
  ) {
    super(message);
    this.name = 'AgentExecutableError';
  }
}

function executableName(agent: LocalAgent): string {
  return agent === 'codex' ? 'codex' : 'claude';
}

function configuredExecutable(agent: LocalAgent, env: NodeJS.ProcessEnv): string | undefined {
  const key = agent === 'codex'
    ? 'REPO_HARNESS_CODEX_EXECUTABLE'
    : 'REPO_HARNESS_CLAUDE_EXECUTABLE';
  const value = env[key]?.trim();
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(value);
}

function executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [command];
  const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveFromPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const candidate of executableCandidates(command, env)) {
      const path = join(directory, candidate);
      if (isExecutable(path)) return resolve(path);
    }
  }
  return undefined;
}

export function agentProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = env.HOME?.trim();
  return {
    ...env,
    ...(env.VOLTA_HOME?.trim() || !home ? {} : { VOLTA_HOME: join(home, '.volta') }),
  };
}

function boundedProbe(executablePath: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(executablePath, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: agentProcessEnv(),
  });
}

function probeVersion(executablePath: string): string {
  const result = boundedProbe(executablePath, ['--version']);
  const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 256);
  if (result.status !== 0 || !version) {
    throw new AgentExecutableError(
      'AGENT_EXECUTABLE_VERSION_FAILED',
      `Local Agent executable version probe failed for ${executablePath}.`,
    );
  }
  return version;
}

function probeAuthentication(
  agent: LocalAgent,
  executablePath: string,
): AgentAuthenticationReadiness {
  if (agent !== 'codex') return 'unknown';
  const result = boundedProbe(executablePath, ['login', 'status']);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase();
  if (result.status === 0 && /(logged in|authenticated|chatgpt)/.test(output)) return 'ready';
  if (/(not logged in|not authenticated|auth(?:entication)? required|login required)/.test(output)) return 'required';
  return 'unknown';
}

function fileIdentity(path: string): AgentExecutableIdentity['fileIdentity'] {
  const stat = statSync(path);
  return {
    device: Number(stat.dev),
    inode: Number(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function resolveAgentExecutable(
  agent: LocalAgent,
  env: NodeJS.ProcessEnv = process.env,
): AgentExecutableIdentity {
  const command = executableName(agent);
  const configured = configuredExecutable(agent, env);
  const executablePath = configured ?? resolveFromPath(command, env);
  if (!executablePath) {
    throw new AgentExecutableError(
      'AGENT_EXECUTABLE_NOT_FOUND',
      `Local ${agent} executable was not found in the configured path or Worker PATH.`,
    );
  }
  if (!isExecutable(executablePath)) {
    throw new AgentExecutableError(
      'AGENT_EXECUTABLE_NOT_EXECUTABLE',
      `Configured local ${agent} executable is not executable: ${executablePath}`,
    );
  }
  const resolvedPath = realpathSync(executablePath);
  return {
    schemaVersion: 1,
    agent,
    command,
    source: configured ? 'configured' : 'path',
    executablePath,
    resolvedPath,
    version: probeVersion(executablePath),
    authenticationReadiness: probeAuthentication(agent, executablePath),
    probedAt: new Date().toISOString(),
    fileIdentity: fileIdentity(executablePath),
  };
}

export function assertAgentExecutableReady(identity: AgentExecutableIdentity): void {
  if (identity.agent !== 'codex') return;
  if (identity.authenticationReadiness === 'required') {
    throw new AgentExecutableError(
      'AGENT_AUTHENTICATION_REQUIRED',
      'Local codex authentication is required before dispatch. Run the normal Codex login flow, then retry readiness.',
    );
  }
  if (identity.authenticationReadiness !== 'ready') {
    throw new AgentExecutableError(
      'AGENT_AUTHENTICATION_UNVERIFIED',
      'Local codex authentication readiness could not be verified; dispatch is blocked rather than guessing.',
    );
  }
}

export function revalidateAgentExecutable(
  identity: AgentExecutableIdentity,
): AgentExecutableIdentity {
  if (!isExecutable(identity.executablePath)) {
    throw new AgentExecutableError(
      'AGENT_EXECUTABLE_NOT_EXECUTABLE',
      `Local ${identity.agent} executable disappeared or is no longer executable: ${identity.executablePath}`,
    );
  }
  const currentResolvedPath = realpathSync(identity.executablePath);
  const currentFileIdentity = fileIdentity(identity.executablePath);
  const sameIdentity = currentResolvedPath === identity.resolvedPath
    && currentFileIdentity.device === identity.fileIdentity.device
    && currentFileIdentity.inode === identity.fileIdentity.inode
    && currentFileIdentity.size === identity.fileIdentity.size
    && currentFileIdentity.mtimeMs === identity.fileIdentity.mtimeMs;
  if (!sameIdentity) {
    throw new AgentExecutableError(
      'AGENT_EXECUTABLE_IDENTITY_CHANGED',
      `Local ${identity.agent} executable identity changed after admission; submit a new request after readiness is re-probed.`,
    );
  }
  return identity;
}

export interface AgentExecutableReadiness {
  agent: LocalAgent;
  found: boolean;
  executablePath?: string;
  resolvedPath?: string;
  version?: string;
  authenticationReadiness: AgentAuthenticationReadiness;
  lastProbeAt: string;
  errorCode?: string;
  message?: string;
}

export interface AgentExecutableReadinessSnapshot {
  schemaVersion: 1;
  updatedAt: string;
  executors: Partial<Record<LocalAgent, AgentExecutableReadiness>>;
}

function readinessSnapshotPath(controllerHome: string): string {
  return join(controllerHome, 'health', 'agent-executables.json');
}

export function writeAgentExecutableReadinessSnapshot(
  controllerHome: string,
  agents: LocalAgent[] = ['codex', 'claude'],
): AgentExecutableReadinessSnapshot {
  const snapshot: AgentExecutableReadinessSnapshot = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    executors: Object.fromEntries(
      agents.map((agent) => [agent, inspectAgentExecutableReadiness(agent)]),
    ),
  };
  const path = readinessSnapshotPath(controllerHome);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
  return snapshot;
}

export function readAgentExecutableReadinessSnapshot(
  controllerHome: string,
): AgentExecutableReadinessSnapshot | undefined {
  const path = readinessSnapshotPath(controllerHome);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentExecutableReadinessSnapshot;
    return parsed.schemaVersion === 1 && parsed.executors ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function inspectAgentExecutableReadiness(
  agent: LocalAgent,
  env: NodeJS.ProcessEnv = process.env,
): AgentExecutableReadiness {
  const lastProbeAt = new Date().toISOString();
  try {
    const identity = resolveAgentExecutable(agent, env);
    return {
      agent,
      found: true,
      executablePath: identity.executablePath,
      resolvedPath: identity.resolvedPath,
      version: identity.version,
      authenticationReadiness: identity.authenticationReadiness,
      lastProbeAt: identity.probedAt,
    };
  } catch (error) {
    return {
      agent,
      found: false,
      authenticationReadiness: 'unknown',
      lastProbeAt,
      errorCode: error instanceof AgentExecutableError ? error.code : 'AGENT_EXECUTABLE_PROBE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
