import {
  accessModeDescriptor,
  isAccessMode,
  readRepositoryAccessPolicy,
  writeRepositoryAccessPolicy,
} from '../../runtime/control-plane/governance/access-policy';
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
    'repository_access_get',
    'Read the Request or Full Access permission level for the selected repository.',
    { repo_id: repoId },
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
        description: 'Required when enabling Full Access: enable-full-access for one repository or enable-full-access-all for all enabled repositories.',
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

export function callAccessTool(
  ctx: MultiRepositoryMcpToolContext,
  name: string,
  args: Record<string, unknown>,
): CallToolResult | null {
  if (!accessToolNames.includes(name)) return null;
  try {
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

    const requiredConfirmation = applyAll ? 'enable-full-access-all' : 'enable-full-access';
    if (mode === 'full_access' && args.confirmation_text !== requiredConfirmation) {
      return result({
        error: {
          code: 'FULL_ACCESS_STRONG_CONFIRMATION_REQUIRED',
          message: `confirmation_text must equal ${requiredConfirmation}.`,
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
