/**
 * Worker-thread dirty path fingerprinting for Fast Path snapshots.
 * Caps dirty file count, per-file bytes, total read bytes, and wall time.
 * Exceeding budget throws SNAPSHOT_TOO_DIRTY / SNAPSHOT_BUDGET so callers escalate to Durable.
 */
import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'fs';
import { isMainThread, parentPort, workerData, Worker } from 'worker_threads';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

export const MAX_DIRTY_PATHS_FOR_FINGERPRINT = 200;
export const MAX_FINGERPRINT_FILE_BYTES = 256 * 1024;
export const MAX_FINGERPRINT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_FINGERPRINT_WORKER_MS = 5_000;

export interface FingerprintJobInput {
  root: string;
  paths: string[];
  statusByPath: Record<string, string[]>;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxPaths?: number;
}

export interface FingerprintJobResult {
  pathFingerprints: Record<string, string>;
  bytesRead: number;
  pathCount: number;
  timedOut?: boolean;
  error?: string;
}

function fingerprintOne(
  root: string,
  relativePath: string,
  statusLines: string[],
  maxFileBytes: number,
  budget: { total: number; maxTotal: number },
): string {
  const hash = createHash('sha256').update(statusLines.join('\n'));
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return hash.update('\nmissing').digest('hex');
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      hash.update(`\nsymlink:${readlinkSync(absolute)}`);
    } else if (stat.isFile()) {
      if (stat.size > maxFileBytes) {
        hash.update(`\nlarge:${stat.size}:${stat.mode}`);
      } else {
        if (budget.total + stat.size > budget.maxTotal) {
          throw new Error(
            `SNAPSHOT_BUDGET: total fingerprint bytes would exceed ${budget.maxTotal}`,
          );
        }
        const body = readFileSync(absolute);
        budget.total += body.length;
        hash.update('\nfile:').update(body);
      }
    } else {
      hash.update(`\nmode:${stat.mode}:size:${stat.size}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SNAPSHOT_BUDGET')) throw error;
    hash.update(`\nunreadable:${error instanceof Error ? error.message : String(error)}`);
  }
  return hash.digest('hex');
}

export function computePathFingerprintsSync(input: FingerprintJobInput): FingerprintJobResult {
  const maxPaths = input.maxPaths ?? MAX_DIRTY_PATHS_FOR_FINGERPRINT;
  const maxFileBytes = input.maxFileBytes ?? MAX_FINGERPRINT_FILE_BYTES;
  const maxTotal = input.maxTotalBytes ?? MAX_FINGERPRINT_TOTAL_BYTES;
  if (input.paths.length > maxPaths) {
    throw new Error(
      `SNAPSHOT_TOO_DIRTY: ${input.paths.length} dirty paths exceeds Fast Path cap ${maxPaths}`,
    );
  }
  const budget = { total: 0, maxTotal };
  const pathFingerprints: Record<string, string> = {};
  for (const path of input.paths) {
    pathFingerprints[path] = fingerprintOne(
      input.root,
      path,
      input.statusByPath[path] ?? [],
      maxFileBytes,
      budget,
    );
  }
  return {
    pathFingerprints,
    bytesRead: budget.total,
    pathCount: input.paths.length,
  };
}

async function runInWorker(input: FingerprintJobInput, timeoutMs: number): Promise<FingerprintJobResult> {
  const modulePath = fileURLToPath(import.meta.url);
  return await new Promise<FingerprintJobResult>((resolvePromise, reject) => {
    const worker = new Worker(modulePath, {
      workerData: input,
      // Bun / Node ESM worker entry
      execArgv: [],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().finally(() => {
        reject(new Error(`SNAPSHOT_WORKER_TIMEOUT: fingerprint worker exceeded ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timer.unref?.();
    worker.on('message', (message: FingerprintJobResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (message.error) reject(new Error(message.error));
      else resolvePromise(message);
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`SNAPSHOT_WORKER_EXIT: fingerprint worker exited ${code}`));
      }
    });
  });
}

/**
 * Compute dirty path fingerprints off the main event loop when possible.
 * Falls back to sync on worker spawn failure (still bounded).
 */
export async function computePathFingerprintsAsync(
  input: FingerprintJobInput,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<FingerprintJobResult> {
  if (options.signal?.aborted) {
    throw new Error('CANCELLED: fingerprint aborted');
  }
  const timeoutMs = options.timeoutMs ?? MAX_FINGERPRINT_WORKER_MS;
  // Empty / tiny jobs stay on main thread to avoid spawn overhead.
  if (input.paths.length === 0) {
    return { pathFingerprints: {}, bytesRead: 0, pathCount: 0 };
  }
  if (input.paths.length <= 2) {
    return computePathFingerprintsSync(input);
  }
  try {
    return await runInWorker(input, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Timeouts / budget errors must not silently degrade to unbounded sync.
    if (
      message.startsWith('SNAPSHOT_WORKER_TIMEOUT')
      || message.startsWith('SNAPSHOT_TOO_DIRTY')
      || message.startsWith('SNAPSHOT_BUDGET')
      || message.startsWith('CANCELLED')
    ) {
      throw error instanceof Error ? error : new Error(message);
    }
    // Worker spawn unavailable (some test runners): bounded sync fallback.
    return computePathFingerprintsSync(input);
  }
}

// Worker thread entry
if (!isMainThread && parentPort) {
  try {
    const input = workerData as FingerprintJobInput;
    const result = computePathFingerprintsSync(input);
    parentPort.postMessage(result);
  } catch (error) {
    parentPort.postMessage({
      pathFingerprints: {},
      bytesRead: 0,
      pathCount: 0,
      error: error instanceof Error ? error.message : String(error),
    } satisfies FingerprintJobResult);
  }
}
