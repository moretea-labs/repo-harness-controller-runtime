import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AgentExecutableError,
  assertAgentExecutableReady,
  inspectAgentExecutableReadiness,
  readAgentExecutableReadinessSnapshot,
  resolveAgentExecutable,
  revalidateAgentExecutable,
  writeAgentExecutableReadinessSnapshot,
} from '../../src/cli/agent-jobs/executable-resolver';

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fakeCodex(options: { authenticated?: boolean } = {}): { root: string; executable: string } {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-agent-executable-'));
  roots.push(root);
  const executable = join(root, 'codex');
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.test"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  ${options.authenticated === false ? 'echo "Not logged in"; exit 1' : 'echo "Logged in using ChatGPT"; exit 0'}
fi
exit 0
`);
  chmodSync(executable, 0o755);
  return { root, executable };
}

describe('local Agent executable resolver', () => {
  test('persists the stable PATH entry and safe readiness identity', () => {
    const fake = fakeCodex();
    const identity = resolveAgentExecutable('codex', { PATH: fake.root });
    expect(identity.executablePath).toBe(fake.executable);
    expect(identity.version).toBe('codex-cli 0.test');
    expect(identity.authenticationReadiness).toBe('ready');
    expect(revalidateAgentExecutable(identity)).toEqual(identity);

    const readiness = inspectAgentExecutableReadiness('codex', { PATH: fake.root });
    expect(readiness).toMatchObject({
      found: true,
      executablePath: fake.executable,
      version: 'codex-cli 0.test',
      authenticationReadiness: 'ready',
    });
  });

  test('writes and reads a controller-scoped readiness snapshot atomically', () => {
    const fake = fakeCodex();
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-agent-readiness-home-'));
    roots.push(controllerHome);
    process.env.PATH = fake.root;

    const written = writeAgentExecutableReadinessSnapshot(controllerHome, ['codex']);
    expect(written.executors.codex).toMatchObject({
      found: true,
      executablePath: fake.executable,
      version: 'codex-cli 0.test',
      authenticationReadiness: 'ready',
    });
    expect(readAgentExecutableReadinessSnapshot(controllerHome)).toEqual(written);
  });

  test('explicit invalid configuration never falls back to another PATH binary', () => {
    const fake = fakeCodex();
    expect(() => resolveAgentExecutable('codex', {
      PATH: fake.root,
      REPO_HARNESS_CODEX_EXECUTABLE: join(fake.root, 'missing-codex'),
    })).toThrow(AgentExecutableError);
    try {
      resolveAgentExecutable('codex', {
        PATH: fake.root,
        REPO_HARNESS_CODEX_EXECUTABLE: join(fake.root, 'missing-codex'),
      });
    } catch (error) {
      expect((error as AgentExecutableError).code).toBe('AGENT_EXECUTABLE_NOT_EXECUTABLE');
    }
  });

  test('authentication failure is classified independently from executable readiness', () => {
    const fake = fakeCodex({ authenticated: false });
    const identity = resolveAgentExecutable('codex', { PATH: fake.root });
    expect(identity.authenticationReadiness).toBe('required');
    expect(() => assertAgentExecutableReady(identity)).toThrow(AgentExecutableError);
    try {
      assertAgentExecutableReady(identity);
    } catch (error) {
      expect((error as AgentExecutableError).code).toBe('AGENT_AUTHENTICATION_REQUIRED');
    }
  });

  test('unknown Codex authentication readiness fails closed', () => {
    const fake = fakeCodex();
    const identity = resolveAgentExecutable('codex', { PATH: fake.root });
    const unknown = { ...identity, authenticationReadiness: 'unknown' as const };
    expect(() => assertAgentExecutableReady(unknown)).toThrow(AgentExecutableError);
    try {
      assertAgentExecutableReady(unknown);
    } catch (error) {
      expect((error as AgentExecutableError).code).toBe('AGENT_AUTHENTICATION_UNVERIFIED');
    }
  });

  test('Worker revalidation fails closed when the admitted executable changes', () => {
    const fake = fakeCodex();
    const identity = resolveAgentExecutable('codex', { PATH: fake.root });
    writeFileSync(fake.executable, '#!/bin/sh\necho changed\n');
    chmodSync(fake.executable, 0o755);
    expect(() => revalidateAgentExecutable(identity)).toThrow(AgentExecutableError);
    try {
      revalidateAgentExecutable(identity);
    } catch (error) {
      expect((error as AgentExecutableError).code).toBe('AGENT_EXECUTABLE_IDENTITY_CHANGED');
    }
  });
});
