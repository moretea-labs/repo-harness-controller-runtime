import { spawn, type ChildProcess } from 'child_process';

export interface StableIngressProcessOptions {
  executable: string;
  repoRoot: string;
  controllerHome: string;
  host: string;
  port: number;
  rescueHost: string;
  rescuePort: number;
  blueUpstreamPort: number;
  greenUpstreamPort: number;
  startupTimeoutMs?: number;
}

export interface StableIngressProcessHandle {
  host: string;
  port: number;
  pid: number;
  alive(): boolean;
  close(): Promise<void>;
}

interface IngressReadyMessage {
  type: 'repo-harness-ingress-ready';
  host: string;
  port: number;
  pid: number;
  parentPid: number;
}

function isReadyMessage(value: unknown): value is IngressReadyMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<IngressReadyMessage>;
  return message.type === 'repo-harness-ingress-ready'
    && typeof message.host === 'string'
    && Number.isInteger(message.port)
    && Number.isInteger(message.pid)
    && Number.isInteger(message.parentPid);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export async function createStableIngressProcess(options: StableIngressProcessOptions): Promise<StableIngressProcessHandle> {
  const args = [
    options.executable,
    '--ingress-child',
    '--repo', options.repoRoot,
    '--controller-home', options.controllerHome,
    '--stable-ingress-host', options.host,
    '--stable-ingress-port', String(options.port),
    '--rescue-host', options.rescueHost,
    '--rescue-port', String(options.rescuePort),
    '--blue-upstream-port', String(options.blueUpstreamPort),
    '--green-upstream-port', String(options.greenUpstreamPort),
    '--parent-pid', String(process.pid),
  ];
  const child = spawn(process.execPath, args, {
    cwd: options.repoRoot,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      REPO_HARNESS_SUPERVISOR_INGRESS_CHILD: '1',
    },
  });

  const ready = await new Promise<IngressReadyMessage>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error('SUPERVISOR_INGRESS_STARTUP_TIMEOUT'));
    }, options.startupTimeoutMs ?? 10_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onMessage = (message: unknown): void => {
      if (!isReadyMessage(message) || message.parentPid !== process.pid) return;
      cleanup();
      resolveReady(message);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectReady(new Error(`SUPERVISOR_INGRESS_EXITED_BEFORE_READY code=${String(code)} signal=${String(signal)}`));
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  }).catch(async (error) => {
    await stopChild(child);
    throw error;
  });

  return {
    host: ready.host,
    port: ready.port,
    pid: ready.pid,
    alive: () => child.exitCode === null && child.signalCode === null && !child.killed,
    close: async () => await stopChild(child),
  };
}
