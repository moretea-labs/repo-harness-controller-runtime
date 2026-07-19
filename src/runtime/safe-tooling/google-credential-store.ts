import { execFileSync } from 'child_process';

export type StoredGoogleService = 'gmail' | 'calendar' | 'tasks' | 'google-workspace';

export interface GoogleCredentialStoreAdapter {
  available(): boolean;
  read(service: StoredGoogleService): string | undefined;
  write(service: StoredGoogleService, refreshToken: string): void;
}

const KEYCHAIN_SERVICE_PREFIX = 'repo-harness.google-oauth';
const KEYCHAIN_ACCOUNT = 'refresh-token';
const memoryCache = new Map<StoredGoogleService, string>();

function keychainService(service: StoredGoogleService): string {
  return `${KEYCHAIN_SERVICE_PREFIX}.${service}`;
}

const macKeychainAdapter: GoogleCredentialStoreAdapter = {
  available: () => process.platform === 'darwin',
  read(service) {
    if (process.platform !== 'darwin') return undefined;
    try {
      const value = execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-s', keychainService(service),
        '-a', KEYCHAIN_ACCOUNT,
        '-w',
      ], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  },
  write(service, refreshToken) {
    if (process.platform !== 'darwin') {
      throw new Error('GOOGLE_CREDENTIAL_STORE_UNAVAILABLE: macOS Keychain is required for local OAuth credential persistence');
    }
    execFileSync('/usr/bin/security', [
      'add-generic-password',
      '-U',
      '-s', keychainService(service),
      '-a', KEYCHAIN_ACCOUNT,
      '-w', refreshToken,
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5_000,
    });
  },
};

let adapter: GoogleCredentialStoreAdapter = macKeychainAdapter;

export function setGoogleCredentialStoreAdapterForTest(next?: GoogleCredentialStoreAdapter): void {
  adapter = next ?? macKeychainAdapter;
  memoryCache.clear();
}

export function googleCredentialStoreStatus(): Record<string, unknown> {
  return {
    backend: process.platform === 'darwin' ? 'macos-keychain' : 'unavailable',
    available: adapter.available(),
    repositoryPersistence: false,
    controllerStatePersistence: false,
  };
}

export function readStoredGoogleRefreshToken(service: StoredGoogleService): { token: string; source: string } | undefined {
  const candidates: StoredGoogleService[] = service === 'google-workspace'
    ? ['google-workspace']
    : [service, 'google-workspace'];
  for (const candidate of candidates) {
    const cached = memoryCache.get(candidate);
    if (cached) return { token: cached, source: `keychain:${candidate}` };
    if (!adapter.available()) continue;
    const token = adapter.read(candidate)?.trim();
    if (!token) continue;
    memoryCache.set(candidate, token);
    return { token, source: `keychain:${candidate}` };
  }
  return undefined;
}

export function writeStoredGoogleRefreshToken(service: StoredGoogleService, refreshToken: string): void {
  const token = refreshToken.trim();
  if (!token) throw new Error('GOOGLE_REFRESH_TOKEN_REQUIRED');
  if (!adapter.available()) throw new Error('GOOGLE_CREDENTIAL_STORE_UNAVAILABLE');
  adapter.write(service, token);
  memoryCache.set(service, token);
}
