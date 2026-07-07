export type RepositoryType = 'git' | 'bare' | 'local-git' | 'unknown';
export type RepositoryStateStorageStrategy = 'controller-home' | 'repository-local' | 'hybrid';
export type LocalProjectBootstrapMode = 'init_git_only' | 'init_git_and_register' | 'replace_registration';

export interface GitHubRepositoryMapping {
  owner: string;
  repo: string;
  repository?: string;
  projectOwner?: string;
  projectNumber?: number;
  statusField?: string;
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
  registryCanonicalRemote?: string;
  githubRemoteRepository?: string;
  githubMappingMatches?: boolean;
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

export interface LocalProjectCandidate {
  path: string;
  canonicalPath?: string;
  name: string;
  family: string;
  exists: boolean;
  hasGit: boolean;
  markerKinds: string[];
  markerPaths: string[];
  visibleEntryCount: number;
  fileCount: number;
  recentActivityAt?: string;
  stale: boolean;
  staleReasons: string[];
  score: number;
  repoId?: string;
  displayName?: string;
  recommended: boolean;
}

export interface LocalProjectLatestSourceDiagnosis {
  inputPath: string;
  family: string;
  repoId?: string;
  noMutation: true;
  candidates: LocalProjectCandidate[];
  recommendedPath?: string;
  recommendedRepoId?: string;
  warnings: string[];
}

export interface LocalProjectBootstrapResult {
  path: string;
  mode: LocalProjectBootstrapMode;
  createdGit: boolean;
  createdGitignore: boolean;
  idempotent: boolean;
  markers: string[];
  markerPaths: string[];
  repository?: RepositoryRecord;
  replacedRegistration?: {
    repoId: string;
    previousCanonicalRoot: string;
    previousCheckoutId: string;
  };
  next: string;
}
