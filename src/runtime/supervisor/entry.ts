#!/usr/bin/env bun
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { ensureControllerHome } from '../../cli/repositories/controller-home';
import { resolveMcpRepoRoot } from '../../cli/mcp/repo';
import { resolveControllerRuntimeSourceRoot } from '../control-plane/runtime-generation';
import { acquireSupervisorLock } from './lock';
import { supervisorLogPath } from './paths';
import { readSupervisorState } from './state-store';
import { StableSupervisorRuntime } from './supervisor-runtime';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberOption(name: string, fallback: number): number {
  const value = Number(option(name) ?? process.env.REPO_HARNESS_SUPERVISOR_CONTROL_PORT ?? fallback);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : fallback;
}

export async function runStableSupervisor(): Promise<void> {
  const repoRoot = resolveMcpRepoRoot(option('--repo') ?? process.cwd());
  const controllerHome = ensureControllerHome(option('--controller-home'));
  const runtimeRoot = resolve(option('--runtime-source-root') ?? resolveControllerRuntimeSourceRoot().root ?? repoRoot);
  const previous = readSupervisorState(controllerHome);
  const lock = acquireSupervisorLock(controllerHome, previous);
  const releaseRoot = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
  const runtimeExecutable = releaseRoot && existsSync(join(releaseRoot, 'repo-harness.js'))
    ? join(releaseRoot, 'repo-harness.js')
    : undefined;
  const daemonExecutable = releaseRoot && existsSync(join(releaseRoot, 'daemon.js'))
    ? join(releaseRoot, 'daemon.js')
    : undefined;
  const runtime = new StableSupervisorRuntime({
    repoRoot,
    controllerHome,
    ownerEpoch: lock.metadata.ownerEpoch,
    runtimeSourceRoot: runtimeRoot,
    runtimeExecutable,
    daemonExecutable,
    logPath: supervisorLogPath(controllerHome),
    controlHost: option('--control-host') ?? '127.0.0.1',
    controlPort: numberOption('--control-port', 8770),
    releaseRevision: option('--release-revision'),
  });
  runtime.adoptSupervisorIdentity({
    ...lock.metadata,
    epoch: lock.metadata.ownerEpoch,
    startedAt: new Date().toISOString(),
    ...(option('--release-revision') ? { releaseRevision: option('--release-revision') } : {}),
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.error(`[repo-harness supervisor] ${signal}: stopping managed runtime`);
    try { await runtime.stop(); } finally {
      lock.release();
      process.exit(0);
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

  try {
    await runtime.start();
    console.error(`[repo-harness supervisor] running controllerHome=${controllerHome} epoch=${lock.metadata.ownerEpoch}`);
    await new Promise<void>(() => { /* control server and monitor own the event loop */ });
  } catch (error) {
    lock.release();
    throw error;
  }
}

if (import.meta.main || /[\\/]supervisor(?:\.bundle)?\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  await runStableSupervisor();
}
