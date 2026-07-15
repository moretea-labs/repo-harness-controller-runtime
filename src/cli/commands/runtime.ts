import { Command } from 'commander';
import { ensureControllerHome } from '../repositories/controller-home';
import {
  controllerServiceStatus,
  formatControllerServiceStatus,
  startControllerService,
  stopControllerService,
} from '../controller/lifecycle';
import { requestControllerServiceRestart } from '../controller/restart-coordinator';
import { ensureControllerDaemon, readControllerDaemonStatus } from '../../runtime/control-plane/daemon-client';
import { findExecutionJob, listActiveExecutionJobs, listExecutionJobs } from '../../runtime/execution/jobs/store';
import { readJobEvents } from '../../runtime/evidence/event-ledger';
import { listRepositories } from '../repositories/registry';
import { rebuildRepositoryProjection } from '../../runtime/projections/materialized-view';
import { listOccurrences, listSchedules } from '../../runtime/workflow/schedules/store';

function output(value: unknown, json = true): void {
  console.log(json ? JSON.stringify(value, null, 2) : String(value));
}

export function buildRuntimeCommand(): Command {
  const command = new Command('runtime').description('Manage the separated Gateway, Controller Daemon, durable Jobs, Repo Actors, and Workers');

  command.command('start')
    .description('Start the unified runtime supervisor')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string }) => output(await startControllerService(opts)));

  command.command('status')
    .description('Show unified runtime readiness, active durable Jobs, and per-repository materialized projections')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .option('--json', 'Output JSON')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string; json?: boolean }) => {
      const service = await controllerServiceStatus(opts);
      const home = ensureControllerHome(service.controllerHome);
      const repositories = listRepositories(home, { includeRemoved: true });
      if (opts.json) {
        output({
          service,
          daemon: readControllerDaemonStatus(home),
          activeJobs: listActiveExecutionJobs(home),
          repositories: repositories.map((repository) => rebuildRepositoryProjection(home, repository.repoId)),
        });
        return;
      }
      console.log(formatControllerServiceStatus(service));
    });

  command.command('stop')
    .description('Stop the unified runtime supervisor')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string }) => output(await stopControllerService(opts)));

  command.command('restart')
    .description('Restart the unified runtime supervisor')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .option('--request-id <id>', 'Idempotent restart request id')
    .option('--reason <text>', 'Bounded restart reason')
    .option('--detached', 'Always hand the restart to the out-of-band coordinator')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string; requestId?: string; reason?: string; detached?: boolean }) => output(await requestControllerServiceRestart({
      ...opts,
      requestedBy: 'runtime-cli',
      mode: opts.detached ? 'detached' : 'auto',
    })));

  command.command('doctor')
    .description('Run a bounded runtime diagnosis view')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo <path>', 'Repository root')
    .option('--log-file <path>', 'Combined runtime log file')
    .option('--json', 'Output JSON')
    .action(async (opts: { controllerHome?: string; repo?: string; logFile?: string; json?: boolean }) => {
      const service = await controllerServiceStatus(opts);
      if (opts.json) {
        output({ status: service }, true);
        return;
      }
      output(formatControllerServiceStatus(service), false);
    });

  command.command('job')
    .description('Inspect one durable Execution Job and its event ledger')
    .argument('<job-id>', 'Execution Job ID')
    .option('--controller-home <path>', 'Controller state root')
    .action((jobId: string, opts: { controllerHome?: string }) => {
      const home = ensureControllerHome(opts.controllerHome);
      const job = findExecutionJob(home, jobId);
      if (!job) throw new Error(`JOB_NOT_FOUND: ${jobId}`);
      output({ job, events: readJobEvents(home, job.repoId, job.jobId) });
    });

  command.command('jobs')
    .description('List durable Execution Jobs')
    .option('--controller-home <path>', 'Controller state root')
    .option('--repo-id <id>', 'Repository id')
    .option('--limit <count>', 'Maximum records', '100')
    .action((opts: { controllerHome?: string; repoId?: string; limit?: string }) => {
      const home = ensureControllerHome(opts.controllerHome);
      if (opts.repoId) return output({ jobs: listExecutionJobs(home, opts.repoId, Number(opts.limit ?? 100)) });
      output({ jobs: listActiveExecutionJobs(home) });
    });

  command.command('schedules')
    .description('List bounded Schedules and Occurrences')
    .requiredOption('--repo-id <id>', 'Repository id')
    .option('--controller-home <path>', 'Controller state root')
    .action((opts: { controllerHome?: string; repoId: string }) => {
      const home = ensureControllerHome(opts.controllerHome);
      output({ schedules: listSchedules(home, opts.repoId), occurrences: listOccurrences(home, opts.repoId, undefined, 100) });
    });

  return command;
}
