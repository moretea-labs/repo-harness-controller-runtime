import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';

export const ACCESS_MODES = ['request', 'full_access'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

declare module '../facade/types' {
  interface WorkContractConstraints {
    /** Permission snapshot captured when the work starts. Defaults to request. */
    accessMode?: AccessMode;
  }
}

export type AccessEffect =
  | 'read'
  | 'local_repo_write'
  | 'workspace_write'
  | 'local_command'
  | 'dependency_change'
  | 'local_git'
  | 'external_network'
  | 'remote_write'
  | 'destructive'
  | 'secret_access'
  | 'outside_repository';

export type AccessDecision = 'allow' | 'request' | 'deny';

export interface RepositoryAccessPolicy {
  schemaVersion: 1;
  repoId: string;
  mode: AccessMode;
  updatedAt: string;
  updatedBy: 'user' | 'system';
}

export interface AccessModeDescriptor {
  mode: AccessMode;
  label: string;
  shortLabel: string;
  description: string;
  automaticallyAllowed: string[];
  stillRequiresApproval: string[];
  alwaysDenied: string[];
}

export const ACCESS_MODE_DESCRIPTORS: Record<AccessMode, AccessModeDescriptor> = {
  request: {
    mode: 'request',
    label: 'Request — 需要时请求权限',
    shortLabel: 'Request',
    description: '在当前仓库的安全边界内执行；命令、依赖、本地 Git 或其他提升权限的动作会先请求确认。',
    automaticallyAllowed: ['读取和搜索当前仓库', '受控路径内的小范围修改', '已注册的检查和只读诊断'],
    stillRequiresApproval: ['任意本地命令', '安装或更新依赖', '本地 Git 写操作', '网络和远程写入'],
    alwaysDenied: ['读取原始密钥或凭据', '绕过 controller 策略'],
  },
  full_access: {
    mode: 'full_access',
    label: 'Full Access — 当前仓库完全访问',
    shortLabel: 'Full Access',
    description: '允许在当前仓库内编辑文件、运行本地命令、调整依赖和执行本地 Git；远程、破坏性和密钥操作仍需审批或保持禁止。',
    automaticallyAllowed: ['当前仓库内文件读写', '仓库范围本地命令', '依赖变更', '本地 Git 和检查'],
    stillRequiresApproval: ['仓库外路径', '外部网络访问', 'Git push 或远程服务写入', '不可逆或破坏性操作'],
    alwaysDenied: ['读取原始密钥或凭据', '直接修改 controllerHome 安全状态', '绕过 managed policy'],
  },
};

export function isAccessMode(value: unknown): value is AccessMode {
  return value === 'request' || value === 'full_access';
}

export function normalizeAccessMode(value: unknown, fallback: AccessMode = 'request'): AccessMode {
  return isAccessMode(value) ? value : fallback;
}

export function repositoryAccessPolicyPath(controllerHome: string, repoId: string): string {
  return join(resolve(controllerHome), 'repositories', repoId, 'controller', 'access-policy.json');
}

function defaultPolicy(repoId: string): RepositoryAccessPolicy {
  return {
    schemaVersion: 1,
    repoId,
    mode: 'request',
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'system',
  };
}

export function readRepositoryAccessPolicy(controllerHome: string, repoId: string): RepositoryAccessPolicy {
  const path = repositoryAccessPolicyPath(controllerHome, repoId);
  if (!existsSync(path)) return defaultPolicy(repoId);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RepositoryAccessPolicy>;
    return {
      schemaVersion: 1,
      repoId,
      mode: normalizeAccessMode(parsed.mode),
      updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date(0).toISOString(),
      updatedBy: parsed.updatedBy === 'user' ? 'user' : 'system',
    };
  } catch {
    return defaultPolicy(repoId);
  }
}

export function writeRepositoryAccessPolicy(
  controllerHome: string,
  repoId: string,
  mode: AccessMode,
  updatedBy: RepositoryAccessPolicy['updatedBy'] = 'user',
): RepositoryAccessPolicy {
  const path = repositoryAccessPolicyPath(controllerHome, repoId);
  mkdirSync(dirname(path), { recursive: true });
  const policy: RepositoryAccessPolicy = {
    schemaVersion: 1,
    repoId,
    mode,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, path);
  return policy;
}

export function evaluateAccessMode(mode: AccessMode, effect: AccessEffect): AccessDecision {
  if (effect === 'read') return 'allow';
  if (effect === 'secret_access') return 'deny';

  if (mode === 'full_access') {
    if (
      effect === 'local_repo_write'
      || effect === 'workspace_write'
      || effect === 'local_command'
      || effect === 'dependency_change'
      || effect === 'local_git'
    ) {
      return 'allow';
    }
  }

  return 'request';
}

export function accessModeDescriptor(mode: AccessMode): AccessModeDescriptor {
  return ACCESS_MODE_DESCRIPTORS[mode];
}
