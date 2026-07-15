import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  assertIsolatedControllerEnv,
  createIsolatedControllerFixture,
  destroyAllIsolatedControllerFixtures,
  isolatedControllerEnv,
} from '../fixtures/isolated-controller-home';
import { assertNotRealControllerHome } from '../../src/cli/controller/bluegreen-rollout';

afterEach(async () => {
  await destroyAllIsolatedControllerFixtures();
});

describe('controller isolation guards (level 1)', () => {
  test('fixture controllerHome is under temp and not the real home', async () => {
    const fixture = await createIsolatedControllerFixture();
    expect(fixture.controllerHome.startsWith(tmpdir()) || fixture.controllerHome.includes('/T/')).toBe(true);
    expect(fixture.controllerHome).not.toBe(join(homedir(), '.repo-harness', 'controller'));
    expect(fixture.mcpPort).not.toBe(8765);
    expect(fixture.localControllerPort).not.toBe(8766);
    assertIsolatedControllerEnv(fixture.controllerHome);
    const env = isolatedControllerEnv(fixture);
    expect(env.REPO_HARNESS_CONTROLLER_HOME).toBe(fixture.controllerHome);
    expect(env.REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL).toBe('none');
  });

  test('assertNotRealControllerHome rejects user global home', () => {
    const real = join(homedir(), '.repo-harness', 'controller');
    expect(() => assertNotRealControllerHome(real, [real])).toThrow(/TEST_GUARD/);
  });
});
