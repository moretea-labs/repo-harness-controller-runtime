import { Command } from 'commander';
import { bindRepositoryEntities } from '../repositories/entity-migration';
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
  updateRepository,
  validateRepository,
} from '../repositories/registry';
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
      output({ repository, migration: bindRepositoryEntities(repository) }, opts.json === true);
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

  common(command.command('validate').description('Validate checkout identity and migrate legacy entities')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      const repository = getRepository(repoId, opts.controllerHome, { includeRemoved: true });
      output({ validation: validateRepository(repoId, opts.controllerHome), migration: bindRepositoryEntities(repository) }, opts.json === true);
    });

  common(command.command('update').description('Update repository metadata')
    .argument('<repo-id>', 'Stable repository ID')
    .option('--name <display-name>', 'Display name')
    .option('--default-branch <branch>', 'Default branch')
    .option('--enable', 'Enable repository'))
    .action((repoId: string, opts: { controllerHome?: string; name?: string; defaultBranch?: string; enable?: boolean; json?: boolean }) => {
      output(updateRepository(repoId, { displayName: opts.name, defaultBranch: opts.defaultBranch, enabled: opts.enable === true ? true : undefined }, opts.controllerHome), opts.json === true);
    });

  common(command.command('refresh').description('Refresh Git and remote metadata')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      const repository = refreshRepository(repoId, opts.controllerHome);
      output({ repository, migration: bindRepositoryEntities(repository) }, opts.json === true);
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
