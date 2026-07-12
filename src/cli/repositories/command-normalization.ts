export type RepositoryCommandValue = string | string[];

export interface CanonicalRepositoryCommand {
  readonly kind: 'shell' | 'argv';
  /** The durable, audit, approval, and transport representation. */
  readonly value: RepositoryCommandValue;
  /** Present only for typed argv commands. */
  readonly executable?: string;
  /** Present only for typed argv commands. Never passed through a shell. */
  readonly args?: readonly string[];
  /** Present only for legacy shell-string commands. */
  readonly shellCommand?: string;
}

const MAX_COMMAND_LENGTH = 32 * 1024;

export function normalizeRepositoryCommand(input: unknown): CanonicalRepositoryCommand {
  if (typeof input === 'string') {
    const shellCommand = input.trim();
    if (!shellCommand) throw new Error('COMMAND_INVALID: command is required');
    if (shellCommand.includes('\0')) throw new Error('COMMAND_INVALID: command contains a null byte');
    return { kind: 'shell', value: shellCommand, shellCommand };
  }
  if (!Array.isArray(input)) {
    throw new Error('COMMAND_INVALID: command must be a shell string or argv string array');
  }
  if (input.length === 0) throw new Error('COMMAND_INVALID: argv must contain an executable');
  const argv = input.map((part, index) => {
    if (typeof part !== 'string') {
      throw new Error(`COMMAND_INVALID: argv[${index}] must be a string`);
    }
    if (part.includes('\0')) throw new Error(`COMMAND_INVALID: argv[${index}] contains a null byte`);
    return part;
  });
  if (!argv[0]?.trim()) throw new Error('COMMAND_INVALID: argv executable is required');
  if (argv.reduce((total, part) => total + part.length, 0) > MAX_COMMAND_LENGTH) {
    throw new Error(`COMMAND_INVALID: command exceeds ${MAX_COMMAND_LENGTH} characters`);
  }
  return {
    kind: 'argv',
    value: argv,
    executable: argv[0],
    args: argv.slice(1),
  };
}

export function commandValue(command: CanonicalRepositoryCommand): RepositoryCommandValue {
  return typeof command.value === 'string' ? command.value : [...command.value];
}

export function commandExecutable(command: CanonicalRepositoryCommand): string {
  return command.kind === 'argv' ? command.executable! : command.shellCommand!;
}
