import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureControllerHome } from '../../cli/repositories/controller-home';

export interface McpTimingTrace {
  tool: string;
  sessionResolutionMs?: number;
  authenticationAuthorizationMs?: number;
  repositoryResolutionMs?: number;
  workHandleValidationMs?: number;
  controllerQueueWaitMs?: number;
  commandExecutionMs?: number;
  resultSerializationMs?: number;
  resultPersistenceMs?: number;
  totalToolDurationMs: number;
  sessionId?: string;
  repoId?: string;
  workId?: string;
}

export function recordMcpTiming(controllerHome: string, trace: McpTimingTrace): void {
  try {
    const root = join(ensureControllerHome(controllerHome), 'audit');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(join(root, 'mcp-timings.jsonl'), `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...trace })}\n`, 'utf-8');
  } catch {
    // Timing is diagnostic evidence; it must never change the tool result.
  }
}
