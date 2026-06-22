import { buildProgram } from './index';
import { buildRepositoryCommand } from './commands/repository';
import { CLI_VERSION } from './commands/status';

export function buildV81Program() {
  const program = buildProgram();
  program.addCommand(buildRepositoryCommand());
  return program;
}

export async function runV81Cli(argv: string[] = process.argv): Promise<void> {
  const args = argv.slice(2);
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
    console.log(CLI_VERSION);
    return;
  }
  await buildV81Program().parseAsync(argv);
}

if (import.meta.main) {
  try {
    await runV81Cli(process.argv);
  } catch (error) {
    const value = error as { exitCode?: number; message?: string };
    if (typeof value.exitCode === 'number') process.exit(value.exitCode);
    if (value.message) console.error(value.message);
    process.exit(1);
  }
}
