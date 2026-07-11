import {
  accessModeDescriptor,
  isAccessMode,
  readRepositoryAccessPolicy,
  writeRepositoryAccessPolicy,
} from '../../runtime/control-plane/governance/access-policy';
import type { MultiRepositoryMcpToolContext } from './multi-repository';
import { resolveRepositorySelection } from '../repositories/registry';
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

const repoId = { type: 'string', description: 'Stable repository id. Omit when exactly one repository is selected.' };

export const accessToolDefinitions: McpToolDefinition[] = [
  definition(
    'repository_access_get',
    'Read the Request or Full Access permission level for the selected repository.',
    { repo_id: repoId },
  ),
  definition(
    'repository_access_set',
    'Set the selected repository permission level. Full Access covers local repository work only; remote, destructive, outside-repository, and secret access remain gated.',
    {
      repo_id: repoId,
      mode: {
        type: 'string',
        enum: ['request', 'full_access'],
        description: 'Request asks before elevated local effects. Full Access permits normal local repository work without repeated approval prompts.',
      },
      confirm_authorization: {
        type: 'boolean',
        description: 'Must be true to change the repository permission level.',
      },
      confirmation_text: {
        type: 'string',
        description: 'Required when enabling Full Access; must equal enable-full-access.',
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
    const repository = selected(ctx, args);
    if (name === 'repository_access_get') {
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
    if (mode === 'full_access' && args.confirmation_text !== 'enable-full-access') {
      return result({
        error: {
          code: 'FULL_ACCESS_STRONG_CONFIRMATION_REQUIRED',
          message: 'confirmation_text must equal enable-full-access.',
        },
      }, true);
    }

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
