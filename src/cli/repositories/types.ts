export type RepositoryType = 'git' | 'bare' | 'local-git' | 'unknown';
export type RepositoryStateStorageStrategy = 'controller-home' | 'repository-local' | 'hybrid';

export interface GitHubRepositoryMapping {
  owner: string;
  repo: string;
  repository?: string;
  projectOwner?: string;
  projectNumber?: number;
  labels?: string[];
  pluginEnabled?: boolean;
  syncMode?: 'manual' | 'checkpoint';
  includeTasks?: boolean;
  issueSyncEnabled?: boolean;
  cloudAgentSupported?: boolean;
  authenticationCapability?: 'unknown' | 'available' | 'unavailable';
}

export interface RepositoryCheckout {
  checkoutId: string;
  localRoot: string;
  canonicalRoot: string;
  worktree: boolean;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface RepositoryRecord {
  schemaVersion: 1;
  repoId: string;
  displayName: string;
  localRoot: string;
  canonicalRoot: string;
  activeCheckoutId: string;
  checkouts: RepositoryCheckout[];
  remoteUrl?: string;
  canonicalRemote?: string;
  github?: GitHubRepositoryMapping;
  defaultBranch?: string;
  repositoryType: RepositoryType;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  configurationPath: string;
  stateStorageStrategy: RepositoryStateStorageStrategy;
  disabledAt?: string;
  removedAt?: string;
}

export interface RepositoryRegistry {
  schemaVersion: 1;
  repositories: RepositoryRecord[];
  updatedAt: string;
}

export interface RepositorySummary {
  repoId: string;
  displayName: string;
  enabled: boolean;
  localRoot: string;
  canonicalRoot: string;
  checkoutId: string;
  remoteUrl?: string;
  github?: GitHubRepositoryMapping;
  defaultBranch?: string;
  repositoryType: RepositoryType;
  lastSeenAt: string;
  removedAt?: string;
}

export interface RepositoryValidation {
  repoId: string;
  checkoutId: string;
  ok: boolean;
  rootExists: boolean;
  gitRepository: boolean;
  identityMatches: boolean;
  canonicalRoot: string;
  canonicalRemote?: string;
  errors: string[];
  warnings: string[];
  checkedAt: string;
}

export interface EntityMigrationReport {
  repoId: string;
  checkoutId: string;
  scanned: number;
  updated: number;
  unresolved: number;
  files: string[];
  errors: Array<{ path: string; error: string }>;
}
