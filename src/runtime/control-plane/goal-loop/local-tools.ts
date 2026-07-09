import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import {
  isLocalToolEnabledInConfig,
  readLocalToolConfig,
  type GoalLoopConfigLocation,
} from './config-store';
import type { LocalToolDescriptor } from './config-types';

export interface LocalToolProbeOptions {
  configLocation?: GoalLoopConfigLocation;
  env?: NodeJS.ProcessEnv;
  skipExecutableProbe?: boolean;
  /** Injected status for tests. */
  mockTools?: Partial<Record<string, Partial<LocalToolDescriptor>>>;
}

const TOOL_META: Record<string, {
  displayName: string;
  command?: string;
  capabilityTags: string[];
  usedByWorkflows: string[];
  versionArgs?: string[];
}> = {
  direct_edit: {
    displayName: 'Direct Edit',
    capabilityTags: ['code_patch', 'local_file_mutation'],
    usedByWorkflows: ['source edit'],
  },
  codex_cli: {
    displayName: 'Codex CLI',
    command: 'codex',
    capabilityTags: ['code_patch', 'code_review', 'tool_calling'],
    usedByWorkflows: ['source edit', 'tests', 'repair'],
    versionArgs: ['--version'],
  },
  claude_cli: {
    displayName: 'Claude CLI',
    command: 'claude',
    capabilityTags: ['code_patch', 'code_review', 'long_context'],
    usedByWorkflows: ['source edit', 'repair', 'planning'],
    versionArgs: ['--version'],
  },
  git: {
    displayName: 'Git',
    command: 'git',
    capabilityTags: ['vcs'],
    usedByWorkflows: ['source edit', 'GitHub issue sync', 'release workflow'],
    versionArgs: ['--version'],
  },
  gh: {
    displayName: 'GitHub CLI',
    command: 'gh',
    capabilityTags: ['github', 'cloud_agent'],
    usedByWorkflows: ['GitHub issue sync', 'release workflow'],
    versionArgs: ['--version'],
  },
  bun: {
    displayName: 'Bun',
    command: 'bun',
    capabilityTags: ['tests', 'runtime'],
    usedByWorkflows: ['tests'],
    versionArgs: ['--version'],
  },
  npm: {
    displayName: 'npm',
    command: 'npm',
    capabilityTags: ['tests', 'package_manager'],
    usedByWorkflows: ['tests', 'release workflow'],
    versionArgs: ['--version'],
  },
  xcodebuild: {
    displayName: 'xcodebuild',
    command: 'xcodebuild',
    capabilityTags: ['ios'],
    usedByWorkflows: ['iOS smoke review'],
    versionArgs: ['-version'],
  },
  xcrun: {
    displayName: 'xcrun',
    command: 'xcrun',
    capabilityTags: ['ios'],
    usedByWorkflows: ['iOS smoke review'],
    versionArgs: ['--version'],
  },
  simctl: {
    displayName: 'simctl',
    command: 'xcrun',
    capabilityTags: ['ios', 'simulator'],
    usedByWorkflows: ['iOS smoke review'],
  },
  playwright: {
    displayName: 'Playwright / browser runtime',
    command: 'npx',
    capabilityTags: ['browser_automation'],
    usedByWorkflows: ['browser automation'],
  },
  app_store_connect: {
    displayName: 'App Store Connect adapter',
    capabilityTags: ['release', 'ios'],
    usedByWorkflows: ['release workflow'],
  },
  gmail_workspace: {
    displayName: 'Gmail / Google Workspace',
    capabilityTags: ['email', 'assistant'],
    usedByWorkflows: ['assistant triage'],
  },
};

function which(command: string, skip?: boolean): string | undefined {
  if (skip) return undefined;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', [command], { encoding: 'utf8', timeout: 2_000 });
      return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    }
    const out = execFileSync('which', [command], { encoding: 'utf8', timeout: 2_000 }).trim();
    return out || undefined;
  } catch {
    for (const prefix of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']) {
      const candidate = `${prefix}/${command}`;
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
}

function versionOf(command: string, args: string[] | undefined, skip?: boolean): string | undefined {
  if (skip || !args) return undefined;
  try {
    const out = execFileSync(command, args, { encoding: 'utf8', timeout: 3_000, maxBuffer: 8_000 });
    return out.trim().split(/\r?\n/)[0]?.slice(0, 120);
  } catch {
    return undefined;
  }
}

export function listLocalTools(options: LocalToolProbeOptions = {}): LocalToolDescriptor[] {
  const config = options.configLocation
    ? readLocalToolConfig(options.configLocation)
    : { tools: [] as Array<{ toolId: string; enabled: boolean }> };
  const at = new Date().toISOString();
  const skip = options.skipExecutableProbe === true;

  return Object.entries(TOOL_META).map(([toolId, meta]) => {
    const mock = options.mockTools?.[toolId];
    if (mock) {
      const enabled = mock.enabled ?? isLocalToolEnabledInConfig(
        options.configLocation ? readLocalToolConfig(options.configLocation) : { schemaVersion: 1, updatedAt: at, tools: [] },
        toolId,
      );
      return {
        toolId,
        displayName: meta.displayName,
        status: mock.status ?? (enabled ? 'detected' : 'disabled'),
        enabled,
        executablePath: mock.executablePath,
        version: mock.version,
        lastHealthCheckAt: mock.lastHealthCheckAt ?? at,
        capabilityTags: meta.capabilityTags,
        usedByWorkflows: meta.usedByWorkflows,
        summary: mock.summary ?? meta.displayName,
        healthOk: mock.healthOk ?? true,
        lastErrorSummary: mock.lastErrorSummary,
      };
    }

    const enabled = options.configLocation
      ? isLocalToolEnabledInConfig(readLocalToolConfig(options.configLocation), toolId)
      : true;

    if (toolId === 'direct_edit') {
      return {
        toolId,
        displayName: meta.displayName,
        status: enabled ? 'detected' : 'disabled',
        enabled,
        lastHealthCheckAt: at,
        capabilityTags: meta.capabilityTags,
        usedByWorkflows: meta.usedByWorkflows,
        summary: enabled
          ? 'Bounded direct edit applied by repo-harness.'
          : 'Direct edit disabled by configuration.',
        healthOk: enabled,
      };
    }

    if (toolId === 'app_store_connect' || toolId === 'gmail_workspace') {
      return {
        toolId,
        displayName: meta.displayName,
        status: enabled ? 'detected' : 'disabled',
        enabled,
        lastHealthCheckAt: at,
        capabilityTags: meta.capabilityTags,
        usedByWorkflows: meta.usedByWorkflows,
        summary: enabled
          ? `${meta.displayName} adapter is managed via plugin configuration (no raw secrets here).`
          : `${meta.displayName} disabled by configuration.`,
        healthOk: enabled,
      };
    }

    if (toolId === 'simctl') {
      const path = which('xcrun', skip);
      const detected = Boolean(path);
      let status: LocalToolDescriptor['status'] = !enabled ? 'disabled' : detected ? 'detected' : 'missing';
      return {
        toolId,
        displayName: meta.displayName,
        status,
        enabled,
        executablePath: path ? `${path} simctl` : undefined,
        lastHealthCheckAt: at,
        capabilityTags: meta.capabilityTags,
        usedByWorkflows: meta.usedByWorkflows,
        summary: !enabled
          ? 'simctl disabled by configuration.'
          : detected
            ? 'xcrun simctl available for iOS simulator workflows.'
            : 'xcrun/simctl not found on PATH.',
        healthOk: enabled && detected,
        lastErrorSummary: !detected && enabled ? 'SIMCTL_MISSING' : undefined,
      };
    }

    if (toolId === 'playwright') {
      // Bounded: do not run playwright install; just note npx availability.
      const path = which('npx', skip) || which('node', skip);
      const detected = Boolean(path);
      return {
        toolId,
        displayName: meta.displayName,
        status: !enabled ? 'disabled' : detected ? 'detected' : 'missing',
        enabled,
        executablePath: path,
        lastHealthCheckAt: at,
        capabilityTags: meta.capabilityTags,
        usedByWorkflows: meta.usedByWorkflows,
        summary: !enabled
          ? 'Browser/Playwright tooling disabled by configuration.'
          : detected
            ? 'Node/npx present; browser plugin still owns target allowlists.'
            : 'Node/npx not found; browser automation may be limited.',
        healthOk: enabled && detected,
      };
    }

    const command = meta.command!;
    const path = which(command, skip);
    const detected = Boolean(path);
    const version = path ? versionOf(path, meta.versionArgs, skip) : undefined;
    return {
      toolId,
      displayName: meta.displayName,
      status: !enabled ? 'disabled' : detected ? 'detected' : 'missing',
      enabled,
      executablePath: path,
      version,
      lastHealthCheckAt: at,
      capabilityTags: meta.capabilityTags,
      usedByWorkflows: meta.usedByWorkflows,
      summary: !enabled
        ? `${meta.displayName} disabled by configuration.`
        : detected
          ? `${meta.displayName} detected${version ? ` (${version})` : ''}.`
          : `${meta.displayName} not found on PATH.`,
      healthOk: enabled && detected,
      lastErrorSummary: !detected && enabled ? `${toolId.toUpperCase()}_MISSING` : undefined,
    };
  });
}

export function getLocalTool(toolId: string, options: LocalToolProbeOptions = {}): LocalToolDescriptor | undefined {
  return listLocalTools(options).find((tool) => tool.toolId === toolId);
}
