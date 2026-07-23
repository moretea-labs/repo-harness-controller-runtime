import type { ExecutionJob } from './types';

export type ControllerRestartExecutionJob = Pick<ExecutionJob, 'requestId' | 'payload'>;

export function controllerRestartRequestIdForExecutionJob(
  job: ControllerRestartExecutionJob,
): string {
  const args = job.payload.arguments ?? {};
  const explicitRequestId = typeof args.request_id === 'string' && args.request_id.trim()
    ? args.request_id.trim()
    : typeof args.requestId === 'string' && args.requestId.trim()
      ? args.requestId.trim()
      : undefined;
  return explicitRequestId ?? job.requestId;
}

export function runtimeToolArgumentsForExecutionJob(
  job: ControllerRestartExecutionJob,
): Record<string, unknown> {
  const args = { ...(job.payload.arguments ?? {}) };
  if (job.payload.operation !== 'controller_restart_verify') return args;
  args.request_id = controllerRestartRequestIdForExecutionJob(job);
  return args;
}
