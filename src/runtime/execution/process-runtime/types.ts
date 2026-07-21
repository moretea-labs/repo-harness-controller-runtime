/**
 * Unified Process Runtime types.
 * Direct (interactive wait) and Managed (handle returned on wait expiry)
 * share one spawn path — never re-executes a command that already started.
 */

export type ProcessRuntimeStatus =
  | 'starting'
  | 'running'
  | 'running_recovered'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'orphaned'
  | 'completed_unknown'
  | 'unknown';

export type ProcessRouteMode = 'direct' | 'managed' | 'durable';

export interface ProcessIdentityRecord {
  pid: number;
  processStartTime: string;
  executableFingerprint: string;
  processGroupId?: number;
}

export interface ProcessResourceClaim {
  resourceKey: string;
  mode: 'read' | 'write' | 'exclusive';
}

export interface ProcessCommandSpec {
  kind: 'argv' | 'shell';
  executable?: string;
  args?: string[];
  shellCommand?: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ManagedProcessRecord {
  schemaVersion: 1;
  processId: string;
  repoId: string;
  checkoutId?: string;
  controllerHome: string;
  status: ProcessRuntimeStatus;
  route: ProcessRouteMode;
  command: ProcessCommandSpec;
  identity?: ProcessIdentityRecord;
  resourceClaims: ProcessResourceClaim[];
  interactiveWaitMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  logPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  /** Fencing token — only the owner with this token may write terminal status. */
  terminalFenceToken: number;
  terminalWritten?: boolean;
  /** Owner controller generation / authority epoch when known. */
  writerAuthorityEpoch?: string;
  /** Optional correlation for MCP / check / command tools. */
  origin?: {
    surface: 'mcp' | 'check' | 'command' | 'system';
    toolName?: string;
    requestId?: string;
    checkId?: string;
    correlationId?: string;
  };
  error?: { code: string; message: string };
  /** Sidecar exit receipt path written by wrapper (survives controller restart). */
  exitReceiptPath?: string;
  /** True when PID identity used fallback without startTime — signals forbidden. */
  identityUntrusted?: boolean;
  /** Log truncated due to quota. */
  logTruncated?: boolean;
}

export interface SpawnManagedProcessInput {
  controllerHome: string;
  repoId: string;
  checkoutId?: string;
  command: ProcessCommandSpec;
  interactiveWaitMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  resourceClaims?: ProcessResourceClaim[];
  origin?: ManagedProcessRecord['origin'];
  writerAuthorityEpoch?: string;
  signal?: AbortSignal;
  /** When true, never block the caller waiting for completion. */
  returnHandleImmediately?: boolean;
}

export interface ProcessHandle {
  processId: string;
  status: ProcessRuntimeStatus;
  route: ProcessRouteMode;
  pid?: number;
  startedAt: string;
  interactiveWaitMs: number;
  timeoutMs: number;
  completed?: boolean;
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  stdout?: string;
  stderr?: string;
  stdoutTail?: string;
  stderrTail?: string;
  durableSideEffects: {
    executionJobCount: number;
    localJobCount: number;
    workerSpawnCount: number;
    projectionUpdateCount: number;
  };
}

export interface WaitProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessLogSlice {
  processId: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

export const DEFAULT_INTERACTIVE_WAIT_MS = 8_000;
export const DEFAULT_PROCESS_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const PROCESS_LOG_TAIL_BYTES = 32 * 1024;
