import { createHash } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';

export type ExternalFilesystemGrantMode = 'read';

export interface ExternalFilesystemGrant {
  schemaVersion: 1;
  key: string;
  root: string;
  canonicalRoot: string;
  mode: ExternalFilesystemGrantMode;
  reason: string;
  createdAt: string;
  createdBy: string;
}

export interface ExternalFilesystemGrantFile {
  schemaVersion: 1;
  updatedAt: string;
  grants: ExternalFilesystemGrant[];
}

export interface ExternalFilesystemGrantPreview {
  schemaVersion: 1;
  previewTicketId: string;
  accepted: boolean;
  key: string;
  root: string;
  canonicalRoot?: string;
  mode: ExternalFilesystemGrantMode;
  reason: string;
  risk: 'readonly' | 'denied';
  denialReason?: string;
  next: string;
  safety: {
    arbitraryPathRead: false;
    requiresApply: true;
    secretsPersisted: false;
    repositorySourceMutation: false;
  };
}

export interface ExternalFilesystemSnapshot {
  targetKey: string;
  relativePath: string;
  absolutePathPreview: string;
  kind: 'file' | 'directory';
  truncated: boolean;
  entries?: Array<{ name: string; kind: 'file' | 'directory' | 'other'; size?: number }>;
  text?: string;
  byteLength?: number;
  safety: {
    grantMode: ExternalFilesystemGrantMode;
    boundedToGrant: true;
    writeAllowed: false;
  };
}

const CONFIG_PATH = '.repo-harness/external-filesystem-grants.json';
const DEFAULT_MAX_CHARS = 16_000;
const MAX_CHARS = 128_000;

function now(): string { return new Date().toISOString(); }

function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_PATH);
}

function stableTicket(input: Record<string, unknown>): string {
  return `EFG-${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`;
}

function normalizeKey(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!raw || raw === '.' || raw === '..' || raw.length > 64) throw new Error('EXTERNAL_FS_KEY_INVALID: grant_key must be 1-64 safe characters');
  return raw;
}

function normalizeMode(value: unknown): ExternalFilesystemGrantMode {
  if (value === undefined || value === null || value === 'read') return 'read';
  throw new Error('EXTERNAL_FS_MODE_UNSUPPORTED: only read mode is supported in this tool surface');
}

function userHome(): string | undefined {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? resolve(home) : undefined;
}

function denyReason(canonical: string, repoRoot: string): string | undefined {
  const normalized = resolve(canonical);
  const home = userHome();
  const repo = resolve(repoRoot);
  const sensitiveExact = new Set(['/','/etc','/private/etc','/System','/Library','/Applications','/Users','/home','/var','/private/var']);
  if (sensitiveExact.has(normalized)) return 'Grant root is too broad or system-owned.';
  if (home && normalized === home) return 'Grant root is the whole user home; choose a narrower project/data directory.';
  const lower = normalized.toLowerCase();
  const sensitiveFragments = ['/.ssh', '/.gnupg', '/library/keychains', '/library/mail', '/library/messages', '/library/application support/com.apple', '/.aws', '/.config/gcloud', '/.kube'];
  if (sensitiveFragments.some((fragment) => lower.includes(fragment))) return 'Grant root appears to contain credentials or personal application data.';
  const repoRel = relative(repo, normalized);
  if (!repoRel.startsWith('..') && repoRel !== '') return 'Path is inside the repository; use repository file tools instead of an external filesystem grant.';
  return undefined;
}

function canonicalizeRoot(repoRoot: string, rootPath: unknown): { input: string; canonical?: string; denialReason?: string } {
  const input = String(rootPath ?? '').trim();
  if (!input) return { input, denialReason: 'root_path is required.' };
  if (!input.startsWith('/')) return { input, denialReason: 'Only absolute local paths can be previewed for external grants.' };
  try {
    if (!existsSync(input)) return { input, denialReason: 'Path does not exist.' };
    const canonical = realpathSync(input);
    const stat = lstatSync(canonical);
    if (!stat.isDirectory()) return { input, denialReason: 'Only directory grants are supported.' };
    return { input, canonical, denialReason: denyReason(canonical, repoRoot) };
  } catch (error) {
    return { input, denialReason: error instanceof Error ? error.message : String(error) };
  }
}

export function loadExternalFilesystemGrants(repoRoot: string): ExternalFilesystemGrantFile {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return { schemaVersion: 1, updatedAt: now(), grants: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExternalFilesystemGrantFile>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now(),
      grants: Array.isArray(parsed.grants) ? parsed.grants.filter((grant): grant is ExternalFilesystemGrant => Boolean(grant && typeof grant.key === 'string' && typeof grant.canonicalRoot === 'string')) : [],
    };
  } catch {
    return { schemaVersion: 1, updatedAt: now(), grants: [] };
  }
}

function saveExternalFilesystemGrants(repoRoot: string, file: ExternalFilesystemGrantFile): ExternalFilesystemGrantFile {
  const path = configPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const updated = { schemaVersion: 1 as const, updatedAt: now(), grants: file.grants.sort((a, b) => a.key.localeCompare(b.key)) };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return updated;
}

export function previewExternalFilesystemGrant(repoRoot: string, args: Record<string, unknown>): ExternalFilesystemGrantPreview {
  const key = normalizeKey(args.grant_key ?? args.target_key ?? args.key);
  const mode = normalizeMode(args.mode);
  const reason = String(args.reason ?? '').trim();
  const root = canonicalizeRoot(repoRoot, args.root_path ?? args.root);
  const accepted = !root.denialReason && Boolean(reason);
  const previewTicketId = stableTicket({ key, canonicalRoot: root.canonical, mode, reason });
  return {
    schemaVersion: 1,
    previewTicketId,
    accepted,
    key,
    root: root.input,
    canonicalRoot: root.canonical,
    mode,
    reason,
    risk: accepted ? 'readonly' : 'denied',
    denialReason: !reason ? 'A reason is required for auditability.' : root.denialReason,
    next: accepted
      ? 'Call external_filesystem_grant_apply with this preview_ticket_id and confirm_authorization=true.'
      : 'Choose a narrower existing directory and include an audit reason.',
    safety: {
      arbitraryPathRead: false,
      requiresApply: true,
      secretsPersisted: false,
      repositorySourceMutation: false,
    },
  };
}

export function applyExternalFilesystemGrant(repoRoot: string, args: Record<string, unknown>): { grant: ExternalFilesystemGrant; file: ExternalFilesystemGrantFile; preview: ExternalFilesystemGrantPreview } {
  if (args.confirm_authorization !== true) throw new Error('EXTERNAL_FS_AUTHORIZATION_REQUIRED: confirm_authorization=true is required.');
  const preview = previewExternalFilesystemGrant(repoRoot, args);
  if (!preview.accepted || !preview.canonicalRoot) throw new Error(`EXTERNAL_FS_GRANT_DENIED: ${preview.denialReason ?? 'preview not accepted'}`);
  if (String(args.preview_ticket_id ?? '') !== preview.previewTicketId) throw new Error('EXTERNAL_FS_PREVIEW_TICKET_MISMATCH: run preview again and pass the returned ticket id');
  const file = loadExternalFilesystemGrants(repoRoot);
  const grant: ExternalFilesystemGrant = {
    schemaVersion: 1,
    key: preview.key,
    root: preview.root,
    canonicalRoot: preview.canonicalRoot,
    mode: preview.mode,
    reason: preview.reason,
    createdAt: now(),
    createdBy: 'external_filesystem_grant_apply',
  };
  const grants = file.grants.filter((entry) => entry.key !== grant.key).concat(grant);
  return { grant, file: saveExternalFilesystemGrants(repoRoot, { ...file, grants }), preview };
}

export function listExternalFilesystemTargets(repoRoot: string): { targets: Array<Omit<ExternalFilesystemGrant, 'root'> & { exists: boolean; rootPreview: string }>; safety: Record<string, unknown> } {
  const file = loadExternalFilesystemGrants(repoRoot);
  return {
    targets: file.grants.map((grant) => ({
      ...grant,
      rootPreview: `<external:${grant.key}>`,
      exists: existsSync(grant.canonicalRoot),
    })),
    safety: {
      arbitraryPathAccepted: false,
      operationsRequireTargetKey: true,
      writeOperationsExposed: false,
      configPath: CONFIG_PATH,
    },
  };
}

function resolveGrantedPath(grant: ExternalFilesystemGrant, relativePath: unknown): { absolute: string; relativePath: string } {
  const raw = String(relativePath ?? '.').trim() || '.';
  if (raw.startsWith('/')) throw new Error('EXTERNAL_FS_RELATIVE_PATH_REQUIRED: use a path relative to the target key');
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const absolute = resolve(grant.canonicalRoot, normalized);
  const rel = relative(grant.canonicalRoot, absolute);
  if (rel.startsWith('..') || rel === '..') throw new Error('EXTERNAL_FS_PATH_ESCAPE_DENIED: path must stay inside the granted root');
  return { absolute, relativePath: rel || '.' };
}

function boundedChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.max(1, Math.min(Math.trunc(value), MAX_CHARS));
}

export function readExternalFilesystemSnapshot(repoRoot: string, args: Record<string, unknown>): ExternalFilesystemSnapshot {
  const key = normalizeKey(args.target_key ?? args.grant_key ?? args.key);
  const grant = loadExternalFilesystemGrants(repoRoot).grants.find((entry) => entry.key === key);
  if (!grant) throw new Error(`EXTERNAL_FS_TARGET_UNKNOWN: ${key}`);
  if (grant.mode !== 'read') throw new Error('EXTERNAL_FS_READ_NOT_GRANTED: target does not grant read mode');
  const resolved = resolveGrantedPath(grant, args.path);
  if (!existsSync(resolved.absolute)) throw new Error('EXTERNAL_FS_PATH_NOT_FOUND');
  const stat = statSync(resolved.absolute);
  if (stat.isDirectory()) {
    const entries = readdirSync(resolved.absolute, { withFileTypes: true }).slice(0, 200).map((entry) => {
      const entryPath = join(resolved.absolute, entry.name);
      let size: number | undefined;
      try { size = statSync(entryPath).size; } catch { size = undefined; }
      return { name: entry.name, kind: entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const, size };
    });
    return {
      targetKey: key,
      relativePath: resolved.relativePath,
      absolutePathPreview: `<external:${key}>/${resolved.relativePath === '.' ? '' : resolved.relativePath}`,
      kind: 'directory',
      truncated: entries.length >= 200,
      entries,
      safety: { grantMode: grant.mode, boundedToGrant: true, writeAllowed: false },
    };
  }
  if (!stat.isFile()) throw new Error('EXTERNAL_FS_PATH_UNSUPPORTED: only files and directories can be snapshotted');
  const maxChars = boundedChars(args.max_chars);
  const content = readFileSync(resolved.absolute, 'utf8');
  return {
    targetKey: key,
    relativePath: resolved.relativePath,
    absolutePathPreview: `<external:${key}>/${resolved.relativePath}`,
    kind: 'file',
    truncated: content.length > maxChars,
    text: content.slice(0, maxChars),
    byteLength: Buffer.byteLength(content),
    safety: { grantMode: grant.mode, boundedToGrant: true, writeAllowed: false },
  };
}
