#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const cliEntry = join(root, 'src', 'cli', 'index.ts');
const nodeLoader = join(root, 'src', 'runtime', 'shared', 'node-ts-loader.mjs');
const args = process.argv.slice(2);

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const probeArgs = process.platform === 'win32' ? [command] : ['-v', command];
  const result = spawnSync(probe, probeArgs, { stdio: 'ignore', shell: process.platform !== 'win32' });
  return result.status === 0;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(`repo-harness launcher failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

if (process.env.REPO_HARNESS_FORCE_NODE !== '1' && commandExists('bun')) {
  run('bun', [cliEntry, ...args]);
}

run(process.execPath, ['--loader', nodeLoader, cliEntry, ...args]);
