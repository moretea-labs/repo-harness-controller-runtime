#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const failures = [];
function text(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    failures.push(`missing required architecture file: ${path}`);
    return '';
  }
  return readFileSync(absolute, 'utf8');
}
function requireText(path, needle) {
  if (!text(path).includes(needle)) failures.push(`${path} must contain ${JSON.stringify(needle)}`);
}
function requireMatch(path, expression, description) {
  if (!expression.test(text(path))) failures.push(`${path} must ${description}`);
}
function forbid(path, expression, description) {
  if (expression.test(text(path))) failures.push(`${path} violates ${description}`);
}

const required = [
  'src/runtime/gateway/mcp/router.ts',
  'src/runtime/control-plane/daemon-entry.ts',
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  'src/runtime/control-plane/repo-actor/actor.ts',
  'src/runtime/execution/jobs/store.ts',
  'src/runtime/execution/jobs/receipt-store.ts',
  'src/runtime/execution/workers/worker-entry.ts',
  'src/runtime/execution/thin-harness/index.ts',
  'src/runtime/execution/thin-harness/execution-router.ts',
  'docs/architecture/current/thin-harness-v1.md',
  'src/runtime/resources/leases/store.ts',
  'src/runtime/evidence/event-ledger.ts',
  'src/runtime/evidence/evidence-store.ts',
  'src/runtime/evidence/artifact-store.ts',
  'src/runtime/projections/materialized-view.ts',
  'src/runtime/projections/controller-context.ts',
  'src/runtime/projections/invalidation.ts',
  'src/runtime/workflow/schedules/engine.ts',
  'scripts/smoke-schedule-engine.ts',
  'src/runtime/workflow/portfolio/engine.ts',
  'src/runtime/workflow/findings/store.ts',
  'src/runtime/release/release-gate.ts',
  'docs/architecture/current/implementation-status.md',
  'docs/architecture/current/runtime-directory-map.md',
  'docs/architecture/current/operations-runbook.md',
  'docs/architecture/current/target-requirements-traceability.md',
  'docs/architecture/current/approved-target-architecture.zh-CN.md',
];
for (const path of required) text(path);

const server = text('src/cli/mcp/server.ts');
const runtimeCall = server.indexOf('callRuntimeTool(ctx, name, args)');
const durableCall = server.indexOf('routeDurableMcpCall(ctx, name, args)');
const legacyCall = server.indexOf('callMultiRepositoryTool(ctx, name, args)');
if (!(runtimeCall >= 0 && durableCall > runtimeCall && legacyCall > durableCall)) {
  failures.push('MCP routing must evaluate runtime reads/control, then durable acceptance, before the legacy Worker-only implementation');
}
requireText('src/runtime/gateway/mcp/router.ts', 'createExecutionJob');
requireText('src/runtime/gateway/mcp/router.ts', 'requestId');
requireText('src/runtime/gateway/mcp/router.ts', 'semanticKey');
requireMatch(
  'src/runtime/gateway/mcp/router.ts',
  /const DIRECT_REPOSITORY_TOOLS = new Set\(\[[\s\S]*?'repository_list'[\s\S]*?'repository_get'[\s\S]*?\]\);/,
  'declare DIRECT_REPOSITORY_TOOLS with repository_list and repository_get',
);
requireText('src/runtime/gateway/mcp/router.ts', "name === 'repository_workbench'");
requireText('src/runtime/gateway/mcp/runtime-tools.ts', "case 'controller_context'");
requireText('src/runtime/gateway/mcp/runtime-tools.ts', "case 'local_bridge_status'");
requireText('src/cli/local-bridge/job-store.ts', 'listLocalBridgeJobSnapshots');
requireText('src/runtime/execution/workers/executor.ts', 'writeControllerContextProjection');
forbid('src/runtime/gateway/mcp/router.ts', /const DIRECT_HOT_READ_TOOLS = new Set\([\s\S]*?['"]controller_context['"][\s\S]*?\);/, 'controller_context must use a materialized projection or Durable Job, never the legacy Gateway path');
forbid('src/runtime/gateway/mcp/router.ts', /const DIRECT_HOT_READ_TOOLS = new Set\([\s\S]*?['"](?:local_bridge_status|get_local_job|get_local_job_output)['"][\s\S]*?\);/, 'Local Bridge observations must use bounded snapshots, never reconciliation in the Gateway');
requireText('src/runtime/execution/jobs/types.ts', 'requestId: string');
requireText('src/runtime/execution/jobs/types.ts', 'semanticKey: string');
requireText('src/runtime/execution/jobs/store.ts', "'active.json'");
requireText('src/runtime/execution/jobs/store.ts', "'recent.json'");
requireText('src/runtime/execution/jobs/store.ts', "'requests'");
requireText('src/runtime/execution/jobs/store.ts', 'transitionExecutionJobFromWorker');
requireText('src/runtime/execution/jobs/receipt-store.ts', "state: 'started' | 'completed'");
requireText('src/runtime/execution/thin-harness/execution-router.ts', "mode: 'fast'");
requireText('src/runtime/execution/thin-harness/execution-router.ts', 'routeExecution');
requireText('src/runtime/execution/thin-harness/types.ts', 'FastExecutionReceipt');
requireText('docs/architecture/current/thin-harness-v1.md', 'Default to direct Fast Path execution');
requireText('src/runtime/resources/leases/types.ts', 'fencingToken: number');
requireText('src/runtime/resources/leases/store.ts', 'assertFencingToken');
requireText('src/runtime/resources/leases/store.ts', 'expectedLeaseMap');
requireText('src/runtime/resources/claims/conflicts.ts', "'repo-content:*'");
requireText('src/runtime/control-plane/repo-actor/actor.ts', 'repo-actor-mailbox');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'maxConcurrentRepositories');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'maxHeavyChecks');
requireText('src/runtime/control-plane/global-scheduler/scheduler.ts', 'maxAgentProcesses');
requireText('src/runtime/workflow/schedules/store.ts', "'occurrences.json'");
requireText('src/runtime/workflow/schedules/types.ts', "'repository-event'");
requireText('src/runtime/workflow/schedules/types.ts', "'dependency-checkpoint'");
requireText('src/runtime/workflow/schedules/store.ts', 'saveScheduleDecision');
requireText('src/runtime/workflow/schedules/settlement.ts', 'backoffMinutes');
requireText('src/runtime/workflow/portfolio/store.ts', "'workflows.json'");
requireText('src/runtime/workflow/portfolio/store.ts', 'PORTFOLIO_DEPENDENCY_CYCLE');
requireText('src/runtime/workflow/findings/store.ts', 'observationCount');
requireText('src/runtime/release/release-gate.ts', 'releaseReady');
requireText('src/cli/mcp/transports/http.ts', "'/ready'");
requireText('src/cli/mcp/transports/http.ts', "'/repos/:repoId/health'");
requireText('src/runtime/control-plane/governance/external-effects.ts', 'EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED');
requireText('src/runtime/control-plane/governance/external-effects.ts', 'AUTOMATED_REQUIREMENT_REQUIRES_CANDIDATE');
requireText('src/cli/mcp/tools.ts', "export * from './legacy-tool-service'");

for (const path of [
  'src/runtime/gateway/mcp/router.ts',
  'src/runtime/gateway/mcp/runtime-tools.ts',
  'src/runtime/control-plane/daemon-entry.ts',
  'src/runtime/control-plane/global-scheduler/scheduler.ts',
  'src/runtime/control-plane/repo-actor/actor.ts',
  'src/runtime/workflow/schedules/engine.ts',
  'src/cli/mcp/transports/http.ts',
]) {
  forbid(path, /\b(?:spawnSync|execSync|execFileSync)\s*\(/, 'the non-blocking Gateway/Controller hot-path rule');
}

requireText('docs/architecture/current/implementation-status.md', 'Thin MCP Gateway | Implemented');
requireText('docs/architecture/current/implementation-status.md', 'Per-Repository Actor | Implemented');
requireText('docs/architecture/current/implementation-status.md', 'Schedule, Trigger, Decision and Occurrence | Implemented');
requireText('docs/architecture/current/implementation-status.md', 'Release Freeze and Gate | Implemented');
requireText('docs/architecture/current/target-requirements-traceability.md', '## 4. Architecture constitution');
requireText('docs/architecture/current/target-requirements-traceability.md', '## 16. Standard execution flow');
requireText('plans/README.md', 'not the runtime execution queue');
if (text('src/cli/mcp/tools.ts').split(/\r?\n/).length > 40) failures.push('src/cli/mcp/tools.ts must remain a thin compatibility facade');

if (failures.length) {
  console.error('[runtime-architecture] FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[runtime-architecture] OK (${required.length} required modules/documents checked)`);
