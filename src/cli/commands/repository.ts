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
      const repository = registerRepository({
        path,
        controllerHome: opts.controllerHome,
        displayName: opts.name,
        remoteUrl: opts.remote,
        defaultBranch: opts.defaultBranch,
      });
      const migration = bindRepositoryEntities(repository);
      output({ repository, migration }, opts.json === true);
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
      output(updateRepository(repoId, {
        displayName: opts.name,
        defaultBranch: opts.defaultBranch,
        enabled: opts.enable === true ? true : undefined,
      }, opts.controllerHome), opts.json === true);
    });

  common(command.command('refresh').description('Refresh Git and remote metadata')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      const repository = refreshRepository(repoId, opts.controllerHome);
      output({ repository, migration: bindRepositoryEntities(repository) }, opts.json === true);
    });

  common(command.command('disable').description('Disable new execution while retaining history')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      output(disableRepository(repoId, opts.controllerHome), opts.json === true);
    });

  common(command.command('remove').description('Soft-remove a repository while retaining Controller audit state')
    .argument('<repo-id>', 'Stable repository ID'))
    .action((repoId: string, opts: { controllerHome?: string; json?: boolean }) => {
      output(removeRepository(repoId, opts.controllerHome), opts.json === true);
    });

  common(command.command('focus').description('Set an interactive UI preference; never used as an execution security boundary')
    .argument('[repo-id]', 'Stable repository ID; omit to clear focus'))
    .action((repoId: string | undefined, opts: { controllerHome?: string; json?: boolean }) => {
      output(focusRepository(repoId, opts.controllerHome), opts.json === true);
    });

  return command;
}
