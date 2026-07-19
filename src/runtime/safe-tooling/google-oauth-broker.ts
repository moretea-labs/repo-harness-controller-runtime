import { createHash, randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { URLSearchParams } from 'url';
import { installGoogleAccessToken } from '../plugins/google-shared';
import {
  googleCredentialStoreStatus,
  type StoredGoogleService,
  writeStoredGoogleRefreshToken,
} from './google-credential-store';

export type GoogleOAuthService = StoredGoogleService;

export interface GoogleOAuthPrepareInput {
  service: GoogleOAuthService;
  scopes: string[];
  redirectUri: string;
}

interface GoogleOAuthRequestRecord {
  schemaVersion: 1;
  requestId: string;
  stateHash: string;
  service: GoogleOAuthService;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeVerifier: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REQUEST_TTL_MS = 10 * 60_000;
const RETAIN_CONSUMED_REQUEST_MS = 24 * 60 * 60_000;
const ALLOWED_SCOPES: Record<GoogleOAuthService, Set<string>> = {
  gmail: new Set([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
  ]),
  calendar: new Set(['https://www.googleapis.com/auth/calendar']),
  tasks: new Set(['https://www.googleapis.com/auth/tasks']),
  'google-workspace': new Set([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
  ]),
};

function validateRedirectUri(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('GOOGLE_OAUTH_REDIRECT_INVALID: redirect URI must be a URL'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_NOT_LOCAL: redirect URI must use loopback HTTP');
  }
  if (parsed.pathname !== '/oauth/google/callback' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_INVALID: use the local /oauth/google/callback endpoint');
  }
  return parsed.toString();
}

const OAUTH_SCOPE_ALIASES: Record<string, string> = {
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.compose': 'https://www.googleapis.com/auth/gmail.compose',
  'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'calendar.events.readonly': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.write': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.delete': 'https://www.googleapis.com/auth/calendar',
  'tasks.readonly': 'https://www.googleapis.com/auth/tasks',
  'tasks.write': 'https://www.googleapis.com/auth/tasks',
  'tasks.delete': 'https://www.googleapis.com/auth/tasks',
};

function validateScopes(service: GoogleOAuthService, scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => OAUTH_SCOPE_ALIASES[scope.trim()] ?? scope.trim()).filter(Boolean))];
  const invalid = normalized.filter((scope) => !ALLOWED_SCOPES[service].has(scope));
  if (invalid.length > 0) throw new Error(`GOOGLE_OAUTH_SCOPE_NOT_ALLOWED: ${invalid.join(', ')}`);
  if (normalized.length === 0) throw new Error('GOOGLE_OAUTH_SCOPE_REQUIRED');
  return normalized;
}

function pruneOAuthRequests(controllerHome: string): void {
  const root = join(oauthRoot(controllerHome), 'requests');
  try {
    for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json')).slice(0, 2_000)) {
      const path = join(root, name);
      try {
        const record = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GoogleOAuthRequestRecord>;
        const expired = Date.parse(String(record.expiresAt ?? '')) <= Date.now();
        const consumedOld = record.consumedAt && Date.now() - Date.parse(record.consumedAt) > RETAIN_CONSUMED_REQUEST_MS;
        if (expired || consumedOld) unlinkSync(path);
      } catch { unlinkSync(path); }
    }
  } catch { /* no request store yet */ }
}

function oauthRoot(controllerHome: string): string {
  return join(controllerHome, 'auth', 'google-oauth');
}

function requestPath(controllerHome: string, state: string): string {
  return join(oauthRoot(controllerHome), 'requests', `${createHash('sha256').update(state).digest('hex')}.json`);
}

function writeRecord(path: string, value: GoogleOAuthRequestRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

function readRecord(controllerHome: string, state: string): { path: string; record: GoogleOAuthRequestRecord } {
  const path = requestPath(controllerHome, state);
  if (!existsSync(path)) throw new Error('GOOGLE_OAUTH_STATE_INVALID: login state was not found');
  let record: GoogleOAuthRequestRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf-8')) as GoogleOAuthRequestRecord;
  } catch {
    throw new Error('GOOGLE_OAUTH_STATE_INVALID: login state is unreadable');
  }
  if (record.stateHash !== createHash('sha256').update(state).digest('hex')) {
    throw new Error('GOOGLE_OAUTH_STATE_INVALID: state hash mismatch');
  }
  if (record.consumedAt) throw new Error('GOOGLE_OAUTH_STATE_REPLAYED: login state was already consumed');
  if (Date.parse(record.expiresAt) <= Date.now()) throw new Error('GOOGLE_OAUTH_STATE_EXPIRED: start a new login');
  return { path, record };
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function clientId(): string | undefined {
  return process.env.REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID?.trim()
    || process.env.REPO_HARNESS_GOOGLE_CLIENT_ID?.trim()
    || process.env.GOOGLE_CLIENT_ID?.trim();
}

function clientSecret(): string | undefined {
  return process.env.REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_SECRET?.trim()
    || process.env.REPO_HARNESS_GOOGLE_CLIENT_SECRET?.trim()
    || process.env.GOOGLE_CLIENT_SECRET?.trim();
}

export function prepareGoogleOAuthLogin(
  controllerHome: string,
  input: GoogleOAuthPrepareInput,
): Record<string, unknown> {
  pruneOAuthRequests(controllerHome);
  const redirectUri = validateRedirectUri(input.redirectUri);
  const scopes = validateScopes(input.service, input.scopes);
  const configuredClientId = clientId();
  if (!configuredClientId) {
    return {
      schemaVersion: 1,
      provider: 'google-workspace',
      service: input.service,
      readyToOpenBrowser: false,
      missingConfiguration: ['Set REPO_HARNESS_GOOGLE_CLIENT_ID or REPO_HARNESS_GOOGLE_WORKSPACE_CLIENT_ID.'],
      credentialStore: googleCredentialStoreStatus(),
    };
  }
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(48));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + REQUEST_TTL_MS);
  const record: GoogleOAuthRequestRecord = {
    schemaVersion: 1,
    requestId: `GOAUTH-${Date.now()}-${randomUUID().slice(0, 8)}`,
    stateHash: createHash('sha256').update(state).digest('hex'),
    service: input.service,
    clientId: configuredClientId,
    redirectUri,
    scopes,
    codeVerifier,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  writeRecord(requestPath(controllerHome, state), record);
  const params = new URLSearchParams({
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    client_id: record.clientId,
    redirect_uri: record.redirectUri,
    scope: record.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return {
    schemaVersion: 1,
    provider: 'google-workspace',
    service: record.service,
    requestId: record.requestId,
    readyToOpenBrowser: true,
    authorizationUrl: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
    redirectUri: record.redirectUri,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    pkce: true,
    stateProtected: true,
    credentialStore: googleCredentialStoreStatus(),
    safety: {
      credentialMaterialReturned: false,
      credentialMaterialPersistedInRepository: false,
      opensBrowserAutomatically: false,
    },
  };
}

export async function completeGoogleOAuthLogin(
  controllerHome: string,
  input: { state?: string; code?: string; error?: string; errorDescription?: string },
): Promise<Record<string, unknown>> {
  const state = input.state?.trim();
  if (!state) throw new Error('GOOGLE_OAUTH_STATE_REQUIRED');
  const selected = readRecord(controllerHome, state);
  const codeVerifier = selected.record.codeVerifier;
  if (!codeVerifier) throw new Error('GOOGLE_OAUTH_STATE_INVALID: PKCE verifier is missing');
  selected.record.codeVerifier = '';
  selected.record.consumedAt = new Date().toISOString();
  writeRecord(selected.path, selected.record);
  if (input.error) {
    throw new Error(`GOOGLE_OAUTH_DENIED: ${input.errorDescription || input.error}`);
  }
  const code = input.code?.trim();
  if (!code) throw new Error('GOOGLE_OAUTH_CODE_REQUIRED');
  const configuredSecret = clientSecret();
  if (!configuredSecret) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET_REQUIRED');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: selected.record.clientId,
    client_secret: configuredSecret,
    redirect_uri: selected.record.redirectUri,
    code_verifier: codeVerifier,
  });
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { parsed = {}; }
  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
  const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token.trim() : '';
  if (!response.ok || !accessToken || !refreshToken) {
    throw new Error(`GOOGLE_OAUTH_EXCHANGE_FAILED: provider returned HTTP ${response.status}`);
  }
  writeStoredGoogleRefreshToken(selected.record.service, refreshToken);
  const expiresIn = typeof parsed.expires_in === 'number' ? Math.max(60, parsed.expires_in) : 3600;
  installGoogleAccessToken(
    selected.record.service === 'google-workspace' ? 'gmail' : selected.record.service,
    accessToken,
    expiresIn,
    `oauth:${selected.record.service}`,
  );
  return {
    schemaVersion: 1,
    provider: 'google-workspace',
    service: selected.record.service,
    requestId: selected.record.requestId,
    authenticated: true,
    refreshCredentialStored: true,
    accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes: typeof parsed.scope === 'string' ? parsed.scope.split(/\s+/).filter(Boolean) : selected.record.scopes,
    credentialStore: googleCredentialStoreStatus(),
    safety: {
      credentialMaterialReturned: false,
      credentialMaterialPersistedInRepository: false,
      stateConsumed: true,
    },
  };
}
