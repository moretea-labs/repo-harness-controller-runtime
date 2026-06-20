import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import type { Server } from 'http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { cancelAgentJob, getAgentJob, getAgentJobEvents, getAgentJobLog, listAgentJobs, retryAgentJob } from '../agent-jobs/job-manager';
import { listControllerChecks } from '../controller/check-runner';
import { projectBoard } from '../controller/issue-store';
import {
  approveLocalBridgeJob,
  cancelLocalBridgeJob,
  executeLocalBridgeJob,
  getLocalBridgeJob,
  getLocalBridgeJobEvents,
  listLocalBridgeJobs,
  localBridgeTimeoutPolicy,
  submitLocalBridgeJob,
} from './job-store';
import { localBridgeDashboardHtml } from './dashboard';
import type { LocalBridgeJobRequest } from './types';
import { CONTROLLER_TOOL_SURFACE } from '../controller/runtime-config';
import { loadMcpLocalConfig, loadMcpRuntimeState } from '../mcp/auth';

export interface LocalBridgeServerOptions {
  repoRoot: string;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  token?: string;
}

export interface LocalBridgeServerHandle {
  host: string;
  port: number;
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

function assertLoopback(host: string): void {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`local controller must bind to a loopback address, received: ${host}`);
  }
}

function openUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (_error) {
    // The URL is still printed by the caller when a desktop opener is unavailable.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asyncExecute(repoRoot: string, jobId: string): void {
  setTimeout(() => {
    try { executeLocalBridgeJob(repoRoot, jobId); } catch (_error) { /* persisted by the job executor */ }
  }, 0);
}

export async function startLocalBridgeServer(options: LocalBridgeServerOptions): Promise<LocalBridgeServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 8766;
  assertLoopback(host);
  const token = options.token ?? randomBytes(32).toString('base64url');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  const requireToken = (request: Request, response: Response, next: NextFunction): void => {
    if (request.header('x-repo-harness-local-token') !== token) {
      response.status(403).json({ error: 'invalid local controller token' });
      return;
    }
    next();
  };

  app.get('/', (_request, response) => {
    response.type('html').send(localBridgeDashboardHtml(token));
  });
  app.get('/health', (_request, response) => {
    response.json({ status: 'ok', repoRoot: options.repoRoot, localOnly: true, toolSurface: CONTROLLER_TOOL_SURFACE, timeoutPolicy: localBridgeTimeoutPolicy(options.repoRoot) });
  });

  app.use('/api', requireToken);
  app.get('/api/snapshot', (_request, response) => {
    const runs = listAgentJobs(options.repoRoot, 100);
    const mcpConfig = loadMcpLocalConfig(options.repoRoot);
    const mcpRuntime = loadMcpRuntimeState(options.repoRoot);
    const runtimeSurface = mcpRuntime?.server?.toolSurface;
    const runtimeProfile = mcpRuntime?.server?.profile;
    const connectorHealthy = mcpRuntime?.server?.healthy === true &&
      runtimeSurface === CONTROLLER_TOOL_SURFACE && runtimeProfile === 'controller';
    response.json({
      repoRoot: options.repoRoot,
      toolSurface: CONTROLLER_TOOL_SURFACE,
      connector: {
        configuredServerName: mcpConfig?.chatgpt?.serverName,
        publicEndpoint: mcpConfig?.chatgpt?.endpoint ?? mcpRuntime?.tunnel?.publicEndpoint,
        runtimeStatus: mcpRuntime?.status ?? 'not_started',
        runtimeProfile,
        runtimeSurface,
        toolCount: mcpRuntime?.server?.toolCount,
        healthy: connectorHealthy,
        needsReconnect: mcpRuntime?.tunnel?.connectorNeedsReconnect === true,
        mismatch: mcpRuntime?.server?.healthMismatch ?? (mcpRuntime && !connectorHealthy
          ? `expected controller / ${CONTROLLER_TOOL_SURFACE}`
          : undefined),
      },
      timeoutPolicy: localBridgeTimeoutPolicy(options.repoRoot),
      board: projectBoard(options.repoRoot),
      runs,
      runCounts: runs.reduce<Record<string, number>>((counts, run) => {
        counts[run.status] = (counts[run.status] ?? 0) + 1;
        return counts;
      }, {}),
      localJobs: listLocalBridgeJobs(options.repoRoot, 100),
      checks: listControllerChecks(options.repoRoot),
    });
  });
  app.get('/api/jobs/:jobId', (request, response) => {
    try {
      response.json({ job: getLocalBridgeJob(options.repoRoot, request.params.jobId), events: getLocalBridgeJobEvents(options.repoRoot, request.params.jobId) });
    } catch (error) { response.status(404).json({ error: errorMessage(error) }); }
  });
  app.post('/api/jobs', (request, response) => {
    try {
      const job = submitLocalBridgeJob(options.repoRoot, request.body as LocalBridgeJobRequest);
      if (job.status === 'approved') asyncExecute(options.repoRoot, job.jobId);
      response.status(202).json(job);
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });
  app.post('/api/jobs/:jobId/approve', (request, response) => {
    try {
      const job = approveLocalBridgeJob(options.repoRoot, request.params.jobId, true);
      asyncExecute(options.repoRoot, job.jobId);
      response.status(202).json(job);
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });
  app.post('/api/jobs/:jobId/cancel', (request, response) => {
    try { response.json(cancelLocalBridgeJob(options.repoRoot, request.params.jobId)); }
    catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });
  app.get('/api/runs/:runId', (request, response) => {
    try { response.json(getAgentJob(options.repoRoot, request.params.runId)); }
    catch (error) { response.status(404).json({ error: errorMessage(error) }); }
  });
  app.get('/api/runs/:runId/log', (request, response) => {
    try {
      const run = getAgentJob(options.repoRoot, request.params.runId);
      const result = getAgentJobLog(options.repoRoot, request.params.runId, false);
      response.json({ ...result, status: run.status, agent: run.agent });
    } catch (error) { response.status(404).json({ error: errorMessage(error) }); }
  });
  app.get('/api/runs/:runId/events', (request, response) => {
    try { response.json({ events: getAgentJobEvents(options.repoRoot, request.params.runId, 500) }); }
    catch (error) { response.status(404).json({ error: errorMessage(error) }); }
  });
  app.post('/api/runs/:runId/cancel', (request, response) => {
    try { response.json(cancelAgentJob(options.repoRoot, request.params.runId)); }
    catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });
  app.post('/api/runs/:runId/retry', (request, response) => {
    try {
      const timeoutMs = typeof request.body?.timeoutMs === 'number' ? request.body.timeoutMs : undefined;
      response.status(202).json(retryAgentJob(options.repoRoot, request.params.runId, { timeoutMs, isolate: request.body?.isolate !== false }));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(requestedPort, host, () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}/`;
  if (options.openBrowser) openUrl(url);
  return {
    host,
    port,
    url,
    token,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
