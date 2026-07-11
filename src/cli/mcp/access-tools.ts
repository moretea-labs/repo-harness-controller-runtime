import {
  accessModeDescriptor,
  isAccessMode,
  readRepositoryAccessPolicy,
  writeRepositoryAccessPolicy,
} from '../../runtime/control-plane/governance/access-policy';
import {
  persistControllerAccessMode,
  resolveControllerAccessState,
} from './access-mode';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { loadRepositoryRegistry, resolveRepositorySelection } from '../repositories/registry';
import type { CallToolResult, McpToolDefinition } from './tools';

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  readOnlyHint = true,
): McpToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint,
      openWorldHint: false,
      destructiveHint: false,
    },
  };
}

const repoId = { type: 'string', description: 'Stable repository id. Omit when exactly one repository is selected. Cannot be combined with all_repositories.' };

export const accessToolDefinitions: McpToolDefinition[] = [
  definition(
    'rh_access',
    'Always-exposed controller execution policy. Request vs Full Access changes approval behavior only; the MCP tool schema remains stable.',
    {
      operation: {
        type: 'string',
        enum: ['get', 'preview', 'set'],
        description: 'Defaults to get.',
      },
      repo_id: repoId,
      all_repositories: {
        type: 'boolean',
        description: 'When setting access, also update every enabled repository policy to the selected mode.',
      },
      mode: {
        type: 'string',
        enum: ['request', 'full_access'],
        description: 'Target mode for preview or set.',
      },
      confirm_authorization: {
        type: 'boolean',
        description: 'Must be true to change access mode.',
      },
      confirmation_text: {
        type: 'string',
        description: 'Optional compatibility confirmation text. Tool exposure never changes and no reconnect is required.',
      },
    },
    [],
    false,
  ),
  definition(
    'repository_access_get',
    'Read the Request or Full Access permission level for the selected repository.',
    { repo_id: repoId },
  ),
  definition(
    'repository_access_preview',
    'Preview how Request or Full Access changes execution approval behavior. Tool discovery remains unchanged.',
    {
      repo_id: repoId,
      all_repositories: {
        type: 'boolean',
        description: 'Preview the selected mode for every enabled repository policy.',
      },
      mode: {
        type: 'string',
        enum: ['request', 'full_access'],
        description: 'Target access mode.',
      },
    },
  ),
  definition(
    'repository_access_set',
    'Set one or all enabled repository permission levels. Full Access covers local repository work only; remote, destructive, outside-repository, and secret access remain gated.',
    {
      repo_id: repoId,
      all_repositories: {
        type: 'boolean',
        description: 'When true, apply the mode to every enabled registered repository. Cannot be combined with repo_id.',
      },
      mode: {
        type: 'string',
        enum: ['request', 'full_access'],
        description: 'Request asks before elevated local effects. Full Access permits normal local repository work without repeated approval prompts.',
      },
      confirm_authorization: {
        type: 'boolean',
        description: 'Must be true to change repository permission levels.',
      },
      confirmation_text: {
        type: 'string',
        description: 'Optional compatibility confirmation text; explicit confirm_authorization is sufficient.',
      },
    },
    ['mode', 'confirm_authorization'],
    false,
  ),
];

export const accessToolNames = accessToolDefinitions.map((tool) => tool.name);

function selected(ctx: MultiRepositoryMcpToolContext, args: Record<string, unknown>) {
  return resolveRepositorySelection({
    repoId: typeof args.repo_id === 'string' ? args.repo_id : undefined,
    explicitPath: ctx.explicitRepository?.canonicalRoot,
    controllerHome: ctx.controllerHome,
    allowSoleRepository: true,
  });
}

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function accessToolGroups(_mode: 'request' | 'full_access'): string[] {
  // Discovery is intentionally stable across modes. These are availability
  // groups, not automatically-authorized effect groups.
  return [
    'status_and_readiness',
    'repository_selection',
    'approval_and_handoffs',
    'access_control_plane',
    'repository_reads',
    'repository_writes_and_patches',
    'commands_and_checks',
    'git_and_branches',
    'worktrees_and_task_runs',
    'direct_edit_sessions',
    'ios_xcode_and_simulator',
    'screenshots_and_review_artifacts',
  ];
}

function accessStatePayload(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  configured = resolveControllerAccessState({
    controllerHome: ctx.controllerHome,
    repoRoot: ctx.explicitRepository?.canonicalRoot,
  }),
  effective = resolveControllerAccessState({
    controllerHome: ctx.controllerHome,
    repoRoot: ctx.explicitRepository?.canonicalRoot,
    toolsetOverride: ctx.toolset,
    toolsetLocked: ctx.toolsetLocked,
  }),
) {
  const repositoryPolicy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
  return {
    configuredAccessMode: configured.configuredAccessMode,
    effectiveAccessMode: effective.effectiveAccessMode,
    effectiveToolset: effective.effectiveToolset,
    exposureRevision: configured.exposureRevision,
    lastAppliedAt: configured.lastAppliedAt,
    source: effective.source,
    reconnectRequired: false,
    schemaRefreshRequired: false,
    toolSchemaStable: true,
    restartRequired: false,
    repository: {
      repoId: repository.repoId,
      name: repository.displayName,
    },
    repositoryPolicy,
    repositoryPolicyDescriptor: accessModeDescriptor(repositoryPolicy.mode),
    toolGroups: accessToolGroups(effective.effectiveAccessMode),
  };
}

function previewPayload(
  ctx: MultiRepositoryMcpToolContext,
  repository: ReturnType<typeof selected>,
  mode: 'request' | 'full_access',
  applyAll: boolean,
) {
  const currentConfigured = resolveControllerAccessState({
    controllerHome: ctx.controllerHome,
    repoRoot: ctx.explicitRepository?.canonicalRoot,
  });
  const currentEffective = resolveControllerAccessState({
    controllerHome: ctx.controllerHome,
    repoRoot: ctx.explicitRepository?.canonicalRoot,
    toolsetOverride: ctx.toolset,
    toolsetLocked: ctx.toolsetLocked,
  });
  const currentPolicy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
  const currentGroups = accessToolGroups(currentEffective.effectiveAccessMode);
  const nextGroups = accessToolGroups(mode);
  return {
    current: {
      ...accessStatePayload(ctx, repository, currentConfigured, currentEffective),
      toolGroups: currentGroups,
    },
    target: {
      configuredAccessMode: mode,
      effectiveAccessMode: mode,
      effectiveToolset: currentEffective.effectiveToolset,
      exposureRevision: currentConfigured.exposureRevision + (currentConfigured.configuredAccessMode === mode ? 0 : 1),
      source: 'controller_home.access_mode',
      toolGroups: nextGroups,
      repositoryPolicyMode: mode,
      repositoryPolicyDescriptor: accessModeDescriptor(mode),
    },
    changes: {
      modeChanged: currentConfigured.configuredAccessMode !== mode,
      toolsetChanged: false,
      repositoryPolicyWillChange: currentPolicy.mode !== mode,
      addedToolGroups: nextGroups.filter((group) => !currentGroups.includes(group)),
      removedToolGroups: currentGroups.filter((group) => !nextGroups.includes(group)),
      scope: applyAll ? 'all_enabled_repositories' : 'repository',
    },
    reconnectRequired: false,
    schemaRefreshRequired: false,
    toolSchemaStable: true,
    restartRequired: false,
    warning: 'Access mode changes execution approval only. The complete MCP tool schema remains available without reconnecting.',
  };
}

export function callAccessTool(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): CallToolResult | null {
  if (!accessToolNames.includes(name)) return null;
  try {
    if (name === 'rh_access') {
      const operation = args.operation === 'preview' || args.operation === 'set' ? args.operation : 'get';
      const repository = selected(ctx, args);
      if (operation === 'get') return result(accessStatePayload(ctx, repository));

      const mode = args.mode;
      if (!isAccessMode(mode)) {
        return result({
          error: {
            code: 'ACCESS_MODE_INVALID',
            message: 'mode must be request or full_access',
          },
        }, true);
      }

      const applyAll = args.all_repositories === true;
      if (operation === 'preview') return result(previewPayload(ctx, repository, mode, applyAll));

      if (args.confirm_authorization !== true) {
        return result({
          error: {
            code: 'ACCESS_MODE_AUTHORIZATION_REQUIRED',
            message: 'confirm_authorization must be true before changing access mode.',
          },
        }, true);
      }
      const persisted = persistControllerAccessMode(ctx.controllerHome, mode, ctx.explicitRepository?.canonicalRoot);
      if (applyAll) {
        const repositories = loadRepositoryRegistry(ctx.controllerHome).repositories
          .filter((entry) => entry.enabled !== false);
        for (const entry of repositories) writeRepositoryAccessPolicy(ctx.controllerHome, entry.repoId, mode, 'user');
      } else {
        writeRepositoryAccessPolicy(ctx.controllerHome, repository.repoId, mode, 'user');
      }
      const configured = persisted.state;
      const effective = resolveControllerAccessState({
        controllerHome: ctx.controllerHome,
        repoRoot: ctx.explicitRepository?.canonicalRoot,
        toolsetOverride: ctx.toolset,
        toolsetLocked: ctx.toolsetLocked,
      });
      return result({
        ...accessStatePayload(ctx, repository, configured, effective),
        updatedConfigPath: persisted.configPath,
        scope: applyAll ? 'all_enabled_repositories' : 'repository',
        warning: 'Access mode was saved. It affects new execution-policy snapshots immediately; no Connector reconnect or schema refresh is required.',
      });
    }

    if (name === 'repository_access_get') {
      const repository = selected(ctx, args);
      const policy = readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId);
      return result({
        repository: {
          repoId: repository.repoId,
          name: repository.displayName,
        },
        policy,
        descriptor: accessModeDescriptor(policy.mode),
        scope: 'repository',
        storage: 'controllerHome',
      });
    }

    if (name === 'repository_access_preview') {
      const repository = selected(ctx, args);
      const mode = isAccessMode(args.mode) ? args.mode : readRepositoryAccessPolicy(ctx.controllerHome, repository.repoId).mode;
      return result(previewPayload(ctx, repository, mode, args.all_repositories === true));
    }

    const mode = args.mode;
    if (!isAccessMode(mode)) {
      return result({
        error: {
          code: 'ACCESS_MODE_INVALID',
          message: 'mode must be request or full_access',
        },
      }, true);
    }
    if (args.confirm_authorization !== true) {
      return result({
        error: {
          code: 'ACCESS_MODE_AUTHORIZATION_REQUIRED',
          message: 'confirm_authorization must be true before changing repository access.',
        },
      }, true);
    }

    const applyAll = args.all_repositories === true;
    if (applyAll && typeof args.repo_id === 'string' && args.repo_id.trim()) {
      return result({
        error: {
          code: 'ACCESS_MODE_SCOPE_INVALID',
          message: 'repo_id cannot be combined with all_repositories.',
        },
      }, true);
    }

    if (applyAll) {
      const repositories = loadRepositoryRegistry(ctx.controllerHome).repositories
        .filter((repository) => repository.enabled !== false);
      const updated = repositories.map((repository) => ({
        repository: {
          repoId: repository.repoId,
          name: repository.displayName,
        },
        policy: writeRepositoryAccessPolicy(ctx.controllerHome, repository.repoId, mode, 'user'),
      }));
      return result({
        mode,
        descriptor: accessModeDescriptor(mode),
        scope: 'all_enabled_repositories',
        storage: 'controllerHome',
        updatedCount: updated.length,
        repositories: updated,
        reconnectRequired: false,
        schemaRefreshRequired: false,
        toolSchemaStable: true,
        warning: mode === 'full_access'
          ? 'Full Access applies only to local work in each enabled repository. Remote writes, destructive actions, outside-repository paths, and raw secrets remain gated.'
          : 'Request mode is active for every enabled repository; elevated local effects will ask for approval.',
      });
    }

    const repository = selected(ctx, args);
    const policy = writeRepositoryAccessPolicy(ctx.controllerHome, repository.repoId, mode, 'user');
    return result({
      repository: {
        repoId: repository.repoId,
        name: repository.displayName,
      },
      policy,
      descriptor: accessModeDescriptor(policy.mode),
      scope: 'repository',
      storage: 'controllerHome',
      reconnectRequired: false,
      schemaRefreshRequired: false,
      toolSchemaStable: true,
      warning: mode === 'full_access'
        ? 'Full Access applies only to local work in this repository. Remote writes, destructive actions, outside-repository paths, and raw secrets remain gated.'
        : 'Request mode is active; elevated local effects will ask for approval.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result({
      error: {
        code: message.includes(':') ? message.slice(0, message.indexOf(':')) : 'ACCESS_POLICY_FAILED',
        message,
      },
    }, true);
  }
}
