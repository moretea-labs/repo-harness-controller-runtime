import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import type { RepositoryRecord } from '../../cli/repositories/types';
import { iosProjectDiscover, iosSimulatorScreenshot } from './ios-development';

export interface ReviewArtifactEntry {
  path: string;
  kind: 'browser_screenshot' | 'ios_screenshot' | 'log' | 'report' | 'other';
  bytes: number;
  updatedAt: string;
}

export interface ReviewArtifactIndex {
  repoId: string;
  generatedAt: string;
  artifactRoots: string[];
  artifacts: ReviewArtifactEntry[];
  missingRoots: string[];
  next: string[];
}

export interface BrowserReviewPacket {
  repoId: string;
  generatedAt: string;
  source: 'browser';
  artifacts: ReviewArtifactEntry[];
  ready: boolean;
  next: string[];
}

export interface IosReviewPacket {
  repoId: string;
  generatedAt: string;
  source: 'ios';
  project: ReturnType<typeof iosProjectDiscover>;
  screenshot?: unknown;
  artifacts: ReviewArtifactEntry[];
  ready: boolean;
  next: string[];
}

function now(): string {
  return new Date().toISOString();
}

function repoRel(repository: RepositoryRecord, absolute: string): string {
  const root = resolve(repository.canonicalRoot);
  const rel = relative(root, resolve(absolute));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('REVIEW_ARTIFACT_OUTSIDE_REPOSITORY');
  return rel.replace(/\\/g, '/');
}

function roots(repository: RepositoryRecord): Array<{ path: string; kind: ReviewArtifactEntry['kind'] }> {
  const root = repository.canonicalRoot;
  return [
    { path: join(root, '.repo-harness/browser/screenshots'), kind: 'browser_screenshot' },
    { path: join(root, '.repo-harness/ios/screenshots'), kind: 'ios_screenshot' },
    { path: join(root, '.repo-harness/ios/logs'), kind: 'log' },
    { path: join(root, '.repo-harness/ios/build-reports'), kind: 'report' },
    { path: join(root, '.repo-harness/review-artifacts'), kind: 'other' },
  ];
}

function scanDir(repository: RepositoryRecord, root: string, kind: ReviewArtifactEntry['kind'], limit: number): ReviewArtifactEntry[] {
  if (!existsSync(root)) return [];
  const entries: ReviewArtifactEntry[] = [];
  function visit(dir: string, depth: number): void {
    if (depth > 3 || entries.length >= limit) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile()) {
        const stat = statSync(absolute);
        entries.push({ path: repoRel(repository, absolute), kind, bytes: stat.size, updatedAt: stat.mtime.toISOString() });
      }
      if (entries.length >= limit) break;
    }
  }
  visit(root, 0);
  return entries;
}

export function buildReviewArtifactIndex(repository: RepositoryRecord, input: { limit?: unknown } = {}): ReviewArtifactIndex {
  const limit = Math.max(1, Math.min(typeof input.limit === 'number' ? Math.trunc(input.limit) : 60, 200));
  const configuredRoots = roots(repository);
  const artifacts = configuredRoots.flatMap((entry) => scanDir(repository, entry.path, entry.kind, limit))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
  const missingRoots = configuredRoots.filter((entry) => !existsSync(entry.path)).map((entry) => repoRel(repository, entry.path));
  const next = [
    ...(artifacts.length === 0 ? ['Capture a browser or iOS screenshot before requesting visual review.'] : []),
    ...(missingRoots.length > 0 ? ['Missing artifact roots are expected until the corresponding safe-tooling action runs.'] : []),
  ];
  return { repoId: repository.repoId, generatedAt: now(), artifactRoots: configuredRoots.map((entry) => repoRel(repository, entry.path)), artifacts, missingRoots, next };
}

export function prepareBrowserReviewPacket(repository: RepositoryRecord, input: { limit?: unknown } = {}): BrowserReviewPacket {
  const index = buildReviewArtifactIndex(repository, input);
  const artifacts = index.artifacts.filter((entry) => entry.kind === 'browser_screenshot');
  return {
    repoId: repository.repoId,
    generatedAt: now(),
    source: 'browser',
    artifacts,
    ready: artifacts.length > 0,
    next: artifacts.length > 0
      ? ['Review the most recent browser screenshot with its source URL/title from the browser plugin action output.']
      : ['Run the browser plugin screenshot/open_page action first; screenshots are indexed from .repo-harness/browser/screenshots.'],
  };
}

export function prepareIosReviewPacket(repository: RepositoryRecord, input: { udid?: unknown; label?: unknown; capture?: unknown; limit?: unknown } = {}): IosReviewPacket {
  const project = iosProjectDiscover(repository);
  const screenshot = input.capture === true && typeof input.udid === 'string'
    ? iosSimulatorScreenshot(repository, { udid: input.udid, label: typeof input.label === 'string' ? input.label : 'review' })
    : undefined;
  const index = buildReviewArtifactIndex(repository, input);
  const artifacts = index.artifacts.filter((entry) => entry.kind === 'ios_screenshot' || entry.kind === 'log' || entry.kind === 'report');
  const ready = project.ready && (artifacts.length > 0 || Boolean(screenshot && typeof screenshot === 'object' && 'ready' in screenshot && screenshot.ready === true));
  const next = [
    ...(project.ready ? [] : ['No Xcode project/workspace/Package.swift was discovered in this repository.']),
    ...(ready ? ['Use the indexed screenshots/logs as the visual review input.'] : ['Capture an iOS simulator screenshot with capture=true and a booted simulator UDID.']),
  ];
  return { repoId: repository.repoId, generatedAt: now(), source: 'ios', project, screenshot, artifacts, ready, next };
}

export function ensureReviewArtifactRoots(repository: RepositoryRecord): { repoId: string; roots: string[] } {
  const created = roots(repository).map((entry) => {
    mkdirSync(entry.path, { recursive: true });
    return repoRel(repository, entry.path);
  });
  return { repoId: repository.repoId, roots: created };
}
