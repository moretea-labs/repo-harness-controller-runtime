import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  allocateSlotPorts,
  ensureSlotHome,
  isRollbackWindowOpen,
  markCutoverAuthority,
  markRollbackAuthority,
  oppositeSlot,
  readActiveSlotAuthority,
  readSlotIdentity,
  runtimeSlotForHome,
  slotsShareRuntimeState,
  writeActiveSlotAuthority,
  writeSlotIdentity,
} from '../../src/cli/controller/runtime-slots';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('runtime slot authority (level 1)', () => {
  test('defaults to blue and never shares slot homes', () => {
    const home = temp('repo-harness-slots-');
    const authority = readActiveSlotAuthority(home);
    expect(authority.activeSlot).toBe('blue');
    const blue = ensureSlotHome(home, 'blue');
    const green = ensureSlotHome(home, 'green');
    expect(slotsShareRuntimeState(blue, green)).toBe(false);
    expect(blue).toContain('/runtime-slots/blue');
    expect(green).toContain('/runtime-slots/green');
    expect(runtimeSlotForHome(blue)).toBe('blue');
    expect(runtimeSlotForHome(green)).toBe('green');
    expect(runtimeSlotForHome(home)).toBeUndefined();
  });

  test('inactive slot ports are offset from active base ports', () => {
    const activePorts = allocateSlotPorts('blue', 'blue', { mcpPort: 8765, localControllerPort: 8766 });
    const inactivePorts = allocateSlotPorts('green', 'blue', { mcpPort: 8765, localControllerPort: 8766 });
    expect(activePorts.mcpPort).toBe(8765);
    expect(inactivePorts.mcpPort).toBe(8775);
    expect(inactivePorts.localControllerPort).toBe(8776);
  });

  test('cutover flips active authority and enables rollback window', () => {
    const home = temp('repo-harness-cutover-');
    writeActiveSlotAuthority(home, { activeSlot: 'blue', reason: 'test' });
    const after = markCutoverAuthority(home, 'green', 'runtime-gen-1', 60_000);
    expect(after.activeSlot).toBe('green');
    expect(after.previousSlot).toBe('blue');
    expect(after.generation).toBe('runtime-gen-1');
    expect(isRollbackWindowOpen(after)).toBe(true);

    const rolled = markRollbackAuthority(home, 'runtime-gen-0');
    expect(rolled.activeSlot).toBe('blue');
    expect(rolled.previousSlot).toBe('green');
  });

  test('opposite slot is deterministic', () => {
    expect(oppositeSlot('blue')).toBe('green');
    expect(oppositeSlot('green')).toBe('blue');
  });

  test('slot identity records role without becoming active authority', () => {
    const home = temp('repo-harness-identity-');
    writeSlotIdentity(home, {
      schemaVersion: 1,
      slot: 'green',
      role: 'candidate',
      controllerHome: home,
      slotHome: ensureSlotHome(home, 'green'),
      mcpPort: 8775,
      localControllerPort: 8776,
      updatedAt: new Date().toISOString(),
      logDir: join(home, 'runtime-slots', 'green', 'logs'),
    });
    expect(readActiveSlotAuthority(home).activeSlot).toBe('blue');
    const identity = readSlotIdentity(home, 'green');
    expect(identity?.resources?.[0]).toMatchObject({
      type: 'runtime_slot',
      owner: { kind: 'runtime_slot' },
      state: 'active',
      path: identity?.slotHome,
    });
  });
});
