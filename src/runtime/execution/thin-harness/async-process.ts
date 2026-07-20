import { spawn, type ChildProcess } from 'child_process';
import { capProcessOutput, redactProcessOutput } from '../../../effects/process-runner';
import { terminateProcessTree } from '../../shared/process-tree';

export interface BoundedProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** When true (default on non-Windows), create a new process group for tree kill. */
  processGroup?: boolean;
}

export interface BoundedProcessResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  pid?: number;
}

interface OutputCollector {
  write(chunk: string | Buffer): void;
  complete(): string;
}

function createCollector(maxOutputBytes: number): OutputCollector {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  return {
    write(chunk: string | Buffer) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (buffer.length === 0 || totalBytes >= maxOutputBytes) {
        if (buffer.length > 0) truncated = true;
        return;
      }
      const remaining = maxOutputBytes - totalBytes;
      if (buffer.length <= remaining) {
        chunks.push(buffer);
        totalBytes += buffer.length;
        return;
      }
      chunks.push(buffer.subarray(0, remaining));
      totalBytes += remaining;
      truncated = true;
    },
    complete() {
      const text = Buffer.concat(chunks).toString('utf8');
      const redacted = redactProcessOutput(text);
      return truncated
        ? capProcessOutput(`${redacted}\n…[truncated at ${maxOutputBytes} bytes]`, maxOutputBytes)
        : capProcessOutput(redacted, maxOutputBytes);
    },
  };
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill();
    }
  } catch {
    /* already exited */
  }
  await terminateProcessTree(pid, { gracePeriodMs: 200, killAfterMs: 1_000, pollIntervalMs: 25 });
}

/**
 * Async bounded process runner for Fast Path.
 * Streams and caps stdout/stderr while reading; supports AbortSignal and process-group kill.
 */
export async function runBoundedProcess(
  executable: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  if (options.signal?.aborted) {
    return {
      ok: false,
      exitCode: 1,
      timedOut: false,
      cancelled: true,
      stdout: '',
      stderr: 'cancelled before spawn',
    };
  }

  const stdout = createCollector(options.maxOutputBytes);
  const stderr = createCollector(options.maxOutputBytes);
  const useProcessGroup = options.processGroup !== false && process.platform !== 'win32';

  return await new Promise<BoundedProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError = '';
    let timeoutHandle: NodeJS.Timeout | undefined;

    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
      const stderrText = [
        stderr.complete(),
        timedOut ? `process timed out after ${options.timeoutMs}ms` : '',
        cancelled ? 'process cancelled' : '',
        spawnError ? redactProcessOutput(spawnError) : '',
      ].filter(Boolean).join('\n');
      resolve({
        ok: exitCode === 0 && !timedOut && !cancelled && !spawnError,
        exitCode,
        timedOut,
        cancelled,
        stdout: stdout.complete(),
        stderr: capProcessOutput(stderrText, options.maxOutputBytes),
        pid: child.pid,
      });
    };

    const onAbort = () => {
      cancelled = true;
      void killTree(child).finally(() => finish(1));
    };

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killTree(child).finally(() => finish(1));
    }, Math.max(1, options.timeoutMs));
    timeoutHandle.unref?.();

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));
    child.on('error', (error) => {
      spawnError = error.message;
    });
    child.on('close', (code) => {
      finish(code ?? 1);
    });
  });
}

export async function runBoundedGit(
  repoRoot: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<BoundedProcessResult> {
  return runBoundedProcess('git', ['-C', repoRoot, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      CI: '1',
    },
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
  });
}
