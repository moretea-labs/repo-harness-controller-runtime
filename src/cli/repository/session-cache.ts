import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { runProcess } from '../../effects/process-runner';

export interface SessionCacheMetrics {
  cacheHit: number;
  cacheMiss: number;
  bytesAvoided: number;
  scanAvoided: number;
  invalidations: number;
}

export interface SessionIdentity {
  repoId: string;
  checkoutId: string;
  branch: string | null;
  head: string | null;
  workingTreeFingerprint: string;
}

export interface FileRangeCacheEntry {
  path: string;
  fileSha: string;
  startLine: number;
  endLine: number;
  content: string;
  totalLines: number;
  bytes: number;
}

export interface SearchCacheEntry {
  query: string;
  includeKey: string;
  result: unknown;
  scannedFiles: number;
}

export interface SessionCacheSnapshot {
  identity: SessionIdentity;
  metrics: SessionCacheMetrics;
  fileCount: number;
  searchCount: number;
}

function shaText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fileShaOf(absolutePath: string): string | null {
  try {
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null;
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  } catch {
    return null;
  }
}

function gitText(repoRoot: string, args: string[]): string | null {
  const result = runProcess('git', ['-C', repoRoot, ...args], {
    timeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
  });
  return result.ok ? result.stdout.trim() || null : null;
}

export function computeWorkingTreeFingerprint(repoRoot: string): string {
  const status = gitText(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']) ?? '';
  const head = gitText(repoRoot, ['rev-parse', 'HEAD']) ?? 'no-head';
  const branch = gitText(repoRoot, ['branch', '--show-current']) ?? 'detached';
  return shaText(`${head}\n${branch}\n${status}`).slice(0, 24);
}

export function collectSessionIdentity(input: {
  repoRoot: string;
  repoId: string;
  checkoutId: string;
}): SessionIdentity {
  const root = resolve(input.repoRoot);
  return {
    repoId: input.repoId,
    checkoutId: input.checkoutId,
    branch: gitText(root, ['branch', '--show-current']),
    head: gitText(root, ['rev-parse', 'HEAD']),
    workingTreeFingerprint: computeWorkingTreeFingerprint(root),
  };
}

function rangeKey(path: string, start: number, end: number): string {
  return `${path}:${start}-${end}`;
}

export class RepositorySessionCache {
  private identity: SessionIdentity;
  private readonly repoRoot: string;
  private readonly fileSha = new Map<string, string>();
  private readonly ranges = new Map<string, FileRangeCacheEntry>();
  private readonly searches = new Map<string, SearchCacheEntry>();
  private readonly gitSnapshots = new Map<string, { at: number; value: unknown }>();
  private readonly checks = new Map<string, unknown>();
  private runtimeGeneration?: string;
  private activeSlot?: string;
  private metrics: SessionCacheMetrics = {
    cacheHit: 0,
    cacheMiss: 0,
    bytesAvoided: 0,
    scanAvoided: 0,
    invalidations: 0,
  };

  constructor(repoRoot: string, identity: SessionIdentity) {
    this.repoRoot = resolve(repoRoot);
    this.identity = identity;
  }

  getMetrics(): SessionCacheMetrics {
    return { ...this.metrics };
  }

  snapshot(): SessionCacheSnapshot {
    return {
      identity: { ...this.identity },
      metrics: this.getMetrics(),
      fileCount: this.ranges.size,
      searchCount: this.searches.size,
    };
  }

  currentIdentity(): SessionIdentity {
    return { ...this.identity };
  }

  refreshIdentity(next: SessionIdentity): void {
    const prev = this.identity;
    this.identity = next;
    if (prev.checkoutId !== next.checkoutId) {
      this.invalidateCheckout();
      return;
    }
    if (prev.head !== next.head) {
      this.invalidateHeadRelated();
    }
    if (prev.workingTreeFingerprint !== next.workingTreeFingerprint) {
      this.invalidateWorkingTree();
    }
  }

  observeRuntimeGeneration(generation: string | undefined): void {
    if (this.runtimeGeneration && generation && this.runtimeGeneration !== generation) {
      this.invalidateRuntime();
    }
    this.runtimeGeneration = generation;
  }

  observeActiveSlot(slot: string | undefined): void {
    if (this.activeSlot && slot && this.activeSlot !== slot) {
      this.invalidateRuntime();
    }
    this.activeSlot = slot;
  }

  getFileSha(relativePath: string): string | null {
    const cached = this.fileSha.get(relativePath);
    if (cached) {
      this.metrics.cacheHit += 1;
      return cached;
    }
    const absolute = join(this.repoRoot, relativePath);
    const sha = fileShaOf(absolute);
    if (sha) this.fileSha.set(relativePath, sha);
    this.metrics.cacheMiss += 1;
    return sha;
  }

  /**
   * Return a cached range when the file SHA is unchanged and the range is fully covered.
   */
  getRange(
    relativePath: string,
    startLine: number,
    endLine: number,
  ): FileRangeCacheEntry | null {
    const sha = this.getFileSha(relativePath);
    if (!sha) return null;
    const key = rangeKey(relativePath, startLine, endLine);
    const exact = this.ranges.get(key);
    if (exact && exact.fileSha === sha) {
      this.metrics.cacheHit += 1;
      this.metrics.bytesAvoided += exact.bytes;
      return exact;
    }
    // Try covering supersets: same path/sha with wider range.
    for (const entry of this.ranges.values()) {
      if (
        entry.path === relativePath
        && entry.fileSha === sha
        && entry.startLine <= startLine
        && entry.endLine >= endLine
      ) {
        this.metrics.cacheHit += 1;
        this.metrics.bytesAvoided += Math.max(0, entry.bytes);
        return {
          ...entry,
          startLine,
          endLine,
          content: sliceNumberedContent(entry.content, entry.startLine, startLine, endLine),
        };
      }
    }
    this.metrics.cacheMiss += 1;
    return null;
  }

  putRange(entry: FileRangeCacheEntry): void {
    this.fileSha.set(entry.path, entry.fileSha);
    this.ranges.set(rangeKey(entry.path, entry.startLine, entry.endLine), entry);
  }

  getSearch(query: string, includeKey: string): SearchCacheEntry | null {
    const key = `${this.identity.head}|${this.identity.workingTreeFingerprint}|${includeKey}|${query}`;
    const hit = this.searches.get(key);
    if (hit) {
      this.metrics.cacheHit += 1;
      this.metrics.scanAvoided += 1;
      return hit;
    }
    this.metrics.cacheMiss += 1;
    return null;
  }

  putSearch(entry: SearchCacheEntry): void {
    const key = `${this.identity.head}|${this.identity.workingTreeFingerprint}|${entry.includeKey}|${entry.query}`;
    this.searches.set(key, entry);
  }

  getGitSnapshot(): unknown | null {
    const key = `${this.identity.head}|${this.identity.workingTreeFingerprint}`;
    const hit = this.gitSnapshots.get(key);
    if (hit) {
      this.metrics.cacheHit += 1;
      return hit.value;
    }
    this.metrics.cacheMiss += 1;
    return null;
  }

  putGitSnapshot(value: unknown): void {
    const key = `${this.identity.head}|${this.identity.workingTreeFingerprint}`;
    this.gitSnapshots.set(key, { at: Date.now(), value });
  }

  getCheck(checkId: string): unknown | null {
    const key = `${this.identity.workingTreeFingerprint}|${checkId}`;
    const hit = this.checks.get(key);
    if (hit !== undefined) {
      this.metrics.cacheHit += 1;
      return hit;
    }
    this.metrics.cacheMiss += 1;
    return null;
  }

  putCheck(checkId: string, value: unknown): void {
    this.checks.set(`${this.identity.workingTreeFingerprint}|${checkId}`, value);
  }

  /** Precise invalidation when one file changes. */
  invalidateFile(relativePath: string): void {
    this.fileSha.delete(relativePath);
    for (const key of [...this.ranges.keys()]) {
      if (key.startsWith(`${relativePath}:`)) this.ranges.delete(key);
    }
    // Search/git/check results may mention the file; invalidate broad read caches tied to tree fingerprint.
    this.invalidateWorkingTree();
    this.metrics.invalidations += 1;
  }

  invalidateCheckout(): void {
    this.fileSha.clear();
    this.ranges.clear();
    this.searches.clear();
    this.gitSnapshots.clear();
    this.checks.clear();
    this.metrics.invalidations += 1;
  }

  invalidateHeadRelated(): void {
    this.searches.clear();
    this.gitSnapshots.clear();
    this.checks.clear();
    this.metrics.invalidations += 1;
  }

  invalidateWorkingTree(): void {
    this.searches.clear();
    this.gitSnapshots.clear();
    this.checks.clear();
    this.metrics.invalidations += 1;
  }

  invalidateRuntime(): void {
    // Runtime health/generation caches only — keep file content when possible.
    this.checks.clear();
    this.metrics.invalidations += 1;
  }

  invalidateConfig(): void {
    this.checks.clear();
    this.gitSnapshots.clear();
    this.metrics.invalidations += 1;
  }
}

function sliceNumberedContent(
  numbered: string,
  baseStart: number,
  startLine: number,
  endLine: number,
): string {
  const lines = numbered.split(/\r?\n/);
  const from = Math.max(0, startLine - baseStart);
  const to = Math.min(lines.length, endLine - baseStart + 1);
  return lines.slice(from, to).join('\n');
}

/** Process-wide session caches keyed by session + repo identity. */
const globalSessions = new Map<string, RepositorySessionCache>();

export function sessionCacheKey(sessionId: string, identity: SessionIdentity): string {
  return [
    sessionId,
    identity.repoId,
    identity.checkoutId,
    identity.branch ?? 'detached',
    identity.head ?? 'no-head',
  ].join('|');
}

export function getOrCreateSessionCache(
  sessionId: string,
  repoRoot: string,
  identity: SessionIdentity,
): RepositorySessionCache {
  const key = sessionCacheKey(sessionId, identity);
  const existing = globalSessions.get(key);
  if (existing) {
    existing.refreshIdentity(identity);
    return existing;
  }
  // Drop stale entries for same session+repo when checkout/head changed.
  for (const [entryKey, cache] of globalSessions) {
    if (entryKey.startsWith(`${sessionId}|${identity.repoId}|`) && entryKey !== key) {
      globalSessions.delete(entryKey);
      cache.invalidateCheckout();
    }
  }
  const created = new RepositorySessionCache(repoRoot, identity);
  globalSessions.set(key, created);
  return created;
}

export function clearAllSessionCachesForTest(): void {
  globalSessions.clear();
}

export function sessionCacheMetricsTotal(): SessionCacheMetrics {
  const total: SessionCacheMetrics = {
    cacheHit: 0,
    cacheMiss: 0,
    bytesAvoided: 0,
    scanAvoided: 0,
    invalidations: 0,
  };
  for (const cache of globalSessions.values()) {
    const m = cache.getMetrics();
    total.cacheHit += m.cacheHit;
    total.cacheMiss += m.cacheMiss;
    total.bytesAvoided += m.bytesAvoided;
    total.scanAvoided += m.scanAvoided;
    total.invalidations += m.invalidations;
  }
  return total;
}
