import { Command } from 'commander';
import { resolve } from 'path';
import { getAgentJob, getAgentJobEvents, getAgentJobLog, listAgentJobs } from '../agent-jobs/job-manager';
import { projectBoard } from '../controller/issue-store';
import { getGitHubStatus } from '../github/github';
import { loadLocalBridgeConfig } from '../local-bridge/job-store';
import { startLocalBridgeServer } from '../local-bridge/server';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function output(value: unknown, json = false): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function repoRoot(value?: string): string {
  return resolve(value ?? process.cwd());
}

function formatBoard(board: ReturnType<typeof projectBoard>): string {
  const lines = ['repo-harness Controller board', ''];
  const counts = Object.entries(board.counts).sort(([a], [b]) => a.localeCompare(b));
  lines.push(`Tasks: ${counts.length ? counts.map(([status, count]) => `${status}=${count}`).join('  ') : 'none'}`);
  lines.push('');
  for (const issue of board.issues) {
    lines.push(`${issue.id}  [${issue.status}]  ${issue.title}${issue.github && typeof issue.github === 'object' && 'url' in issue.github ? `\n  GitHub: ${String((issue.github as { url: unknown }).url)}` : ''}`);
    const tasks = Array.isArray(issue.tasks) ? issue.tasks as Array<Record<string, unknown>> : [];
    for (const task of tasks) {
      const runIds = Array.isArray(task.runIds) ? task.runIds : [];
      lines.push(`  ${String(task.id)}  [${String(task.status)}]  ${String(task.title)}  agent=${String(task.agent)}${runIds.length ? `  run=${String(runIds.at(-1))}` : ''}`);
    }
  }
  return lines.join('\n');
}

function formatRuns(runs: ReturnType<typeof listAgentJobs>): string {
  if (runs.length === 0) return 'No controller Runs.';
  return runs.map((run) => [
    `${run.runId}  [${run.status}]  ${run.agent}/${run.provider}`,
    `  ${run.issueId}/${run.taskId}`,
    ...(run.github?.url ? [`  Session: ${run.github.url}`] : []),
    ...(run.github?.pullRequestUrl ? [`  Pull request: ${run.github.pullRequestUrl}`] : []),
    ...(run.error ? [`  Error: ${run.error}`] : []),
  ].join('\n')).join('\n\n');
}

async function watchRun(root: string, runId: string, intervalSeconds: number, includeLog: boolean, json: boolean): Promise<void> {
  let eventCount = -1;
  let lastStatus = '';
  let previousLog = '';
  let logHeaderPrinted = false;
  let lastLogError = '';
  while (true) {
    const run = getAgentJob(root, runId);
    const events = getAgentJobEvents(root, runId, 1000);
    if (json) {
      output({ run, events: events.slice(Math.max(0, eventCount)) }, true);
    } else if (run.status !== lastStatus || events.length !== eventCount) {
      console.log(`[${new Date().toISOString()}] ${run.runId} status=${run.status} provider=${run.provider}`);
      for (const event of events.slice(Math.max(0, eventCount))) {
        console.log(`  ${event.at}  ${event.type}${event.message ? `  ${event.message}` : ''}`);
      }
      if (run.github?.url) console.log(`  Session: ${run.github.url}`);
      if (run.github?.pullRequestUrl) console.log(`  Pull request: ${run.github.pullRequestUrl}`);
      if (run.error) console.log(`  Error: ${run.error}`);
    }

    if (includeLog && !json) {
      try {
        const currentLog = getAgentJobLog(root, runId, false).log;
        if (currentLog !== previousLog) {
          const addition = currentLog.startsWith(previousLog) ? currentLog.slice(previousLog.length) : currentLog;
          if (addition) {
            if (!logHeaderPrinted) {
              console.log('\n--- Live Run log ---');
              logHeaderPrinted = true;
            } else if (!currentLog.startsWith(previousLog)) {
              console.log('\n[repo-harness] log window reset; showing current retained output');
            }
            process.stdout.write(addition.endsWith('\n') ? addition : `${addition}\n`);
          }
          previousLog = currentLog;
        }
        lastLogError = '';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastLogError) {
          console.log(`  Log not available yet: ${message}`);
          lastLogError = message;
        }
      }
    }

    eventCount = events.length;
    lastStatus = run.status;
    if (TERMINAL.has(run.status)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(1, intervalSeconds) * 1000));
  }
}

export function buildControllerCommand(): Command {
  const command = new Command('controller').description('Inspect repo-harness Issues, Tasks, local Runs, and GitHub cloud sessions');

  command.command('board')
    .description('Show the durable Issue and Task board')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; json?: boolean }) => {
      const board = projectBoard(repoRoot(opts.repo));
      output(opts.json ? board : formatBoard(board), opts.json === true);
    });

  command.command('runs')
    .description('List recent local and GitHub cloud Runs')
    .option('--repo <path>', 'Repository root')
    .option('--limit <count>', 'Maximum Runs', '25')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; limit?: string; json?: boolean }) => {
      const runs = listAgentJobs(repoRoot(opts.repo), Math.max(1, Number(opts.limit ?? 25)));
      output(opts.json ? { runs } : formatRuns(runs), opts.json === true);
    });

  command.command('watch')
    .description('Follow one local Run or GitHub Copilot cloud session until it reaches a terminal state')
    .argument('<run-id>', 'Controller Run ID')
    .option('--repo <path>', 'Repository root')
    .option('--interval <seconds>', 'Polling interval', '2')
    .option('--log', 'Print the final local or GitHub session log')
    .option('--json', 'Output JSON snapshots')
    .action(async (runId: string, opts: { repo?: string; interval?: string; log?: boolean; json?: boolean }) => {
      await watchRun(repoRoot(opts.repo), runId, Number(opts.interval ?? 2), opts.log === true, opts.json === true);
    });

  command.command('github-status')
    .description('Check gh authentication, repository resolution, Projects access prerequisites, and Copilot agent-task CLI support')
    .option('--repo <path>', 'Repository root')
    .option('--github-repo <owner/repo>', 'Explicit GitHub repository')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; githubRepo?: string; json?: boolean }) => {
      output(getGitHubStatus(repoRoot(opts.repo), opts.githubRepo), opts.json === true);
    });


  command.command('ui')
    .description('Start the localhost-only visual Issue, Task, Run, approval, and Agent-session control surface')
    .option('--repo <path>', 'Repository root')
    .option('--host <host>', 'Loopback bind host', '127.0.0.1')
    .option('--port <port>', 'Local UI port')
    .option('--no-open', 'Do not open the browser automatically')
    .action(async (opts: { repo?: string; host?: string; port?: string; open?: boolean }) => {
      const root = repoRoot(opts.repo);
      const config = loadLocalBridgeConfig(root);
      const handle = await startLocalBridgeServer({
        repoRoot: root,
        host: opts.host ?? config.host ?? '127.0.0.1',
        port: opts.port ? Number(opts.port) : config.port ?? 8766,
        openBrowser: opts.open !== false,
      });
      console.log(`repo-harness Local Controller: ${handle.url}`);
      console.log('Press Ctrl+C to stop. The UI is bound to loopback and is not exposed through the MCP tunnel.');
      await new Promise<void>((resolvePromise) => {
        const stop = () => { void handle.close().finally(resolvePromise); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  return command;
}
