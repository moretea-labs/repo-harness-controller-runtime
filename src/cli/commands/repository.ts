import { Command } from 'commander';
import { executeRepositoryCommand } from '../repositories/command-executor';
import { bindRepositoryEntities } from '../repositories/entity-migration';
import { withControllerLock } from '../repositories/locks';
import {
  disableRepository,
  focusRepository,
  getRepository,
  getRepositoryFocus,
  listRepositories,
  refreshRepository,
  registerRepository,
  removeRepository,
  repositorySummary,
  resolveRepositorySelection,
  updateRepository,
  validateRepository,
} from '../repositories/registry';
import { ensureRepositoryRuntimeStorage } from '../repositories/runtime-storage';
import { runRepositoryRollout } from '../repositories/rollout';
import type { RepositoryRecord } from '../repositories/types';
import { buildControllerWorkbench } from '../repositories/workbench';
import { createUmbrellaIssue, getUmbrellaIssue, listUmbrellaIssues, updateUmbrellaTask } from '../repositories/umbrella';

function output(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function common(command: Command): Command {
  return command
    .option('--controller-home <path>', 'Controller global data directory')
    .option('--json', 'Output JSON');
}

function initializeRepository(repository: RepositoryRecord, controllerHome?: string) {
  const runtimeStorage = ensureRepositoryRuntimeStorage(repository, controllerHome);
  const migration = bindRepositoryEntities(repository);
  return { repository, runtimeStorage, migration };
}

export function buildRepositoryCommand(): Command {
  const command = new Command('repo').description('Register and inspect repositories managed by the global Controller');

  common(command.command('register')
    .description('Register a Git repository without relying on the Controller startup directory')
    .argument('<path>', 'Repository checkout path')
    .option('--name <display-name>', 'Display name')
    .option('--remote <url>', 'Override remote URL')
    .option('--default-branch <branch>', 'Override default branch'))
    .action((path: string, opts: { controllerHome?: string; name?: string; remote?: string; defaultBranch?: string; json?: boolean }) => {
      const repository = registerRepository({ path, controllerHome: opts.controllerHome, displayName: opts.name, remoteUrl: opts.remote, defaultBranch: opts.defaultBranch });
      output(initializeRepository(repository, opts.controllerHome), opts.json === true);
    });

  common(command.command('list').description('List registered repositories')
    .option('--all', 'Include removed audit records'))
    .action((opts: { controllerHome?: string; all?: boolean; json?: boolean }) => {
      const repositories = listRepositories(opts.controllerHome, { includeRemoved: opts.all === true });
      output({ repositories: repositories.map(repositorySummary), focus: getRepositoryFocus(opts.controllerHome) }, opts.json === true);
    });

  common(command.command('inspect').description('Inspect one repository')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      output(getRepository(repoId, opts.controllerHome, { includeRemoved: true }), opts.json === true);
    });

  common(command.command('validate').description('Validate checkout identity, runtime storage, and legacy entities')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      const repository = getRepository(repoId, opts.controllerHome, { includeRemoved: true });
      output({ validation: validateRepository(repoId, opts.controllerHome), ...initializeRepository(repository, opts.controllerHome) }, opts.json === true);
    });

  common(command.command('command')
    .description('Preview or confirm one repository-scoped local command with Git snapshots and audit evidence')
    .argument('<repo-id>', 'Stable repository ID')
    .requiredOption('--cmd <command>', 'Command to inspect or execute inside the selected repository')
    .option('--checkout-id <checkout-id>', 'Select a registered checkout')
    .option('--cwd <path>', 'Repository-relative working directory', '.')
    .option('--confirm-token <token>', 'Confirm the exact plan returned by the latest preview')
    .option('--dry-run', 'Classify and preview without executing')
    .option('--timeout-ms <milliseconds>', 'Execution timeout', (value) => Number.parseInt(value, 10))
    .option('--max-output-bytes <bytes>', 'Maximum captured output', (value) => Number.parseInt(value, 10)))
    .action((repoId: string, opts: {
      controllerHome?: string;
      checkoutId?: string;
      cmd: string;
      cwd?: string;
      confirmToken?: string;
      dryRun?: boolean;
      timeoutMs?: number;
      maxOutputBytes?: number;
      json?: boolean;
    }) => {
      const repository = resolveRepositorySelection({
        repoId,
        checkoutId: opts.checkoutId,
        controllerHome: opts.controllerHome,
        allowSoleRepository: false,
      });
      const result = withControllerLock(
        opts.controllerHome ?? '',
        { scope: 'repository', repoId: repository.repoId },
        'cli:repo-command',
        () => executeRepositoryCommand(opts.controllerHome ?? '', repository, {
          command: opts.cmd,
          cwd: opts.cwd,
          authorization: opts.confirmToken ? 'confirmed_plan' : undefined,
          approvalToken: opts.confirmToken,
          dryRun: opts.dryRun === true,
          timeoutMs: opts.timeoutMs,
          maxOutputBytes: opts.maxOutputBytes,
        }),
        Math.min(Math.max(Math.trunc(opts.timeoutMs ?? 120000) + 30000, 60000), 960000),
      );
      output(result, opts.json === true);
      if (result.status === 'approval_required') process.exitCode = 3;
      else if (result.status === 'executed' && result.ok === false) process.exitCode = 1;
    });

  common(command.command('update').description('Update repository metadata')
    .argument('<repo-id>', 'Stable repository ID')
    .option('--name <display-name>', 'Display name')
    .option('--default-branch <branch>', 'Default branch')
    .option('--enable', 'Enable repository'))
    .action((repoId: string, opts: { controllerHome?: string; name?: string; defaultBranch?: string; enable?: boolean; json?: boolean }) => {
      output(updateRepository(repoId, { displayName: opts.name, defaultBranch: opts.defaultBranch, enabled: opts.enable === true ? true : undefined }, opts.controllerHome), opts.json === true);
    });

  common(command.command('refresh').description('Refresh Git, remote metadata, runtime storage, and legacy ownership')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      const repository = refreshRepository(repoId, opts.controllerHome);
      output(initializeRepository(repository, opts.controllerHome), opts.json === true);
    });

  common(command.command('rollout').description('Apply the latest repo-harness workflow to registered repositories and restart configured MCP controllers')
    .option('--repo-id <repo-id>', 'Restrict rollout to one repository', (value, previous: string[]) => [...previous, value], [])
    .option('--all', 'Include disabled repositories')
    .option('--dry-run', 'Show the repositories that would be updated without applying changes')
    .option('--skip-adopt', 'Skip repo-local harness refresh')
    .option('--skip-restart', 'Skip MCP/controller restart')
    .option('--skip-codex-setup', 'Skip repo-harness mcp setup codex during restart')
    .option('--skip-public-check', 'Skip public endpoint verification during restart')
    .option('--skip-tools-smoke', 'Skip authenticated MCP tools smoke check during restart')
    .option('--skip-github-plugin', 'Skip GitHub plugin refresh during restart'))
    .action(async (opts: {
      controllerHome?: string;
      repoId?: string[];
      all?: boolean;
      dryRun?: boolean;
      skipAdopt?: boolean;
      skipRestart?: boolean;
      skipCodexSetup?: boolean;
      skipPublicCheck?: boolean;
      skipToolsSmoke?: boolean;
      skipGithubPlugin?: boolean;
      json?: boolean;
    }) => {
      output(await runRepositoryRollout({
        controllerHome: opts.controllerHome,
        repoIds: opts.repoId ?? [],
        includeDisabled: opts.all === true,
        dryRun: opts.dryRun === true,
        skipAdopt: opts.skipAdopt === true,
        skipRestart: opts.skipRestart === true,
        skipCodexSetup: opts.skipCodexSetup === true,
        skipPublicCheck: opts.skipPublicCheck === true,
        skipToolsSmoke: opts.skipToolsSmoke === true,
        skipGithubPlugin: opts.skipGithubPlugin === true,
      }), opts.json === true);
    });

  common(command.command('disable').description('Disable new execution while retaining history')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => output(disableRepository(repoId, opts.controllerHome), opts.json === true));

  common(command.command('remove').description('Soft-remove a repository while retaining Controller audit state')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => output(removeRepository(repoId, opts.controllerHome), opts.json === true));

  common(command.command('focus').description('Set an interactive UI preference; never used as an execution security boundary')
    .argument('[repo-id]', 'Stable repository ID; omit to clear focus'))
    .action((repoId: string | undefined, opts: { controllerHome?: string; json?: boolean }) => output(focusRepository(repoId, opts.controllerHome), opts.json === true));

  common(command.command('workbench').description('Show global or repository-scoped Workbench state')
    .option('--repo-id <repo-id>', 'Filter to one repository')
    .option('--all', 'Include disabled and removed audit records'))
    .action((opts: { controllerHome?: string; repoId?: string; all?: boolean; json?: boolean }) => {
      output(buildControllerWorkbench(opts.controllerHome ?? '', { repoId: opts.repoId, includeRemoved: opts.all === true }), opts.json === true);
    });

  const umbrella = command.command('umbrella').description('Coordinate a multi-repository work item while keeping every executable Task repository-local');
  common(umbrella.command('list')).action((opts: { controllerHome?: string; json?: boolean }) => output(listUmbrellaIssues(opts.controllerHome), opts.json === true));
  common(umbrella.command('inspect').argument('<umbrella-id>')).action((id: string, opts: { controllerHome?: string; json?: boolean }) => output(getUmbrellaIssue(id, opts.controllerHome), opts.json === true));
  common(umbrella.command('create')
    .argument('<umbrella-id>')
    .requiredOption('--title <title>')
    .option('--summary <summary>')
    .requiredOption('--task <repoId:taskId:title...>', 'Repeat for each repository task', (value, previous: string[]) => [...previous, value], []))
    .action((id: string, opts: { controllerHome?: string; title: string; summary?: string; task: string[]; json?: boolean }) => {
      const tasks = opts.task.map((value) => {
        const [repoId, taskId, ...title] = value.split(':');
        if (!repoId || !taskId || title.length === 0) throw new Error(`invalid --task value: ${value}`);
        return { repoId, taskId, title: title.join(':') };
      });
      output(createUmbrellaIssue({ controllerHome: opts.controllerHome, umbrellaId: id, title: opts.title, summary: opts.summary, tasks }), opts.json === true);
    });
  common(umbrella.command('update-task')
    .argument('<umbrella-id>')
    .requiredOption('--repo-id <repo-id>')
    .requiredOption('--task-id <task-id>')
    .requiredOption('--status <status>')
    .option('--run-id <run-id>')
    .option('--commit <sha>')
    .option('--rollback-ref <ref>')
    .option('--error <message>'))
    .action((id: string, opts: { controllerHome?: string; repoId: string; taskId: string; status: any; runId?: string; commit?: string; rollbackRef?: string; error?: string; json?: boolean }) => {
      output(updateUmbrellaTask({ controllerHome: opts.controllerHome, umbrellaId: id, repoId: opts.repoId, taskId: opts.taskId, status: opts.status, runId: opts.runId, commitSha: opts.commit, rollbackRef: opts.rollbackRef, error: opts.error }), opts.json === true);
    });

  return command;
}
