import { existsSync, readFileSync } from 'fs';
import { delimiter, resolve } from 'path';

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SUPPORTED_PREFIXES = ['REPO_HARNESS_', 'GOOGLE_'] as const;
const SUPPORTED_NAMES = new Set([
  'OPENAI_WORKSPACE_AGENT_ACCESS_TOKEN',
  'CHATGPT_WORKSPACE_AGENT_ACCESS_TOKEN',
]);

export interface ManagedEnvBootstrapOptions {
  cwd?: string;
  controllerHome?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

function hasRepoHarnessMarkers(path: string): boolean {
  return existsSync(resolve(path, '.git'))
    || existsSync(resolve(path, '.repo-harness'))
    || existsSync(resolve(path, '_ops'));
}

function inferRepoRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (hasRepoHarnessMarkers(current)) return current;
    const parent = resolve(current, '..');
    if (parent === current) return undefined;
    current = parent;
  }
}

function isSupportedName(name: string): boolean {
  return SUPPORTED_NAMES.has(name) || SUPPORTED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function decodeDoubleQuoted(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current !== '\\' || index === value.length - 1) {
      decoded += current;
      continue;
    }
    index += 1;
    const escaped = value[index];
    switch (escaped) {
      case 'n':
        decoded += '\n';
        break;
      case 'r':
        decoded += '\r';
        break;
      case 't':
        decoded += '\t';
        break;
      case '\\':
        decoded += '\\';
        break;
      case '"':
        decoded += '"';
        break;
      default:
        decoded += escaped;
        break;
    }
  }
  return decoded;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
  const separator = normalized.indexOf('=');
  if (separator <= 0) return null;
  const key = normalized.slice(0, separator).trim();
  if (!ENV_KEY_PATTERN.test(key) || !isSupportedName(key)) return null;
  let value = normalized.slice(separator + 1).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return [key, decodeDoubleQuoted(value.slice(1, -1))];
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return [key, value.slice(1, -1)];
  }
  const inlineComment = value.search(/\s#/);
  if (inlineComment >= 0) value = value.slice(0, inlineComment).trimEnd();
  return [key, value];
}

function parseEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const line of source.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    entries.set(parsed[0], parsed[1]);
  }
  return entries;
}

function pushCandidate(files: string[], seen: Set<string>, path: string | undefined): void {
  const normalized = path?.trim();
  if (!normalized) return;
  const resolved = resolve(normalized);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  files.push(resolved);
}

function candidateFiles(options: ManagedEnvBootstrapOptions): string[] {
  const env = options.env ?? process.env;
  const files: string[] = [];
  const seen = new Set<string>();
  const single = env.REPO_HARNESS_ENV_FILE?.trim();
  if (single) pushCandidate(files, seen, single);
  const multiple = env.REPO_HARNESS_ENV_FILES?.split(delimiter).map((value) => value.trim()).filter(Boolean) ?? [];
  for (const entry of multiple) pushCandidate(files, seen, entry);

  const repoRoot = options.repoRoot?.trim() || inferRepoRoot(options.cwd ?? process.cwd());
  if (repoRoot) {
    pushCandidate(files, seen, resolve(repoRoot, '_ops', 'secrets', 'repo-harness.env'));
    pushCandidate(files, seen, resolve(repoRoot, '_ops', 'secrets', 'controller.env'));
    pushCandidate(files, seen, resolve(repoRoot, '_ops', 'env', '.env.local'));
  }
  const controllerHome = options.controllerHome?.trim();
  if (controllerHome) {
    pushCandidate(files, seen, resolve(controllerHome, '..', 'secrets', 'repo-harness.env'));
    pushCandidate(files, seen, resolve(controllerHome, '..', 'secrets', 'controller.env'));
    pushCandidate(files, seen, resolve(controllerHome, '..', 'env', '.env.local'));
  }
  return files;
}

export function bootstrapManagedRuntimeEnv(options: ManagedEnvBootstrapOptions = {}): {
  loadedFiles: string[];
  appliedKeys: string[];
} {
  const env = options.env ?? process.env;
  const loadedFiles: string[] = [];
  const appliedKeys: string[] = [];
  for (const file of candidateFiles(options)) {
    if (!existsSync(file)) continue;
    loadedFiles.push(file);
    for (const [key, value] of parseEnvFile(file)) {
      if (env[key]?.trim()) continue;
      env[key] = value;
      appliedKeys.push(key);
    }
  }
  return { loadedFiles, appliedKeys };
}
