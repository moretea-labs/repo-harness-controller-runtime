import { resolve } from 'path';
import { scheduleServiceActivation } from '../src/cli/commands/supervisor';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const repoRoot = resolve(option('--repo') ?? process.cwd());
const controllerHome = resolve(option('--controller-home') ?? `${repoRoot}/_ops/controller-home`);
const delayValue = Number(option('--handoff-delay-ms') ?? '750');
const handoffDelayMs = Number.isFinite(delayValue)
  ? Math.max(750, Math.min(Math.trunc(delayValue), 30_000))
  : 750;

const activation = scheduleServiceActivation(repoRoot, controllerHome, handoffDelayMs);
console.log(JSON.stringify({
  accepted: true,
  repoRoot,
  controllerHome,
  activation,
  reconnectContract: 'stable_domain_retry',
}, null, 2));
