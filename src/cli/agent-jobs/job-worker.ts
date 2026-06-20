import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import type { AgentJobEvent, AgentJobMeta, AgentJobWorkerConfig } from './types';

const configPath = process.argv[2];
if (!configPath) throw new Error('agent job worker requires a config path');

const config = JSON.parse(readFileSync(configPath, 'utf-8')) as AgentJobWorkerConfig;
const prompt = readFileSync(config.promptPath, 'utf-8');
const meta = JSON.parse(readFileSync(config.metaPath, 'utf-8')) as AgentJobMeta;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

function event(type: AgentJobEvent['type'], message?: string, data?: Record<string, unknown>): void {
  appendFileSync(config.eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, message, data })}\n`, 'utf-8');
}

function persistMeta(value: AgentJobMeta): void {
  writeFileSync(config.metaPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function appendBounded(path: string, chunk: Buffer, written: number, truncated: boolean): { written: number; truncated: boolean } {
  if (written >= MAX_STREAM_BYTES) return { written, truncated: true };
  const remaining = MAX_STREAM_BYTES - written;
  const accepted = chunk.subarray(0, remaining);
  if (accepted.length > 0) appendFileSync(path, accepted);
  const nextTruncated = truncated || accepted.length < chunk.length;
  if (nextTruncated && !truncated) appendFileSync(path, '\n[repo-harness] output truncated at 4 MiB\n', 'utf-8');
  return { written: written + accepted.length, truncated: nextTruncated };
}

meta.status = 'running';
meta.startedAt = meta.startedAt ?? new Date().toISOString();
meta.timeoutMs = config.timeoutMs;
meta.deadlineAt = new Date(Date.parse(meta.startedAt) + config.timeoutMs).toISOString();
meta.lastHeartbeatAt = new Date().toISOString();
persistMeta(meta);
event('run_started', `${config.agent} process starting.`);

const command = config.agent === 'codex'
  ? { bin: 'codex', args: ['exec', '--json', '--cd', config.worktree, prompt] }
  : { bin: 'claude', args: ['-p', prompt] };

writeFileSync(config.stdoutPath, '', 'utf-8');
writeFileSync(config.stderrPath, '', 'utf-8');

let stdoutBytes = 0;
let stderrBytes = 0;
let stdoutTruncated = false;
let stderrTruncated = false;
let stderrPreview = '';
let lastLogEventAt = 0;
let timedOut = false;
let spawnError: Error | undefined;

function noteLogUpdate(stream: 'stdout' | 'stderr', bytes: number): void {
  const now = Date.now();
  if (now - lastLogEventAt < 750) return;
  lastLogEventAt = now;
  event('log_updated', `${stream} updated.`, { stdoutBytes, stderrBytes, chunkBytes: bytes });
}

const child = spawn(command.bin, command.args, {
  cwd: config.worktree,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
meta.agentPid = child.pid;
persistMeta(meta);
event('run_started', `${config.agent} process started.`, { pid: child.pid });

child.stdout?.on('data', (value: Buffer | string) => {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const next = appendBounded(config.stdoutPath, chunk, stdoutBytes, stdoutTruncated);
  stdoutBytes = next.written;
  stdoutTruncated = next.truncated;
  noteLogUpdate('stdout', chunk.length);
});

child.stderr?.on('data', (value: Buffer | string) => {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const next = appendBounded(config.stderrPath, chunk, stderrBytes, stderrTruncated);
  stderrBytes = next.written;
  stderrTruncated = next.truncated;
  stderrPreview = `${stderrPreview}${chunk.toString('utf-8')}`.slice(-16 * 1024);
  noteLogUpdate('stderr', chunk.length);
});

const heartbeat = setInterval(() => {
  const current = JSON.parse(readFileSync(config.metaPath, 'utf-8')) as AgentJobMeta;
  current.lastHeartbeatAt = new Date().toISOString();
  persistMeta(current);
  event('run_heartbeat', 'Agent process is still running.', {
    pid: child.pid,
    stdoutBytes,
    stderrBytes,
    deadlineAt: current.deadlineAt,
  });
}, 30_000);
heartbeat.unref();

function terminateAgent(signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (_error) {
    try { child.kill(signal); } catch (_nested) { /* process already exited */ }
  }
}

const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  let settled = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    resolve({ code, signal });
  };
  child.once('error', (error) => {
    spawnError = error;
    finish(null, null);
  });
  child.once('close', (code, signal) => finish(code, signal));

  const timeout = setTimeout(() => {
    timedOut = true;
    event('run_waiting', `Agent exceeded timeout ${config.timeoutMs}ms; terminating process.`);
    terminateAgent('SIGTERM');
    const forceKill = setTimeout(() => terminateAgent('SIGKILL'), 5_000);
    forceKill.unref();
  }, config.timeoutMs);
  timeout.unref();
  child.once('close', () => { clearTimeout(timeout); clearInterval(heartbeat); });
  child.once('error', () => { clearTimeout(timeout); clearInterval(heartbeat); });
});

const finishedAt = new Date().toISOString();
const ok = result.code === 0 && !timedOut && !spawnError;
const error = spawnError?.message
  ?? (timedOut ? `agent timed out after ${config.timeoutMs}ms` : undefined)
  ?? (ok ? undefined : stderrPreview.trim() || `agent exited with code ${result.code ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}`);

writeFileSync(config.resultPath, `${JSON.stringify({
  ok,
  exitCode: result.code,
  timedOut,
  signal: result.signal,
  error,
  stdoutBytes,
  stderrBytes,
  stdoutTruncated,
  stderrTruncated,
  finishedAt,
}, null, 2)}\n`, 'utf-8');

const finalMeta = JSON.parse(readFileSync(config.metaPath, 'utf-8')) as AgentJobMeta;
finalMeta.status = ok ? 'succeeded' : 'failed';
finalMeta.exitCode = result.code;
finalMeta.error = error;
finalMeta.terminationReason = timedOut ? 'timeout' : spawnError ? 'spawn_error' : result.signal ? 'signal' : undefined;
finalMeta.lastHeartbeatAt = finishedAt;
finalMeta.finishedAt = finishedAt;
persistMeta(finalMeta);
event('log_updated', 'Agent output stream closed.', { stdoutBytes, stderrBytes, stdoutTruncated, stderrTruncated });
event(ok ? 'run_succeeded' : 'run_failed', ok ? 'Agent process finished successfully.' : error);
process.exit(ok ? 0 : 1);
