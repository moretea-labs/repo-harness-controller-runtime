import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { getRepository, loadRepositoryRegistry, registerRepository } from './registry';
import type {
  LocalProjectBootstrapMode,
  LocalProjectBootstrapResult,
  LocalProjectCandidate,
  LocalProjectLatestSourceDiagnosis,
  RepositoryRecord,
} from './types';

const MAX_SCAN_DEPTH = 2;
const MAX_SCAN_ENTRIES = 2_000;
const IGNORED_SCAN_NAMES = new Set([
  '.git',
  'node_modules',
  'DerivedData',
  '.build',
  '.swiftpm',
  '.idea',
  '.vscode',
]);
const SOURCE_DIRECTORY_NAMES = new Set([
  'app',
  'apps',
  'resources',
  'scripts',
  'shared',
  'source',
  'sources',
  'src',
  'test',
  'tests',
  'widget',
  'widgets',
]);

function now(): string {
  return new Date().toISOString();
}

function absolutePathRequired(path: unknown): string {
  const value = String(path ?? '').trim();
  if (!value) throw new Error('LOCAL_PROJECT_PATH_REQUIRED: path is required');
  if (!value.startsWith('/')) throw new Error('LOCAL_PROJECT_PATH_ABSOLUTE_REQUIRED: path must be an absolute local path');
  return value;
}

function userHome(): string | undefined {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? resolve(home) : undefined;
}

function denySensitivePath(canonicalPath: string): string | undefined {
  const normalized = resolve(canonicalPath);
  const sensitiveExact = new Set([
    '/',
    '/Applications',
    '/Library',
    '/System',
    '/Users',
    '/etc',
    '/home',
    '/private/etc',
    '/private/var',
    '/var',
  ]);
  if (sensitiveExact.has(normalized)) return 'path is too broad or system-owned';
  const home = userHome();
  if (home && normalized === home) return 'path is the entire user home';
  const lower = normalized.toLowerCase();
  const sensitiveFragments = [
    '/.aws',
    '/.config/gcloud',
    '/.gnupg',
    '/.kube',
    '/.ssh',
    '/library/application support/com.apple',
    '/library/keychains',
    '/library/mail',
    '/library/messages',
  ];
  if (sensitiveFragments.some((fragment) => lower.includes(fragment))) {
    return 'path appears to contain credentials or personal application data';
  }
  return undefined;
}

function normalizeFamilyKey(name: string): string {
  const trimmedVersion = name
    .toLowerCase()
    .replace(/\.(xcodeproj|xcworkspace)$/g, '')
    .trim()
    .replace(/[\s._-]+(?:v(?:ersion)?[\s._-]*)?\d+(?:[\s._-]+\d+)*(?:[\s._-]*(?:beta|rc)\d*)?$/i, '')
    .replace(/[\s._-]+/g, ' ')
    .trim();
  const collapsed = trimmedVersion.replace(/[^a-z0-9]+/g, '');
  return collapsed || name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scanTreeMetrics(root: string): { fileCount: number; latestMtimeMs: number } {
  let fileCount = 0;
  let latestMtimeMs = 0;
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES) {
    const current = queue.shift();
    if (!current) break;
    scanned += 1;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED_SCAN_NAMES.has(entry.name)) continue;
      const absolute = join(current.path, entry.name);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      latestMtimeMs = Math.max(latestMtimeMs, stats.mtimeMs);
      fileCount += 1;
      if (entry.isDirectory() && current.depth < MAX_SCAN_DEPTH) {
        queue.push({ path: absolute, depth: current.depth + 1 });
      }
    }
  }
  return { fileCount, latestMtimeMs };
}

function collectMarkers(root: string): { markerKinds: string[]; markerPaths: string[]; visibleEntryCount: number } {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { markerKinds: [], markerPaths: [], visibleEntryCount: 0 };
  }
  const markerKinds = new Set<string>();
  const markerPaths = new Set<string>();
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith('.'));

  for (const entry of entries) {
    const name = entry.name;
    const lower = name.toLowerCase();
    if (entry.isDirectory()) {
      if (lower.endsWith('.xcodeproj')) {
        markerKinds.add('xcodeproj');
        markerPaths.add(name);
      } else if (lower.endsWith('.xcworkspace')) {
        markerKinds.add('xcworkspace');
        markerPaths.add(name);
      } else if (SOURCE_DIRECTORY_NAMES.has(lower)) {
        markerKinds.add('source-directory');
        markerPaths.add(name);
      }
    } else if (entry.isFile()) {
      if (name === 'Package.swift') {
        markerKinds.add('package-swift');
        markerPaths.add(name);
      } else if (/^readme(?:\..+)?$/i.test(name)) {
        markerKinds.add('readme');
        markerPaths.add(name);
      } else if (/^(build|archive)\.sh$/i.test(name)) {
        markerKinds.add('build-script');
        markerPaths.add(name);
      } else if (/(release|changelog|milestone|version)/i.test(name)) {
        markerKinds.add('release-notes');
        markerPaths.add(name);
      }
    }
  }

  return {
    markerKinds: [...markerKinds].sort(),
    markerPaths: [...markerPaths].sort(),
    visibleEntryCount: visibleEntries.length,
  };
}

function candidateScore(input: {
  hasGit: boolean;
  markerKinds: string[];
  fileCount: number;
  visibleEntryCount: number;
  staleReasons: string[];
}): number {
  let score = 0;
  if (input.hasGit) score += 25;
  if (input.markerKinds.includes('xcodeproj')) score += 20;
  if (input.markerKinds.includes('xcworkspace')) score += 18;
  if (input.markerKinds.includes('package-swift')) score += 14;
  if (input.markerKinds.includes('readme')) score += 10;
  if (input.markerKinds.includes('build-script')) score += 8;
  if (input.markerKinds.includes('source-directory')) score += 12;
  if (input.markerKinds.includes('release-notes')) score += 6;
  if (input.visibleEntryCount >= 4) score += 8;
  if (input.visibleEntryCount >= 8) score += 8;
  if (input.fileCount >= 20) score += 10;
  if (input.fileCount >= 80) score += 10;
  if (input.staleReasons.length > 0) score -= Math.min(30, input.staleReasons.length * 12);
  return score;
}

function candidateRegistration(records: RepositoryRecord[], canonicalRoot: string): { repoId?: string; displayName?: string } {
  for (const record of records) {
    const roots = [
      record.canonicalRoot,
      ...record.checkouts.map((checkout) => checkout.canonicalRoot),
    ];
    if (roots.some((root) => root === canonicalRoot)) {
      return { repoId: record.repoId, displayName: record.displayName };
    }
  }
  return {};
}

function inspectCandidate(path: string, records: RepositoryRecord[]): LocalProjectCandidate {
  const resolvedPath = resolve(path);
  const exists = existsSync(resolvedPath);
  const name = basename(resolvedPath);
  const family = normalizeFamilyKey(name);
  if (!exists) {
    return {
      path: resolvedPath,
      name,
      family,
      exists: false,
      hasGit: false,
      markerKinds: [],
      markerPaths: [],
      visibleEntryCount: 0,
      fileCount: 0,
      stale: true,
      staleReasons: ['path does not exist'],
      score: 0,
      recommended: false,
    };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedPath);
  } catch {
    canonicalRoot = resolvedPath;
  }
  const stats = statSync(canonicalRoot);
  if (!stats.isDirectory()) {
    return {
      path: resolvedPath,
      canonicalPath: canonicalRoot,
      name,
      family,
      exists: true,
      hasGit: false,
      markerKinds: [],
      markerPaths: [],
      visibleEntryCount: 0,
      fileCount: 0,
      stale: true,
      staleReasons: ['path is not a directory'],
      score: 0,
      recommended: false,
    };
  }

  const entries = readdirSync(canonicalRoot, { withFileTypes: true });
  const hasGit = entries.some((entry) => entry.name === '.git');
  const markers = collectMarkers(canonicalRoot);
  const metrics = scanTreeMetrics(canonicalRoot);
  const staleReasons: string[] = [];
  if (markers.visibleEntryCount === 0) staleReasons.push('directory only contains hidden metadata');
  if (markers.markerKinds.length === 0) staleReasons.push('no project markers detected');
  if (metrics.fileCount <= 2) staleReasons.push('tree is unusually small');
  const registration = candidateRegistration(records, canonicalRoot);
  const score = candidateScore({
    hasGit,
    markerKinds: markers.markerKinds,
    fileCount: metrics.fileCount,
    visibleEntryCount: markers.visibleEntryCount,
    staleReasons,
  });

  return {
    path: resolvedPath,
    canonicalPath: canonicalRoot,
    name,
    family,
    exists: true,
    hasGit,
    markerKinds: markers.markerKinds,
    markerPaths: markers.markerPaths,
    visibleEntryCount: markers.visibleEntryCount,
    fileCount: metrics.fileCount,
    recentActivityAt: metrics.latestMtimeMs > 0 ? new Date(metrics.latestMtimeMs).toISOString() : undefined,
    stale: staleReasons.length > 0,
    staleReasons,
    score,
    repoId: registration.repoId,
    displayName: registration.displayName,
    recommended: false,
  };
}

function siblingCandidates(path: string): string[] {
  const parent = dirname(resolve(path));
  if (!existsSync(parent)) return [resolve(path)];
  const referenceName = basename(resolve(path));
  const family = normalizeFamilyKey(referenceName);
  const related: string[] = [resolve(path)];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidateFamily = normalizeFamilyKey(entry.name);
    if (!candidateFamily || candidateFamily !== family) continue;
    related.push(join(parent, entry.name));
  }
  return [...new Set(related)];
}

function sortCandidates(candidates: LocalProjectCandidate[]): LocalProjectCandidate[] {
  return [...candidates].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.markerKinds.length !== left.markerKinds.length) return right.markerKinds.length - left.markerKinds.length;
    if (right.fileCount !== left.fileCount) return right.fileCount - left.fileCount;
    const leftRecent = left.recentActivityAt ? Date.parse(left.recentActivityAt) : 0;
    const rightRecent = right.recentActivityAt ? Date.parse(right.recentActivityAt) : 0;
    if (rightRecent !== leftRecent) return rightRecent - leftRecent;
    return left.path.localeCompare(right.path);
  });
}

function parseBootstrapMode(value: unknown): LocalProjectBootstrapMode {
  if (value === undefined || value === null || value === '') return 'init_git_and_register';
  if (value === 'init_git_only' || value === 'init_git_and_register' || value === 'replace_registration') {
    return value;
  }
  throw new Error(`LOCAL_PROJECT_BOOTSTRAP_MODE_INVALID: ${String(value)}`);
}

function ensureSafeDirectory(path: unknown): string {
  const input = absolutePathRequired(path);
  if (!existsSync(input)) throw new Error(`LOCAL_PROJECT_PATH_MISSING: ${input}`);
  const canonical = realpathSync(input);
  const denied = denySensitivePath(canonical);
  if (denied) throw new Error(`LOCAL_PROJECT_PATH_DENIED: ${denied}`);
  const stats = statSync(canonical);
  if (!stats.isDirectory()) throw new Error(`LOCAL_PROJECT_DIRECTORY_REQUIRED: ${canonical}`);
  return canonical;
}

function detectNestedGit(root: string): string | undefined {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES) {
    const current = queue.shift();
    if (!current) break;
    scanned += 1;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' && current.path !== root) {
        return relative(root, current.path).replace(/\\/g, '/');
      }
      if (!entry.isDirectory()) continue;
      if (IGNORED_SCAN_NAMES.has(entry.name)) continue;
      if (current.depth >= MAX_SCAN_DEPTH) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  return undefined;
}

function ensureProjectMarkers(candidate: LocalProjectCandidate): void {
  if (candidate.markerKinds.length > 0) return;
  throw new Error('LOCAL_PROJECT_MARKERS_REQUIRED: no project markers were detected; refusing to bootstrap an arbitrary directory');
}

function ensureGitInitialized(root: string, defaultBranch?: string): boolean {
  if (existsSync(join(root, '.git'))) return false;
  const branch = defaultBranch?.trim() || 'main';
  const init = spawnSync('git', ['-C', root, 'init', '-q', '-b', branch], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (init.status !== 0) {
    const fallback = spawnSync('git', ['-C', root, 'init', '-q'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (fallback.status !== 0) {
      throw new Error(`LOCAL_PROJECT_GIT_INIT_FAILED: ${(fallback.stderr || init.stderr || 'git init failed').trim()}`);
    }
    if (branch && branch !== 'master') {
      const branchResult = spawnSync('git', ['-C', root, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (branchResult.status !== 0) {
        throw new Error(`LOCAL_PROJECT_GIT_INIT_FAILED: ${(branchResult.stderr || 'failed to set default branch').trim()}`);
      }
    }
  }
  return true;
}

function defaultGitignore(candidate: LocalProjectCandidate): string {
  const lines = new Set<string>([
    '.DS_Store',
    '.idea/',
    '.vscode/',
  ]);
  if (candidate.markerKinds.includes('xcodeproj') || candidate.markerKinds.includes('xcworkspace')) {
    lines.add('DerivedData/');
    lines.add('*.xcuserstate');
    lines.add('xcuserdata/');
  }
  if (candidate.markerKinds.includes('package-swift')) {
    lines.add('.build/');
    lines.add('.swiftpm/');
  }
  return `${[...lines].sort().join('\n')}\n`;
}

function ensureGitignore(root: string, candidate: LocalProjectCandidate): boolean {
  const gitignorePath = join(root, '.gitignore');
  if (existsSync(gitignorePath)) return false;
  writeFileSync(gitignorePath, defaultGitignore(candidate), 'utf-8');
  return true;
}

export function diagnoseLatestLocalProjectSource(input: {
  path?: string;
  repoId?: string;
  controllerHome?: string;
}): LocalProjectLatestSourceDiagnosis {
  const records = loadRepositoryRegistry(input.controllerHome).repositories;
  const referencePath = input.repoId
    ? getRepository(String(input.repoId).trim(), input.controllerHome, { includeRemoved: true }).canonicalRoot
    : absolutePathRequired(input.path);
  const candidates = sortCandidates(
    siblingCandidates(referencePath).map((path) => inspectCandidate(path, records)),
  );
  if (candidates[0]) candidates[0].recommended = true;
  const recommended = candidates[0];
  const requested = candidates.find((candidate) => candidate.path === resolve(referencePath));
  const warnings: string[] = [];
  if (requested?.stale && recommended && recommended.path !== requested.path) {
    warnings.push(`Requested path looks stale; ${recommended.path} is the richer sibling source tree.`);
  }
  if (requested?.repoId && recommended?.path !== requested.path) {
    warnings.push(`Registered repo ${requested.repoId} does not point at the highest-scoring sibling source.`);
  }
  return {
    inputPath: resolve(referencePath),
    family: normalizeFamilyKey(basename(referencePath)),
    repoId: input.repoId?.trim() || requested?.repoId,
    noMutation: true,
    candidates,
    recommendedPath: recommended?.path,
    recommendedRepoId: recommended?.repoId,
    warnings,
  };
}

export function bootstrapLocalProject(input: {
  path: string;
  controllerHome?: string;
  displayName?: string;
  defaultBranch?: string;
  mode?: LocalProjectBootstrapMode;
  replaceRegisteredRepoId?: string;
  confirmAuthorization?: boolean;
}): LocalProjectBootstrapResult {
  if (input.confirmAuthorization !== true) {
    throw new Error('LOCAL_PROJECT_BOOTSTRAP_AUTHORIZATION_REQUIRED: confirmAuthorization=true is required');
  }
  const mode = parseBootstrapMode(input.mode);
  const canonicalRoot = ensureSafeDirectory(input.path);
  const nestedGit = detectNestedGit(canonicalRoot);
  if (!existsSync(join(canonicalRoot, '.git')) && nestedGit) {
    throw new Error(`LOCAL_PROJECT_NESTED_GIT_DENIED: found nested .git under ${nestedGit}`);
  }

  const records = loadRepositoryRegistry(input.controllerHome).repositories;
  const candidate = inspectCandidate(canonicalRoot, records);
  ensureProjectMarkers(candidate);

  const replaceRegisteredRepoId = input.replaceRegisteredRepoId?.trim() || undefined;
  const previousRecord = replaceRegisteredRepoId
    ? getRepository(replaceRegisteredRepoId, input.controllerHome, { includeRemoved: true })
    : undefined;
  const createdGit = ensureGitInitialized(canonicalRoot, input.defaultBranch);
  const createdGitignore = ensureGitignore(canonicalRoot, candidate);

  const result: LocalProjectBootstrapResult = {
    path: canonicalRoot,
    mode,
    createdGit,
    createdGitignore,
    idempotent: !createdGit && !createdGitignore,
    markers: candidate.markerKinds,
    markerPaths: candidate.markerPaths,
    repository: undefined,
    replacedRegistration: previousRecord ? {
      repoId: previousRecord.repoId,
      previousCanonicalRoot: previousRecord.canonicalRoot,
      previousCheckoutId: previousRecord.activeCheckoutId,
    } : undefined,
    next: mode === 'init_git_only'
      ? 'Repository metadata was not registered; run bootstrap again in init_git_and_register mode to register it.'
      : 'Repository is ready for normal repo-harness workflows.',
  };

  if (mode === 'init_git_only') return result;

  const repository = registerRepository({
    path: canonicalRoot,
    controllerHome: input.controllerHome,
    displayName: input.displayName,
    defaultBranch: input.defaultBranch,
    repoIdOverride: replaceRegisteredRepoId,
  });
  result.repository = repository;
  result.idempotent = result.idempotent &&
    repository.canonicalRoot === canonicalRoot &&
    repository.checkouts.filter((checkout) => checkout.canonicalRoot === canonicalRoot).length === 1;
  if (mode === 'replace_registration' && previousRecord && previousRecord.canonicalRoot !== canonicalRoot) {
    result.next = `Registration ${previousRecord.repoId} now points at ${canonicalRoot}; previous checkout history was preserved.`;
  }
  return result;
}
