import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  createIsolatedControllerFixture,
  destroyAllIsolatedControllerFixtures,
  isolatedControllerEnv,
} from '../fixtures/isolated-controller-home';
import {
  ensureSlotHome,
  readActiveSlotAuthority,
  writeActiveSlotAuthority,
  writeSlotIdentity,
} from '../../src/cli/controller/runtime-slots';
import { writeMcpServiceLocalConfig } from '../../src/cli/mcp/auth';
import {
  controllerServiceStatus,
  startControllerService,
  stopControllerService,
} from '../../src/cli/controller/lifecycle';
import { controllerRollback, controllerRollout, startInactiveSlot } from '../../src/cli/controller/bluegreen-rollout';
import { findProcessesByCommand } from '../runtime/process-hygiene';

const ROOT = join(import.meta.dir, '../..');

afterEach(async () => {
  await destroyAllIsolatedControllerFixtures();
});

function seedSlotConfig(
  slotHome: string,
  ports: { mcpPort: number; localControllerPort: number },
): void {
  writeMcpServiceLocalConfig(slotHome, {
    version: 1,
    profile: 'controller',
    auth: { mode: 'bearer' },
    server: { host: '127.0.0.1', port: ports.mcpPort },
    localController: {
      enabled: true,
      host: '127.0.0.1',
      port: ports.localControllerPort,
      autoOpen: false,
    },
  });
}

describe('blue/green isolated lifecycle (level 2)', () => {
  test('inactive slot failure leaves active authority and processes untouched', async () => {
    const fixture = await createIsolatedControllerFixture();
    const previousHome = process.env.REPO_HARNESS_CONTROLLER_HOME;
    const previousSource = process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
    const previousOwner = process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER;
    Object.assign(process.env, isolatedControllerEnv(fixture, {
      REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: ROOT,
    }));

    try {
      writeActiveSlotAuthority(fixture.controllerHome, { activeSlot: 'blue', reason: 'test' });
      const blueHome = ensureSlotHome(fixture.controllerHome, 'blue');
      seedSlotConfig(blueHome, {
        mcpPort: fixture.mcpPort,
        localControllerPort: fixture.localControllerPort,
      });

      const started = await startControllerService({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
        startTimeoutMs: 45_000,
        logFile: join(blueHome, 'logs', 'controller.log'),
      });
      expect(started.status.running || started.status.ready).toBe(true);
      const beforeAuthority = readActiveSlotAuthority(fixture.controllerHome);
      expect(beforeAuthority.activeSlot).toBe('blue');
      const bluePid = started.status.supervisor.pid;

      // Force green failure by allocating ports already held by blue (collision).
      const failed = await startInactiveSlot({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        candidatePorts: {
          mcpPort: fixture.mcpPort,
          localControllerPort: fixture.localControllerPort,
        },
        startTimeoutMs: 8_000,
        skipDurableJob: true,
      });
      expect(failed.verification.ok).toBe(false);

      const afterAuthority = readActiveSlotAuthority(fixture.controllerHome);
      expect(afterAuthority.activeSlot).toBe('blue');
      const blueAfter = await controllerServiceStatus({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
      });
      expect(blueAfter.supervisor.alive).toBe(true);
      if (bluePid) expect(blueAfter.supervisor.pid).toBe(bluePid);

      await stopControllerService({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
        protectCallerAncestry: false,
        requireFullStop: false,
      });
    } finally {
      if (previousHome === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
      else process.env.REPO_HARNESS_CONTROLLER_HOME = previousHome;
      if (previousSource === undefined) delete process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
      else process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT = previousSource;
      if (previousOwner === undefined) delete process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER;
      else process.env.REPO_HARNESS_CONTROLLER_LIFECYCLE_OWNER = previousOwner;
    }
  }, 120_000);

  test('rollout cutover flips active slot and rollback restores previous', async () => {
    const fixture = await createIsolatedControllerFixture();
    const previousHome = process.env.REPO_HARNESS_CONTROLLER_HOME;
    const previousSource = process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
    Object.assign(process.env, isolatedControllerEnv(fixture, {
      REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT: ROOT,
    }));

    try {
      writeActiveSlotAuthority(fixture.controllerHome, { activeSlot: 'blue', reason: 'test' });
      const blueHome = ensureSlotHome(fixture.controllerHome, 'blue');
      seedSlotConfig(blueHome, {
        mcpPort: fixture.mcpPort,
        localControllerPort: fixture.localControllerPort,
      });
      // Also seed root config for rollout bootstrap.
      writeMcpServiceLocalConfig(fixture.controllerHome, {
        version: 1,
        profile: 'controller',
        auth: { mode: 'bearer' },
        server: { host: '127.0.0.1', port: fixture.mcpPort },
        localController: {
          enabled: true,
          host: '127.0.0.1',
          port: fixture.localControllerPort,
          autoOpen: false,
        },
      });

      await startControllerService({
        repo: fixture.repoRoot,
        controllerHome: blueHome,
        startTimeoutMs: 45_000,
        logFile: join(blueHome, 'logs', 'controller.log'),
      });

      const rollout = await controllerRollout({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        candidatePorts: {
          mcpPort: fixture.greenMcpPort,
          localControllerPort: fixture.greenLocalPort,
        },
        startTimeoutMs: 45_000,
        skipDurableJob: false,
      });
      if (rollout.status !== 'succeeded') {
        throw new Error(`rollout failed: ${rollout.phase} ${rollout.summary}\n${rollout.keyOutput}\n${JSON.stringify(rollout.details, null, 2)}`);
      }
      expect(rollout.status).toBe('succeeded');
      expect(readActiveSlotAuthority(fixture.controllerHome).activeSlot).toBe('green');

      const rollback = await controllerRollback({
        repo: fixture.repoRoot,
        controllerHome: fixture.controllerHome,
        skipDurableJob: true,
      });
      if (rollback.status !== 'succeeded') {
        throw new Error(`rollback failed: ${rollback.phase} ${rollback.summary}\n${rollback.keyOutput}\n${JSON.stringify(rollback.details, null, 2)}`);
      }
      expect(rollback.status).toBe('succeeded');
      expect(readActiveSlotAuthority(fixture.controllerHome).activeSlot).toBe('blue');

      // Cleanup both slots.
      for (const slot of ['blue', 'green'] as const) {
        const home = ensureSlotHome(fixture.controllerHome, slot);
        await stopControllerService({
          repo: fixture.repoRoot,
          controllerHome: home,
          protectCallerAncestry: false,
          requireFullStop: true,
        }).catch(() => undefined);
      }
    } finally {
      if (previousHome === undefined) delete process.env.REPO_HARNESS_CONTROLLER_HOME;
      else process.env.REPO_HARNESS_CONTROLLER_HOME = previousHome;
      if (previousSource === undefined) delete process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT;
      else process.env.REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT = previousSource;
    }
  }, 180_000);

  test('slot homes never share PID/state files with each other', async () => {
    const fixture = await createIsolatedControllerFixture();
    const blue = ensureSlotHome(fixture.controllerHome, 'blue');
    const green = ensureSlotHome(fixture.controllerHome, 'green');
    mkdirSync(join(blue, 'daemon'), { recursive: true });
    mkdirSync(join(green, 'daemon'), { recursive: true });
    writeFileSync(join(blue, 'daemon', 'controller.pid'), '111\n');
    writeFileSync(join(green, 'daemon', 'controller.pid'), '222\n');
    expect(blue).not.toBe(green);
    expect(existsSync(join(blue, 'daemon', 'controller.pid'))).toBe(true);
    expect(existsSync(join(green, 'daemon', 'controller.pid'))).toBe(true);
    writeSlotIdentity(fixture.controllerHome, {
      schemaVersion: 1,
      slot: 'blue',
      role: 'active',
      controllerHome: fixture.controllerHome,
      slotHome: blue,
      mcpPort: fixture.mcpPort,
      localControllerPort: fixture.localControllerPort,
      updatedAt: new Date().toISOString(),
      logDir: join(blue, 'logs'),
    });
    // No real controller processes should match the temp fixture after unit-only work.
    const leaked = findProcessesByCommand([fixture.controllerHome]);
    expect(leaked.filter((p) => !p.command.includes('bun test'))).toEqual([]);
  });
});
