import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('portable launcher files are executable package entrypoints', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.bin['repo-harness'], 'bin/repo-harness.mjs');
  assert.equal(pkg.bin['repo-harness-hook'], 'bin/repo-harness-hook.mjs');
  accessSync('bin/repo-harness.mjs', constants.X_OK);
  accessSync('bin/repo-harness-hook.mjs', constants.X_OK);
});

test('Node runtime is a first-class supported engine', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.engines.node, />=20/);
  assert.match(pkg.scripts.test, /run-tests-portable/);
  assert.ok(pkg.scripts['check:ci:portable']);
});

test('managed gitignore covers runtime, backup, review, and secret-prone local files', () => {
  const source = readFileSync('src/core/adoption/gitignore-plan.ts', 'utf8');
  for (const pattern of [
    '.ai/harness/backups/',
    '.ai/harness/tmp/',
    '.ai/harness/watchdog/',
    '.repo-harness/ios/',
    '.repo-harness/review-artifacts/',
    '.repo-harness/watchdog/',
    '*.pem',
    '*.key',
    '*.p12',
    '*.mobileprovision',
  ]) {
    assert.match(source, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('install script supports explicit Node fallback without forcing Bun install', () => {
  const install = readFileSync('install.sh', 'utf8');
  assert.match(install, /REPO_HARNESS_INSTALL_RUNTIME/);
  assert.match(install, /npm install -g/);
  assert.match(install, /Node\.js 20\+/);
});
