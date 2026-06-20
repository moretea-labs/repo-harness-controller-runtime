import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_TIMEOUT_MS } from '../controller/runtime-config';
import type { McpAgentRunnerName, McpPolicy, McpProfileName } from './types';

const COMMON_DENY_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '.ssh/**',
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  'coverage/**',
  'secrets/**',
  'credentials/**',
  'private/**',
  '.cache/**',
  '.DS_Store',
];

export const PLANNER_READ_GLOBS = [
  'AGENTS.md',
  'CLAUDE.md',
  'SKILL.md',
  'docs/spec.md',
  'docs/reference-configs/**',
  'plans/**',
  'tasks/current.md',
  'tasks/contracts/**',
  'tasks/reviews/**',
  'tasks/notes/**',
  '.ai/context/**',
  '.ai/harness/handoff/**',
  '.ai/harness/checks/**',
];

export const PLANNER_WRITE_GLOBS = [
  'plans/prds/**',
  'plans/sprints/**',
  'plans/plan-*.md',
  '.ai/harness/handoff/codex-goal.md',
  '.ai/harness/handoff/chatgpt-plan.md',
];

export interface McpPolicyOptions {
  devAgentRunner?: boolean;
  allowedAgents?: McpAgentRunnerName[];
  runnerTimeoutMs?: number;
  runnerMaxTimeoutMs?: number;
  repoRoot?: string;
}

interface McpPolicyOverrideProfile {
  readGlobs?: string[];
  writeGlobs?: string[];
  denyGlobs?: string[];
  appendReadGlobs?: string[];
  appendWriteGlobs?: string[];
  appendDenyGlobs?: string[];
  maxFileBytes?: number;
}

interface McpPolicyOverrideFile {
  profiles?: Partial<Record<McpProfileName, McpPolicyOverrideProfile>>;
}

function executionPolicy(overrides: Partial<McpPolicy['execution']> = {}): McpPolicy['execution'] {
  return {
    fixedWorkflowCheck: false,
    codexRunner: false,
    agentRunner: false,
    allowedAgents: [],
    runnerTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    runnerMaxTimeoutMs: MAX_AGENT_TIMEOUT_MS,
    ...overrides,
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  return normalized;
}

function loadMcpPolicyOverrides(repoRoot?: string): McpPolicyOverrideFile | undefined {
  if (!repoRoot) return undefined;
  const path = join(repoRoot, '.repo-harness', 'mcp.policy.json');
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  const profilesRaw = raw.profiles;
  if (!profilesRaw || typeof profilesRaw !== 'object' || Array.isArray(profilesRaw)) return undefined;
  const profiles: Partial<Record<McpProfileName, McpPolicyOverrideProfile>> = {};
  for (const profile of ['planner', 'executor', 'orchestrator', 'controller'] as const) {
    const entry = (profilesRaw as Record<string, unknown>)[profile];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const maxFileBytes = typeof record.maxFileBytes === 'number' && Number.isFinite(record.maxFileBytes)
      ? Math.trunc(record.maxFileBytes)
      : undefined;
    profiles[profile] = {
      readGlobs: parseStringArray(record.readGlobs),
      writeGlobs: parseStringArray(record.writeGlobs),
      denyGlobs: parseStringArray(record.denyGlobs),
      appendReadGlobs: parseStringArray(record.appendReadGlobs),
      appendWriteGlobs: parseStringArray(record.appendWriteGlobs),
      appendDenyGlobs: parseStringArray(record.appendDenyGlobs),
      maxFileBytes,
    };
  }
  return { profiles };
}

function applyPolicyOverrides(
  base: McpPolicy,
  profile: McpProfileName,
  repoRoot?: string,
): McpPolicy {
  const override = loadMcpPolicyOverrides(repoRoot)?.profiles?.[profile];
  if (!override) return base;
  return {
    ...base,
    readGlobs: uniqueStrings([...(override.readGlobs ?? base.readGlobs), ...(override.appendReadGlobs ?? [])]),
    writeGlobs: uniqueStrings([...(override.writeGlobs ?? base.writeGlobs), ...(override.appendWriteGlobs ?? [])]),
    denyGlobs: uniqueStrings([...COMMON_DENY_GLOBS, ...(override.denyGlobs ?? base.denyGlobs), ...(override.appendDenyGlobs ?? [])]),
    maxFileBytes: override.maxFileBytes ?? base.maxFileBytes,
  };
}

export function getMcpPolicy(profile: McpProfileName, opts: McpPolicyOptions = {}): McpPolicy {
  if (profile === 'planner') {
    return applyPolicyOverrides({
      profile,
      readGlobs: PLANNER_READ_GLOBS,
      writeGlobs: PLANNER_WRITE_GLOBS,
      denyGlobs: [
        ...COMMON_DENY_GLOBS,
        'src/**',
        'app/**',
        'packages/**',
        'package.json',
        'bun.lock',
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        '.github/workflows/**',
      ],
      maxFileBytes: 512 * 1024,
      execution: executionPolicy({
        fixedWorkflowCheck: true,
      }),
    }, profile, opts.repoRoot);
  }

  if (profile === 'executor') {
    return applyPolicyOverrides({
      profile,
      readGlobs: ['plans/**', 'tasks/**', 'docs/spec.md', '.ai/context/**', '.ai/harness/**'],
      writeGlobs: ['tasks/reviews/**', '.ai/harness/checks/**', '.ai/harness/handoff/**'],
      denyGlobs: COMMON_DENY_GLOBS,
      maxFileBytes: 512 * 1024,
      execution: executionPolicy({
        fixedWorkflowCheck: true,
      }),
    }, profile, opts.repoRoot);
  }

  if (profile === 'controller') {
    const devRunner = opts.devAgentRunner === true;
    return applyPolicyOverrides({
      profile,
      readGlobs: ['**'],
      writeGlobs: ['**'],
      denyGlobs: [
        ...COMMON_DENY_GLOBS,
        '.repo-harness/**',
        '.ai/harness/security/**',
        '.codex/**',
        '.claude/**',
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lock',
        '.github/workflows/**',
      ],
      maxFileBytes: 2 * 1024 * 1024,
      execution: executionPolicy({
        fixedWorkflowCheck: true,
        codexRunner: devRunner,
        agentRunner: devRunner,
        allowedAgents: devRunner ? (opts.allowedAgents?.length ? opts.allowedAgents : ['codex']) : [],
        runnerTimeoutMs: opts.runnerTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        runnerMaxTimeoutMs: opts.runnerMaxTimeoutMs ?? MAX_AGENT_TIMEOUT_MS,
      }),
    }, profile, opts.repoRoot);
  }

  if (profile === 'orchestrator') {
    const devRunner = opts.devAgentRunner === true;
    return applyPolicyOverrides({
      profile,
      readGlobs: devRunner ? ['.ai/harness/handoff/codex-goal.md'] : [],
      writeGlobs: [],
      denyGlobs: devRunner ? COMMON_DENY_GLOBS : ['**'],
      maxFileBytes: devRunner ? 512 * 1024 : 0,
      execution: executionPolicy({
        codexRunner: devRunner,
        agentRunner: devRunner,
        allowedAgents: devRunner ? (opts.allowedAgents?.length ? opts.allowedAgents : ['codex']) : [],
        runnerTimeoutMs: opts.runnerTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        runnerMaxTimeoutMs: opts.runnerMaxTimeoutMs ?? MAX_AGENT_TIMEOUT_MS,
      }),
    }, profile, opts.repoRoot);
  }

  throw new Error(`unknown MCP profile: ${String(profile)}`);
}

export function parseMcpProfile(value: string): McpProfileName {
  if (value === 'planner' || value === 'executor' || value === 'orchestrator' || value === 'controller') return value;
  throw new Error(`invalid MCP profile "${value}" (expected: planner, executor, orchestrator, controller)`);
}
