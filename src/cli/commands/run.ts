import { Command } from 'commander';
import { listHelperIds, runHelper } from '../runtime/helper-runner';

export function buildRunCommand(): Command {
  const run = new Command('run')
    .description('Run a bundled repo-harness workflow helper')
    .allowUnknownOption(true);

  run
    .argument('<helper>', 'Helper id, for example check-task-workflow')
    .argument('[args...]', 'Arguments passed to the helper')
    .action((helper: string, args: string[]) => {
      const result = runHelper({ helper, args });
      if (result.stderr && result.reason !== 'ok') {
        console.error(result.stderr);
        const helpers = listHelperIds();
        if (helpers.length > 0) console.error(`known helpers: ${helpers.join(', ')}`);
      }
      process.exit(result.exitCode);
    });

  return run;
}
