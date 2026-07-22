import { readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import type { ActiveSlotAuthority, SlotIdentity } from '../../cli/controller/runtime-slots';
import { launchAgentPath } from '../../cli/controller/launch-agents';
import { supervisorServiceLabel, supervisorSystemdUnitName } from './installer';
import { readCurrentSupervisorRelease, supervisorRoot, type SupervisorReleaseDescriptor } from './paths';
import type { SupervisorState } from './types';

export interface RuntimeReleaseCoherence {
  ok: boolean;
  legacyReleaseMetadata: boolean;
  releasePathCoherent: boolean;
  releaseRevisionCoherent: boolean;
  releaseCoherent: boolean;
  generationCoherent: boolean;
  slotCoherent: boolean;
  failures: string[];
}

function normalizedPath(value: string | undefined): string | undefined {
  return value ? resolve(value) : undefined;
}

function compareRequiredValues(
  label: string,
  values: Array<{ name: string; value: string | undefined }>,
  failures: string[],
  options: { allowAllMissing?: boolean } = {},
): { coherent: boolean; allMissing: boolean } {
  const present = values.filter((entry) => entry.value !== undefined);
  if (present.length === 0) {
    if (options.allowAllMissing) return { coherent: true, allMissing: true };
    failures.push(`${label} metadata is missing`);
    return { coherent: false, allMissing: true };
  }
  if (present.length !== values.length) {
    const missing = values.filter((entry) => entry.value === undefined).map((entry) => entry.name);
    failures.push(`${label} metadata is partial; missing ${missing.join(', ')}`);
    return { coherent: false, allMissing: false };
  }
  const expected = present[0]!.value;
  const mismatched = present.filter((entry) => entry.value !== expected);
  if (mismatched.length > 0) {
    failures.push(`${label} mismatch: ${present.map((entry) => `${entry.name}=${entry.value}`).join(' ')}`);
    return { coherent: false, allMissing: false };
  }
  return { coherent: true, allMissing: false };
}

/**
 * Evaluate the exact immutable release and runtime generation owned by the
 * active Stable Supervisor slot. Legacy runtimes are accepted only when every
 * release metadata field is absent; partially populated metadata fails closed.
 */
export function evaluateRuntimeReleaseCoherence(input: {
  supervisorState: SupervisorState | null | undefined;
  authority: ActiveSlotAuthority;
  slotIdentity?: SlotIdentity;
}): RuntimeReleaseCoherence {
  const state = input.supervisorState;
  if (!state) {
    return {
      ok: true,
      legacyReleaseMetadata: true,
      releasePathCoherent: true,
      releaseRevisionCoherent: true,
      releaseCoherent: true,
      generationCoherent: true,
      slotCoherent: true,
      failures: [],
    };
  }

  const failures: string[] = [];
  const releasePaths = compareRequiredValues('release path', [
    { name: 'supervisor', value: normalizedPath(state.supervisor.releasePath) },
    { name: 'daemon', value: normalizedPath(state.controllerDaemon?.releasePath) },
    { name: 'gateway', value: normalizedPath(state.gatewayHost?.releasePath) },
    { name: 'slot', value: normalizedPath(input.slotIdentity?.releasePath) },
  ], failures, { allowAllMissing: true });
  const releaseRevisions = compareRequiredValues('release revision', [
    { name: 'supervisor', value: state.supervisor.releaseRevision },
    { name: 'daemon', value: state.controllerDaemon?.releaseRevision },
    { name: 'gateway', value: state.gatewayHost?.releaseRevision },
    { name: 'slot', value: input.slotIdentity?.releaseRevision },
  ], failures, { allowAllMissing: true });
  const generations = compareRequiredValues('runtime generation', [
    { name: 'supervisor-state', value: state.activeGeneration },
    { name: 'daemon', value: state.controllerDaemon?.generation },
    { name: 'gateway', value: state.gatewayHost?.generation },
    { name: 'authority', value: input.authority.generation },
    { name: 'slot', value: input.slotIdentity?.generation },
  ], failures);
  const slots = compareRequiredValues('active slot', [
    { name: 'supervisor-state', value: state.activeSlot },
    { name: 'daemon', value: state.controllerDaemon?.slot },
    { name: 'gateway', value: state.gatewayHost?.slot },
    { name: 'authority', value: input.authority.activeSlot },
    { name: 'slot-identity', value: input.slotIdentity?.slot },
  ], failures);

  const legacyReleaseMetadata = releasePaths.allMissing && releaseRevisions.allMissing;
  if (releasePaths.allMissing !== releaseRevisions.allMissing) {
    failures.push('release metadata is partial across path and revision fields');
  }
  const releasePathCoherent = releasePaths.coherent;
  const releaseRevisionCoherent = releaseRevisions.coherent;
  const releaseCoherent = releasePathCoherent
    && releaseRevisionCoherent
    && releasePaths.allMissing === releaseRevisions.allMissing;
  const generationCoherent = generations.coherent;
  const slotCoherent = slots.coherent;

  return {
    ok: releaseCoherent && generationCoherent && slotCoherent,
    legacyReleaseMetadata,
    releasePathCoherent,
    releaseRevisionCoherent,
    releaseCoherent,
    generationCoherent,
    slotCoherent,
    failures,
  };
}

export interface SupervisorServiceReleaseDescriptor {
  releasePath?: string;
  releaseRevision?: string;
}

export interface SupervisorServiceReleaseCoherence {
  ok: boolean;
  expected?: SupervisorServiceReleaseDescriptor;
  running?: SupervisorServiceReleaseDescriptor;
  generated?: SupervisorServiceReleaseDescriptor;
  installed?: SupervisorServiceReleaseDescriptor;
  serviceRegistered: boolean;
  failures: string[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Extract the immutable Supervisor release carried by a launchd plist or systemd unit. */
export function extractSupervisorServiceRelease(text: string | undefined): SupervisorServiceReleaseDescriptor | undefined {
  if (!text?.trim()) return undefined;
  const xmlArguments = [...text.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => decodeXml(match[1] ?? ''));
  const argumentsList = xmlArguments.length > 0 ? xmlArguments : text.split(/\s+/).filter(Boolean);
  const executable = argumentsList.find((value) => /(?:^|\/)supervisor\.js$/.test(value));
  const revisionFlag = argumentsList.indexOf('--release-revision');
  const releaseRevision = revisionFlag >= 0 ? argumentsList[revisionFlag + 1] : undefined;
  const releasePath = executable ? dirname(resolve(executable)) : undefined;
  if (!releasePath && !releaseRevision) return undefined;
  return { releasePath, releaseRevision };
}

function canonicalReleasePath(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

function compareServiceRelease(
  label: string,
  expected: SupervisorServiceReleaseDescriptor | undefined,
  actual: SupervisorServiceReleaseDescriptor | undefined,
  failures: string[],
): void {
  if (!expected?.releasePath || !expected.releaseRevision) {
    failures.push('current Supervisor release metadata is missing');
    return;
  }
  if (!actual?.releasePath || !actual.releaseRevision) {
    failures.push(`${label} Supervisor release metadata is missing`);
    return;
  }
  const expectedPath = canonicalReleasePath(expected.releasePath);
  const actualPath = canonicalReleasePath(actual.releasePath);
  if (actualPath !== expectedPath || actual.releaseRevision !== expected.releaseRevision) {
    failures.push(`${label} Supervisor release mismatch: expected=${expected.releaseRevision}@${expectedPath} actual=${actual.releaseRevision}@${actualPath}`);
  }
}

export function evaluateSupervisorServiceReleaseCoherence(input: {
  expected?: SupervisorServiceReleaseDescriptor;
  running?: SupervisorServiceReleaseDescriptor;
  generated?: SupervisorServiceReleaseDescriptor;
  installed?: SupervisorServiceReleaseDescriptor;
  serviceRegistered?: boolean;
}): SupervisorServiceReleaseCoherence {
  const failures: string[] = [];
  const serviceRegistered = input.serviceRegistered ?? Boolean(input.installed?.releasePath || input.installed?.releaseRevision);
  compareServiceRelease('running', input.expected, input.running, failures);
  compareServiceRelease('generated service', input.expected, input.generated, failures);
  if (serviceRegistered) compareServiceRelease('installed service', input.expected, input.installed, failures);
  return { ok: failures.length === 0, ...input, serviceRegistered, failures };
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

/**
 * Compare the published `current` release, generated service definition,
 * system-installed service definition, and live Supervisor process. A current
 * Daemon can still be owned by a stale lifecycle Supervisor and leave the
 * stable ingress at 502, so slot coherence alone is not sufficient.
 */
export function readSupervisorServiceReleaseCoherence(
  controllerHome: string,
  supervisorState: SupervisorState | null | undefined,
): SupervisorServiceReleaseCoherence {
  const expectedRelease: SupervisorReleaseDescriptor | undefined = readCurrentSupervisorRelease(controllerHome);
  const label = supervisorServiceLabel(controllerHome);
  const root = supervisorRoot(controllerHome);
  let generatedText: string | undefined;
  let installedText: string | undefined;
  if (process.platform === 'linux') {
    const unit = supervisorSystemdUnitName(controllerHome);
    generatedText = readText(join(root, 'systemd', unit));
    installedText = readText(join(homedir(), '.config', 'systemd', 'user', unit));
  } else {
    generatedText = readText(join(root, 'launchd', `${label}.plist`));
    installedText = readText(launchAgentPath(label));
  }
  const expected = expectedRelease
    ? { releasePath: expectedRelease.releasePath, releaseRevision: expectedRelease.releaseRevision }
    : undefined;
  const running = supervisorState?.supervisor
    ? { releasePath: supervisorState.supervisor.releasePath, releaseRevision: supervisorState.supervisor.releaseRevision }
    : undefined;
  return evaluateSupervisorServiceReleaseCoherence({
    expected,
    running,
    generated: extractSupervisorServiceRelease(generatedText),
    installed: extractSupervisorServiceRelease(installedText),
    serviceRegistered: Boolean(installedText?.trim()),
  });
}
