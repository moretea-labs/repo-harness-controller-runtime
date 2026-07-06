import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { AssistantPluginManifest } from '../plugins/types';
import type { WebDomainAccessPreview, WebTarget } from './types';

interface BrowserConfigLike {
  enabled?: boolean;
  allowedDomains?: string[];
  defaultTimeoutMs?: number;
  profileDir?: string;
}

const CONFIG_RELATIVE_PATH = '.repo-harness/plugins/browser.json';
const DOMAIN_KEY_MAX_LENGTH = 48;
const DOMAIN_GRANT_TTL_MS = 15 * 60_000;

function readConfig(repoRoot: string): BrowserConfigLike {
  try {
    return JSON.parse(readFileSync(join(repoRoot, CONFIG_RELATIVE_PATH), 'utf-8')) as BrowserConfigLike;
  } catch {
    return {};
  }
}

function hostnameFromDomain(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) throw new Error('DOMAIN_REQUIRED');
  let hostname = raw;
  if (raw.includes('://')) {
    const parsed = new URL(raw);
    hostname = parsed.hostname.toLowerCase();
  }
  hostname = hostname.replace(/^\.+|\.+$/g, '');
  if (!hostname || hostname.length > 253) throw new Error('DOMAIN_INVALID');
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) throw new Error('DOMAIN_PUBLIC_HOST_REQUIRED');
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.includes('..') || !hostname.includes('.')) throw new Error('DOMAIN_INVALID');
  return hostname;
}

export function domainKeyFor(domain: string): string {
  const normalized = hostnameFromDomain(domain);
  const base = normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, DOMAIN_KEY_MAX_LENGTH);
  return base || createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function browserAllowedDomains(repoRoot: string, manifest?: AssistantPluginManifest): string[] {
  const config = readConfig(repoRoot);
  const rawFromConfig = Array.isArray(config.allowedDomains) ? config.allowedDomains : undefined;
  const rawFromManifest = Array.isArray(manifest?.health.details?.allowedDomains) ? manifest?.health.details?.allowedDomains : undefined;
  const raw = rawFromConfig ?? rawFromManifest ?? [];
  return Array.from(new Set(raw.map((entry) => {
    try { return hostnameFromDomain(String(entry)); }
    catch { return undefined; }
  }).filter((entry): entry is string => Boolean(entry)))).sort();
}

export function listWebTargets(repoRoot: string, manifest?: AssistantPluginManifest): WebTarget[] {
  return browserAllowedDomains(repoRoot, manifest).map((domain) => ({
    targetKey: domainKeyFor(domain),
    domain,
    origin: `https://${domain}`,
    allowed: true,
    defaultPath: '/',
  }));
}

export function resolveWebTargetUrl(repoRoot: string, targetKey: string, rawPath?: unknown, query?: unknown, manifest?: AssistantPluginManifest): string {
  const targets = listWebTargets(repoRoot, manifest);
  const normalizedKey = String(targetKey ?? '').trim();
  const target = targets.find((entry) => entry.targetKey === normalizedKey || entry.domain === normalizedKey);
  if (!target) throw new Error(`WEB_TARGET_NOT_ALLOWED: ${normalizedKey}`);
  const path = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '/';
  if (path.includes('://')) throw new Error('WEB_TARGET_PATH_ONLY: provide a path, not an absolute URL');
  if (path.includes('..')) throw new Error('WEB_TARGET_PATH_INVALID: parent traversal is not allowed');
  const url = new URL(path.startsWith('/') ? path : `/${path}`, target.origin);
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function accessTicket(domain: string, currentDomains: string[], reason: string, expiresAt: string): string {
  const payload = {
    type: 'browser-domain-access',
    domain,
    currentDomains,
    reason: reason.slice(0, 240),
    expiresAt,
  };
  return `BDG-${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 20)}`;
}

export function previewBrowserDomainAccess(repoRoot: string, rawDomain: unknown, rawReason: unknown, manifest?: AssistantPluginManifest): WebDomainAccessPreview {
  const normalizedDomain = hostnameFromDomain(String(rawDomain ?? ''));
  const currentAllowedDomains = browserAllowedDomains(repoRoot, manifest);
  const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : 'Requested by user.';
  const expiresAt = new Date(Date.now() + DOMAIN_GRANT_TTL_MS).toISOString();
  return {
    ticketId: accessTicket(normalizedDomain, currentAllowedDomains, reason, expiresAt),
    normalizedDomain,
    domainKey: domainKeyFor(normalizedDomain),
    reason,
    expiresAt,
    alreadyAllowed: currentAllowedDomains.includes(normalizedDomain),
    currentAllowedDomainCount: currentAllowedDomains.length,
    risk: 'workspace_write',
    confirmation: 'authorization',
    localOnly: true,
    willChange: {
      pluginId: 'browser',
      configField: 'allowedDomains',
      addDomain: normalizedDomain,
    },
    safety: {
      arbitraryUrlAccepted: false,
      domainOnly: true,
      sensitiveConfigReturned: false,
    },
  };
}

export function mergeAllowedDomains(repoRoot: string, rawDomain: unknown, manifest?: AssistantPluginManifest): string[] {
  const normalizedDomain = hostnameFromDomain(String(rawDomain ?? ''));
  return Array.from(new Set([...browserAllowedDomains(repoRoot, manifest), normalizedDomain])).sort();
}
