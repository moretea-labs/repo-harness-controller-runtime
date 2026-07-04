import { execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface RuntimeProcessSample {
  pid: number;
  ppid: number;
  pgid: number;
  elapsed: string;
  cpu: number;
  mem: number;
  command: string;
  kind: 'controller-daemon' | 'worker' | 'local-controller' | 'mcp-server' | 'mcp-keepalive' | 'tunnel' | 'repo-harness' | 'other';
  repoRoot?: string;
  jobId?: string;
  orphan: boolean;
  highCpu: boolean;
}

export interface RuntimeTempEntry {
  path: string;
  mtime: string;
  ageMinutes: number;
  occupiedByPid?: number;
  cleanupCandidate: boolean;
}

export interface RuntimePerformanceDiagnostics {
  schemaVersion: 1;
  repoId: string;
  repoRoot: string;
  generatedAt: string;
  status: 'normal' | 'warning' | 'critical';
  summary: string;
  controller: { queueDepth: number; runningWorkers: number; activeLeases: number; activeJobs: string[] };
  processSummary: {
    totalRepoHarnessProcesses: number;
    workerProcesses: number;
    orphanWorkers: number;
    highCpuProcesses: number;
    totalRepoHarnessCpu: number;
    localControllerRunning: boolean;
    localControllerPid?: number;
  };
  processes: RuntimeProcessSample[];
  temp: { scannedRoots: string[]; totalEntries: number; cleanupCandidates: number; entries: RuntimeTempEntry[] };
  cleanupPreview?: { safeToTerminate: RuntimeProcessSample[]; safeToRemoveTempEntries: RuntimeTempEntry[]; requiresConfirmation: true };
  findings: Array<{ severity: 'info' | 'warning' | 'critical'; code: string; message: string }>;
  recommendations: string[];
}

interface DiagnosticsInput {
  repoId: string;
  repoRoot: string;
  queueDepth?: number;
  runningWorkers?: number;
  activeLeases?: number;
  activeJobIds?: string[];
  includeProcesses?: boolean;
  includeTempDirs?: boolean;
  cleanupPreview?: boolean;
  localControllerRunning?: boolean;
  localControllerPid?: number;
  localControllerEndpoint?: string;
}

function parseNumber(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractFlag(command: string, flag: string): string | undefined {
  const escaped = flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return command.match(new RegExp(escaped + '\\s+([^\\s]+)'))?.[1];
}

function normalizePath(value: string | undefined): string | undefined {
  return value ? value.replace(/\\/g, '/') : undefined;
}

function normalizeRootForCompare(value: string | undefined): string | undefined {
  let normalized = normalizePath(value);
  while (normalized !== undefined && normalized.endsWith(String.fromCharCode(47))) normalized = normalized.slice(0, -1);
  return normalized;
}

export function isHighCpuPeerMcpProcess(sample: RuntimeProcessSample, repoRoot: string): boolean {
  if (!sample.highCpu) return false;
  if (sample.kind !== 'mcp-server' && sample.kind !== 'mcp-keepalive') return false;
  const currentRoot = normalizeRootForCompare(repoRoot);
  const sampleRoot = normalizeRootForCompare(sample.repoRoot);
  return currentRoot !== undefined && sampleRoot !== undefined && sampleRoot !== currentRoot;
}

function extractRepoRoot(command: string): string | undefined {
  const explicitRepo = extractFlag(command, '--repo');
  if (explicitRepo) return normalizePath(explicitRepo);
  const sourceMatch = command.match(/(\/[^\s]*repo-harness[^\s]*)\/src\//);
  if (sourceMatch) return normalizePath(sourceMatch[1]);
  const worktreeMatch = command.match(/(\/[^\s]*repo-harness[^\s]*)\/\.ai\//);
  if (worktreeMatch) return normalizePath(worktreeMatch[1]);
  return undefined;
}

function classify(command: string): RuntimeProcessSample['kind'] {
  if (command.includes('daemon-entry.ts')) return 'controller-daemon';
  if (command.includes('worker-entry.ts') || command.includes('job-worker.ts') || command.includes('/runtime/execution/workers/')) return 'worker';
  if (command.includes(' controller ui ') || command.includes('src/cli/index.ts controller ui')) return 'local-controller';
  if (command.includes(' mcp serve ') || command.includes('src/cli/index.ts mcp serve')) return 'mcp-server';
  if (command.includes(' mcp keepalive ') || command.includes('src/cli/index.ts mcp keepalive')) return 'mcp-keepalive';
  if (command.includes('ngrok') || command.includes('controller-ngrok-rotation')) return 'tunnel';
  if (command.includes('repo-harness')) return 'repo-harness';
  return 'other';
}

export function collectRuntimeProcesses(activeJobIds: string[] = []): RuntimeProcessSample[] {
  const active = new Set(activeJobIds);
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,%cpu=,%mem=,command='], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch (_error) {
    return [];
  }
  return output.split('\n').map((line) => line.trim()).filter(Boolean).map((line): RuntimeProcessSample | undefined => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
    if (!match) return undefined;
    const command = match[7];
    const kind = classify(command);
    const relevant = kind !== 'other' || /\b(bun|node|tsx)\b/.test(command);
    if (!relevant) return undefined;
    const jobId = extractFlag(command, '--job-id');
    const ppid = Number(match[2]);
    const cpu = parseNumber(match[5]);
    return {
      pid: Number(match[1]),
      ppid,
      pgid: Number(match[3]),
      elapsed: match[4],
      cpu,
      mem: parseNumber(match[6]),
      command,
      kind,
      repoRoot: extractRepoRoot(command),
      jobId,
      orphan: kind === 'worker' && (ppid === 1 || (jobId ? !active.has(jobId) : false)),
      highCpu: cpu >= 20,
    };
  }).filter((sample): sample is RuntimeProcessSample => sample !== undefined).sort((a, b) => b.cpu - a.cpu);
}

export function inferLocalControllerProcess(repoRoot: string): { running: boolean; pid?: number; endpoint?: string; source: 'process-scan' } | undefined {
  const normalizedRoot = normalizePath(repoRoot);
  const sample = collectRuntimeProcesses().find((process) => process.kind === 'local-controller' && (normalizePath(process.repoRoot) === normalizedRoot || process.command.includes(repoRoot)));
  if (!sample) return undefined;
  const host = extractFlag(sample.command, '--host') ?? '127.0.0.1';
  const port = extractFlag(sample.command, '--port') ?? '8766';
  return { running: true, pid: sample.pid, endpoint: 'http://' + host + ':' + port + '/', source: 'process-scan' };
}

function scanTempEntries(processes: RuntimeProcessSample[]): { roots: string[]; entries: RuntimeTempEntry[] } {
  const roots = Array.from(new Set([tmpdir(), '/private/tmp'].filter((root) => existsSync(root))));
  const now = Date.now();
  const entries: RuntimeTempEntry[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root).filter((name) => name.startsWith('repo-harness')); } catch (_error) { continue; }
    for (const name of names.slice(0, 200)) {
      const path = join(root, name);
      try {
        const stat = statSync(path);
        const occupied = processes.find((process) => process.command.includes(path));
        const ageMinutes = Math.max(0, Math.round((now - stat.mtimeMs) / 60000));
        entries.push({ path, mtime: stat.mtime.toISOString(), ageMinutes, occupiedByPid: occupied?.pid, cleanupCandidate: !occupied && ageMinutes >= 60 });
      } catch (_error) {}
    }
  }
  return { roots, entries: entries.sort((a, b) => b.ageMinutes - a.ageMinutes) };
}

export function collectRuntimePerformanceDiagnostics(input: DiagnosticsInput): RuntimePerformanceDiagnostics {
  const activeJobIds = input.activeJobIds ?? [];
  const processes = input.includeProcesses === false ? [] : collectRuntimeProcesses(activeJobIds);
  const repoRoot = normalizePath(input.repoRoot) ?? input.repoRoot;
  const repoProcesses = processes.filter((process) => normalizePath(process.repoRoot) === repoRoot || process.command.includes(input.repoRoot));
  const workers = repoProcesses.filter((process) => process.kind === 'worker');
  const orphanWorkers = workers.filter((process) => process.orphan);
  const highCpu = repoProcesses.filter((process) => process.highCpu);
  const highCpuPeerMcp = repoProcesses.filter((process) => isHighCpuPeerMcpProcess(process, repoRoot));
  const localController = repoProcesses.find((process) => process.kind === 'local-controller');
  const localControllerRunning = localController !== undefined || input.localControllerRunning === true;
  const temp = input.includeTempDirs === false ? { roots: [] as string[], entries: [] as RuntimeTempEntry[] } : scanTempEntries(processes);
  const findings: RuntimePerformanceDiagnostics['findings'] = [];
  if (orphanWorkers.length > 0) findings.push({ severity: orphanWorkers.length >= 3 ? 'critical' : 'warning', code: 'ORPHAN_WORKERS', message: 'Detected ' + orphanWorkers.length + ' orphan worker process(es).' });
  const totalCpu = Math.round(repoProcesses.reduce((sum, process) => sum + process.cpu, 0) * 10) / 10;
  if (totalCpu >= 100 || highCpu.length >= 3) findings.push({ severity: 'warning', code: 'HIGH_REPO_HARNESS_CPU', message: 'Repo-harness related CPU is ' + totalCpu + '%.' });
  if (highCpuPeerMcp.length > 0) findings.push({ severity: 'warning', code: 'HIGH_CPU_PEER_MCP', message: 'Detected ' + highCpuPeerMcp.length + ' high-CPU MCP process(es) owned by another repository.' });
  if ((input.queueDepth ?? 0) === 0 && (input.runningWorkers ?? 0) === 0 && orphanWorkers.length > 0) findings.push({ severity: 'critical', code: 'CONTROL_PLANE_IDLE_HOST_BUSY', message: 'Controller queue is idle but host still has orphan worker process(es).' });
  if (temp.entries.length >= 100) findings.push({ severity: 'warning', code: 'TEMP_DIR_ACCUMULATION', message: 'Detected ' + temp.entries.length + ' repo-harness temp entries.' });
  if (!localController && input.localControllerRunning !== true) findings.push({ severity: 'info', code: 'LOCAL_CONTROLLER_NOT_IN_PROCESS_LIST', message: 'No Local Controller process was found for this repository.' });
  const cleanupProcesses = [...orphanWorkers, ...highCpuPeerMcp]
    .filter((sample, index, samples) => samples.findIndex((candidate) => candidate.pid === sample.pid) === index)
    .slice(0, 50);
  const status: RuntimePerformanceDiagnostics['status'] = findings.some((finding) => finding.severity === 'critical') ? 'critical' : findings.some((finding) => finding.severity === 'warning') ? 'warning' : 'normal';
  return {
    schemaVersion: 1,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    generatedAt: new Date().toISOString(),
    status,
    summary: status === 'normal' ? 'No orphan workers or abnormal repo-harness CPU pattern detected.' : findings.map((finding) => finding.message).join(' '),
    controller: { queueDepth: input.queueDepth ?? 0, runningWorkers: input.runningWorkers ?? 0, activeLeases: input.activeLeases ?? 0, activeJobs: activeJobIds },
    processSummary: { totalRepoHarnessProcesses: repoProcesses.length, workerProcesses: workers.length, orphanWorkers: orphanWorkers.length, highCpuProcesses: highCpu.length, totalRepoHarnessCpu: totalCpu, localControllerRunning, localControllerPid: localController?.pid ?? input.localControllerPid },
    processes: repoProcesses.slice(0, 80),
    temp: { scannedRoots: temp.roots, totalEntries: temp.entries.length, cleanupCandidates: temp.entries.filter((entry) => entry.cleanupCandidate).length, entries: temp.entries.slice(0, 80) },
    cleanupPreview: input.cleanupPreview === true ? { safeToTerminate: cleanupProcesses, safeToRemoveTempEntries: temp.entries.filter((entry) => entry.cleanupCandidate).slice(0, 80), requiresConfirmation: true } : undefined,
    findings,
    recommendations: status === 'normal' ? ['No restart is recommended from this diagnostic snapshot.'] : [
      ...(orphanWorkers.length ? ['Terminate orphan workers only after reviewing cleanupPreview.safeToTerminate.'] : []),
      ...(temp.entries.some((entry) => entry.cleanupCandidate) ? ['Remove stale temp entries only after reviewing cleanupPreview.safeToRemoveTempEntries.'] : []),
      ...(highCpu.length ? ['Inspect highCpuProcesses before restarting the controller stack.'] : []),
    ],
  };
}
