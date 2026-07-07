#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function which(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    encoding: 'utf8',
    shell: process.platform !== 'win32',
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/)[0] || null;
}

function version(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null;
}

function parseNodeMajor(value) {
  const match = value.replace(/^v/, '').match(/^(\d+)\./);
  return match ? Number(match[1]) : NaN;
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const checks = [];
function check(id, status, detail, next) {
  checks.push({ id, status, detail, ...(next ? { next } : {}) });
}

const nodeVersion = process.version;
const nodeMajor = parseNodeMajor(nodeVersion);
check('node-runtime', Number.isFinite(nodeMajor) && nodeMajor >= 20 ? 'ok' : 'fail', nodeVersion, 'Install Node.js 20+ or run the dev container.');

const bunPath = which('bun');
check('bun-runtime', bunPath ? 'ok' : 'warn', bunPath ? `${bunPath} (${version('bun') ?? 'version unknown'})` : 'bun not found; full test suite requires Bun', 'Install Bun or use npm run check:ci:portable for Node-only gates.');

const npmPath = which('npm');
check('npm-runtime', npmPath ? 'ok' : 'fail', npmPath ? `${npmPath} (${version('npm') ?? 'version unknown'})` : 'npm not found', 'Install npm with Node.js.');

const tscPath = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
check('typescript-local', existsSync(tscPath) ? 'ok' : 'warn', existsSync(tscPath) ? tscPath : 'node_modules/typescript/bin/tsc missing', 'Run npm install --ignore-scripts --no-audit --no-fund or bun install.');

const ignoredState = [
  '.ai/harness/worktrees',
  '.ai/harness/backups',
  '.ai/harness/edit-sessions',
  '.ai/harness/tmp',
  '.repo-harness/browser',
  '.repo-harness/ios',
  '.repo-harness/watchdog',
];
check('runtime-ignore-surface', 'ok', `tracked local-only runtime paths: ${ignoredState.join(', ')}`);

const riskyTemp = [
  '/tmp/repo-harness',
  join(root, '.ai', 'harness', 'tmp'),
  join(root, '.repo-harness', 'tmp'),
].filter((entry) => existsSync(entry));
check('temp-surface', riskyTemp.length === 0 ? 'ok' : 'warn', riskyTemp.length === 0 ? 'no known temp roots currently exist' : riskyTemp.map((entry) => `${entry}:${sizeOf(entry)}B`).join(', '), 'Run runtime cleanup preview before deleting temp state.');

const summary = checks.reduce((acc, entry) => {
  acc[entry.status] = (acc[entry.status] ?? 0) + 1;
  return acc;
}, {});

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, checks, summary }, null, 2));
} else {
  for (const entry of checks) {
    const marker = entry.status === 'ok' ? '✓' : entry.status === 'warn' ? '!' : '✗';
    console.log(`${marker} ${entry.id}: ${entry.detail}`);
    if (entry.next && entry.status !== 'ok') console.log(`  next: ${entry.next}`);
  }
  console.log(`summary: ok=${summary.ok ?? 0} warn=${summary.warn ?? 0} fail=${summary.fail ?? 0}`);
}

process.exit((summary.fail ?? 0) > 0 ? 1 : 0);
