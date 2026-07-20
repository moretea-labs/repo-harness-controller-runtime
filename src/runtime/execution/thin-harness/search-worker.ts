/**
 * Worker-thread search fallback when `rg` is unavailable.
 * Keeps the Gateway event loop free of synchronous inspector walks.
 */
import { isMainThread, parentPort, workerData, Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { getMcpPolicy } from '../../../cli/mcp/policy';
import { searchRepository } from '../../../cli/repository/inspector';

export interface SearchWorkerInput {
  repoRoot: string;
  query: string;
  maxResults: number;
  maxFiles: number;
}

export interface SearchWorkerResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

function runSearchSync(input: SearchWorkerInput): SearchWorkerResult {
  try {
    const result = searchRepository(input.repoRoot, getMcpPolicy('controller', { repoRoot: input.repoRoot }), {
      query: input.query,
      maxResults: input.maxResults,
      maxFiles: input.maxFiles,
    }) as unknown as Record<string, unknown>;
    return { ok: true, payload: { ...result, engine: 'inspector_worker' } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runInspectorSearchInWorker(
  input: SearchWorkerInput,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  if (options.signal?.aborted) throw new Error('CANCELLED: search aborted');
  const timeoutMs = options.timeoutMs ?? 10_000;
  const modulePath = fileURLToPath(import.meta.url);

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(modulePath, { workerData: input });
    } catch {
      // Worker unavailable — still isolate via setImmediate then bounded sync.
      void Promise.resolve().then(() => {
        if (options.signal?.aborted) {
          reject(new Error('CANCELLED: search aborted'));
          return;
        }
        const result = runSearchSync(input);
        if (!result.ok) reject(new Error(result.error ?? 'search failed'));
        else resolve(result.payload ?? {});
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate().finally(() => {
        reject(new Error(`SEARCH_WORKER_TIMEOUT: inspector search exceeded ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().finally(() => {
        reject(new Error('CANCELLED: search aborted'));
      });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (message: SearchWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      if (!message.ok) reject(new Error(message.error ?? 'search worker failed'));
      else resolve(message.payload ?? {});
    });
    worker.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (code !== 0) reject(new Error(`SEARCH_WORKER_EXIT: ${code}`));
    });
  });
}

if (!isMainThread && parentPort) {
  const input = workerData as SearchWorkerInput;
  parentPort.postMessage(runSearchSync(input));
}
