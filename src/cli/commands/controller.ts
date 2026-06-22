import { Command } from 'commander';
import { resolve } from 'path';
import { getAgentJob, getAgentJobEvents, getAgentJobLog, listAgentJobs } from '../agent-jobs/job-manager';
import { archiveIssue, getIssue, inspectIssueReadiness, projectBoard, restoreIssue } from '../controller/issue-store';
import { taskWriteScopesConflict } from '../controller/execution-policy';
import { getControllerTimeline, getProjectProgress } from '../controller/progress';
import { exportControllerWorklog, parseWorklogCategory } from '../controller/worklog';
import { inspectProjectGovernance, reconcileProjectGovernance } from '../controller/governance';
import { assessWorkMode } from '../controller/work-mode';
import { finalizeEditSession, getEditSession, getEditSessionDiff, listEditSessions, rollbackEditSession, verifyEditSession } from '../editing/edit-session';
import { loadControllerProjectState, saveControllerProjectState } from '../controller/project-state';
import { closeIssueWithGitHubPlugin, getGitHubPluginStatus, publishIssueWithGitHubPlugin, refreshIssueWithGitHubPlugin, saveGitHubPluginConfig } from '../github/plugin';
import { getGitHubStatus } from '../github/github';
import { executeLocalBridgeJob, loadLocalBridgeConfig, submitLocalBridgeJob } from '../local-bridge/job-store';
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

  command.command('assess')
    .description('Choose direct_edit, quick_agent, or issue_task for one work request')
    .argument('<description>', 'Work request description')
    .option('--repo <path>', 'Repository root')
    .option('--path <path...>', 'Known target paths')
    .option('--expected-files <count>', 'Estimated file count')
    .option('--expected-lines <count>', 'Estimated changed lines')
    .option('--investigation', 'Root-cause investigation is required')
    .option('--parallel', 'Parallel work is required')
    .option('--long-checks', 'Long-running verification is required')
    .option('--dependencies', 'A durable Task dependency graph is required')
    .option('--risk <risk>', 'readonly, low, medium, high, or destructive', 'low')
    .option('--json', 'Output JSON')
    .action((description: string, opts: { path?: string[]; expectedFiles?: string; expectedLines?: string; investigation?: boolean; parallel?: boolean; longChecks?: boolean; dependencies?: boolean; risk?: 'readonly' | 'low' | 'medium' | 'high' | 'destructive'; json?: boolean }) => {
      const result = assessWorkMode({
        description,
        knownPaths: opts.path,
        expectedFiles: opts.expectedFiles ? Number(opts.expectedFiles) : undefined,
        expectedChangedLines: opts.expectedLines ? Number(opts.expectedLines) : undefined,
        requiresInvestigation: opts.investigation,
        requiresParallelism: opts.parallel,
        requiresLongRunningChecks: opts.longChecks,
        needsDependencies: opts.dependencies,
        risk: opts.risk,
      });
      output(result, opts.json === true);
    });

  command.command('edits')
    .description('List direct-edit sessions and their file/check evidence')
    .option('--repo <path>', 'Repository root')
    .option('--limit <count>', 'Maximum sessions', '50')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; limit?: string; json?: boolean }) => {
      const sessions = listEditSessions(repoRoot(opts.repo), Number(opts.limit ?? 50));
      if (opts.json) return output({ sessions }, true);
      output(sessions.length ? sessions.map((session) => `${session.sessionId}  [${session.status}]  ${session.changedFiles} files / ${session.changedLines} lines / ${session.checksPassed}/${session.checksTotal} checks\n  ${session.purpose}`).join('\n\n') : 'No direct-edit sessions.');
    });

  command.command('edit')
    .description('Show one direct-edit session')
    .argument('<session-id>', 'Edit session ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((sessionId: string, opts: { repo?: string; json?: boolean }) => output(getEditSession(repoRoot(opts.repo), sessionId), opts.json === true));

  command.command('edit-diff')
    .description('Print the persisted patch for one direct-edit session')
    .argument('<session-id>', 'Edit session ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((sessionId: string, opts: { repo?: string; json?: boolean }) => {
      const result = getEditSessionDiff(repoRoot(opts.repo), sessionId);
      output(opts.json ? result : result.patch || '(no patch)', opts.json === true);
    });

  command.command('verify-edit')
    .description('Run named checks and record review evidence for a direct edit')
    .argument('<session-id>', 'Edit session ID')
    .option('--repo <path>', 'Repository root')
    .option('--check <id...>', 'Override named checks')
    .option('--reviewer <name>', 'Reviewer identity', 'controller-cli-human')
    .option('--note <text>', 'Review note')
    .option('--json', 'Output JSON')
    .action((sessionId: string, opts: { repo?: string; check?: string[]; reviewer?: string; note?: string; json?: boolean }) => output(verifyEditSession(repoRoot(opts.repo), sessionId, { checkIds: opts.check, reviewer: opts.reviewer, note: opts.note }), opts.json === true));

  command.command('finalize-edit')
    .description('Finalize a verified direct edit')
    .argument('<session-id>', 'Edit session ID')
    .option('--repo <path>', 'Repository root')
    .option('--reviewer <name>', 'Reviewer identity', 'controller-cli-human')
    .option('--note <text>', 'Final note')
    .option('--json', 'Output JSON')
    .action((sessionId: string, opts: { repo?: string; reviewer?: string; note?: string; json?: boolean }) => output(finalizeEditSession(repoRoot(opts.repo), sessionId, { reviewer: opts.reviewer, note: opts.note }), opts.json === true));

  command.command('rollback-edit')
    .description('Rollback a non-finalized direct edit')
    .argument('<session-id>', 'Edit session ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((sessionId: string, opts: { repo?: string; json?: boolean }) => output(rollbackEditSession(repoRoot(opts.repo), sessionId), opts.json === true));

  command.command('progress')
    .description('Show project, Issue, and Task progress derived from durable controller state')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; json?: boolean }) => {
      const progress = getProjectProgress(repoRoot(opts.repo));
      if (opts.json) return output(progress, true);
      const lines = [
        `Evidence gates: ${progress.completedGates}/${progress.totalGates} complete`,
        `Current Issue: ${progress.currentIssueId ?? 'not selected'}`,
        `Issues: ${progress.activeIssueCount} active / ${progress.archivedIssueCount} archived / ${progress.issueCount} total`,
        `Tasks: ${progress.completedTaskCount} accepted / ${progress.taskCount} total`,
        `Active Runs: ${progress.activeRunCount}`,
        '',
        ...progress.issues.map((issue) => `${issue.id}  ${issue.completedGates}/${issue.totalGates} gates  [${issue.status}]  ${issue.title}${issue.isCurrent ? '  CURRENT' : ''}${issue.attentionCount ? `  attention=${issue.attentionCount}` : ''}`),
      ];
      output(lines.join('\n'));
    });

  command.command('governance')
    .description('Inspect execution focus, dead dependencies, retryable failures, review/acceptance backlog, duplicates, and closeout anomalies')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; json?: boolean }) => {
      const result = inspectProjectGovernance(repoRoot(opts.repo));
      if (opts.json) return output(result, true);
      const lines = [
        `Governance: ${result.health}`,
        `Current Issue: ${result.currentIssueId ?? 'not selected'}`,
        `Execution queue: ${result.executionQueue.length}`,
        `Findings: critical=${result.counts.critical ?? 0} warning=${result.counts.warning ?? 0} info=${result.counts.info ?? 0}`,
        '',
        ...result.findings.map((entry) => `${entry.severity.toUpperCase()}  ${entry.code}  ${[entry.issueId, entry.taskId].filter(Boolean).join('/')}\n  ${entry.message}`),
      ];
      output(lines.join('\n'));
    });

  command.command('reconcile')
    .description('Apply safe project-governance repairs and refresh the execution queue')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; json?: boolean }) => output(reconcileProjectGovernance(repoRoot(opts.repo)), opts.json === true));

  command.command('focus')
    .description('Select an informational primary Issue without blocking other Tasks')
    .argument('<issue-id>', 'Controller Issue ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((issueId: string, opts: { repo?: string; json?: boolean }) => {
      const root = repoRoot(opts.repo);
      const issue = getIssue(root, issueId);
      if (issue.archivedAt || ['done', 'cancelled'].includes(issue.status)) throw new Error(`Issue is not active: ${issue.status}`);
      output(saveControllerProjectState(root, { currentIssueId: issue.id }, 'controller-cli'), opts.json === true);
    });

  command.command('launch')
    .description('Queue Task-local launch candidates from one Issue through the risk-adaptive approval bridge')
    .argument('<issue-id>', 'Controller Issue ID')
    .option('--repo <path>', 'Repository root')
    .option('--max-parallel <count>', 'Maximum Tasks to launch', '1')
    .option('--timeout-ms <milliseconds>', 'Agent timeout')
    .option('--json', 'Output JSON')
    .action((issueId: string, opts: { repo?: string; maxParallel?: string; timeoutMs?: string; json?: boolean }) => {
      const root = repoRoot(opts.repo);
      const readiness = inspectIssueReadiness(root, issueId);
      if (!readiness.queueable) throw new Error(`Issue has no queueable Tasks: ${[...readiness.blockers, ...readiness.taskBlockers].map((entry) => entry.code).join(', ') || 'no queueable Tasks'}`);
      saveControllerProjectState(root, { currentIssueId: issueId }, 'controller-cli');
      const issue = getIssue(root, issueId);
      const count = Math.max(1, Math.min(Number(opts.maxParallel ?? 1), readiness.queueableTaskIds.length));
      const selected = [] as typeof issue.tasks;
      const skipped: Array<{ taskId: string; reason: string }> = [];
      for (const taskId of readiness.queueableTaskIds) {
        if (selected.length >= count) break;
        const task = issue.tasks.find((entry) => entry.id === taskId);
        if (!task) continue;
        if (selected.some((entry) => taskWriteScopesConflict(entry, task))) {
          skipped.push({ taskId, reason: 'allowed path scope overlaps another selected Task' });
          continue;
        }
        selected.push(task);
      }
      const jobs = selected.map((task) => {
        const job = submitLocalBridgeJob(root, {
          action: 'launch-task',
          requestedBy: 'controller-cli',
          payload: { issueId, taskId: task.id, timeoutMs: opts.timeoutMs ? Number(opts.timeoutMs) : undefined },
        });
        return job.status === 'approved' ? executeLocalBridgeJob(root, job.jobId) : job;
      });
      output({ readiness, jobs, skipped }, opts.json === true);
    });

  command.command('archive')
    .description('Archive a done or cancelled Issue')
    .argument('<issue-id>', 'Controller Issue ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((issueId: string, opts: { repo?: string; json?: boolean }) => output(archiveIssue(repoRoot(opts.repo), issueId), opts.json === true));

  command.command('restore')
    .description('Restore an archived Issue')
    .argument('<issue-id>', 'Controller Issue ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((issueId: string, opts: { repo?: string; json?: boolean }) => output(restoreIssue(repoRoot(opts.repo), issueId), opts.json === true));

  command.command('policy')
    .description('Read or update Controller execution policy')
    .option('--repo <path>', 'Repository root')
    .option('--issue-creation-mode <mode>', 'open, focus_only, or paused')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; issueCreationMode?: string; json?: boolean }) => {
      const root = repoRoot(opts.repo);
      const mode = opts.issueCreationMode;
      if (mode && !['open', 'focus_only', 'paused'].includes(mode)) throw new Error('issue creation mode must be open, focus_only, or paused');
      const result = mode ? saveControllerProjectState(root, { issueCreationMode: mode as 'open' | 'focus_only' | 'paused' }, 'controller-cli') : loadControllerProjectState(root);
      output(result, opts.json === true);
    });

  command.command('timeline')
    .description('Show the unified controller worklog and Run timeline')
    .option('--repo <path>', 'Repository root')
    .option('--issue <id>', 'Filter by Issue ID')
    .option('--task <id>', 'Filter by Task ID')
    .option('--run <id>', 'Filter by Run ID')
    .option('--category <name>', 'Filter by category')
    .option('--limit <count>', 'Maximum events', '100')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; issue?: string; task?: string; run?: string; category?: string; limit?: string; json?: boolean }) => {
      const events = getControllerTimeline(repoRoot(opts.repo), {
        issueId: opts.issue,
        taskId: opts.task,
        runId: opts.run,
        category: parseWorklogCategory(opts.category),
        limit: Math.max(1, Number(opts.limit ?? 100)),
      });
      if (opts.json) return output({ events }, true);
      output(events.map((event) => `${event.at}  ${event.category}/${event.action}  ${[event.issueId, event.taskId, event.runId].filter(Boolean).join('/')}
  ${event.summary}`).join('\n'));
    });

  command.command('export-worklog')
    .description('Export the controller worklog to a tracked Markdown or JSON report')
    .option('--repo <path>', 'Repository root')
    .option('--format <format>', 'markdown or json', 'markdown')
    .option('--output <path>', 'Repository-relative output path')
    .option('--issue <id>', 'Filter by Issue ID')
    .option('--task <id>', 'Filter by Task ID')
    .option('--run <id>', 'Filter by Run ID')
    .option('--json', 'Output command result as JSON')
    .action((opts: { repo?: string; format?: string; output?: string; issue?: string; task?: string; run?: string; json?: boolean }) => {
      const result = exportControllerWorklog(repoRoot(opts.repo), {
        format: opts.format === 'json' ? 'json' : 'markdown',
        outputPath: opts.output,
        filter: { issueId: opts.issue, taskId: opts.task, runId: opts.run },
      });
      output(opts.json ? result : `Exported ${result.eventCount} events to ${result.path}`, opts.json === true);
    });

  const githubPlugin = command.command('github')
    .description('Configure and use the optional GitHub Issue/Project plugin');

  githubPlugin.command('status')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; json?: boolean }) => output(getGitHubPluginStatus(repoRoot(opts.repo)), opts.json === true));

  githubPlugin.command('configure')
    .option('--repo <path>', 'Repository root')
    .option('--enable', 'Enable the plugin')
    .option('--disable', 'Disable the plugin')
    .option('--github-repo <owner/repo>', 'Explicit GitHub repository')
    .option('--clear-repository', 'Clear the configured GitHub repository')
    .option('--sync-mode <mode>', 'manual or checkpoint')
    .option('--include-tasks', 'Mirror Tasks as GitHub sub-issues')
    .option('--exclude-tasks', 'Do not mirror Tasks')
    .option('--project-owner <owner>', 'GitHub Project owner')
    .option('--project-number <number>', 'GitHub Project number')
    .option('--clear-project', 'Clear GitHub Project owner and number')
    .option('--json', 'Output JSON')
    .action((opts: { repo?: string; enable?: boolean; disable?: boolean; githubRepo?: string; clearRepository?: boolean; syncMode?: string; includeTasks?: boolean; excludeTasks?: boolean; projectOwner?: string; projectNumber?: string; clearProject?: boolean; json?: boolean }) => {
      if (opts.enable && opts.disable) throw new Error('choose either --enable or --disable');
      if (opts.includeTasks && opts.excludeTasks) throw new Error('choose either --include-tasks or --exclude-tasks');
      const config = saveGitHubPluginConfig(repoRoot(opts.repo), {
        enabled: opts.enable ? true : opts.disable ? false : undefined,
        repository: opts.clearRepository ? '' : opts.githubRepo,
        syncMode: opts.syncMode === 'checkpoint' ? 'checkpoint' : opts.syncMode === 'manual' ? 'manual' : undefined,
        includeTasks: opts.includeTasks ? true : opts.excludeTasks ? false : undefined,
        projectOwner: opts.clearProject ? '' : opts.projectOwner,
        projectNumber: opts.clearProject ? null : opts.projectNumber ? Number(opts.projectNumber) : undefined,
      });
      output(config, opts.json === true);
    });

  githubPlugin.command('publish')
    .argument('<issue-id>', 'Controller Issue ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((issueId: string, opts: { repo?: string; json?: boolean }) => output(publishIssueWithGitHubPlugin(repoRoot(opts.repo), issueId), opts.json === true));

  githubPlugin.command('refresh')
    .argument('<issue-id>', 'Controller Issue ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((issueId: string, opts: { repo?: string; json?: boolean }) => output(refreshIssueWithGitHubPlugin(repoRoot(opts.repo), issueId), opts.json === true));

  githubPlugin.command('close')
    .argument('<issue-id>', 'Controller Issue ID')
    .option('--repo <path>', 'Repository root')
    .option('--json', 'Output JSON')
    .action((issueId: string, opts: { repo?: string; json?: boolean }) => output(closeIssueWithGitHubPlugin(repoRoot(opts.repo), issueId), opts.json === true));

  command.command('github-status')
    .description('Check gh authentication, repository resolution, Projects access prerequisites, and Copilot agent-task CLI support')
    .option('--repo <path>', 'Repository root')
    .option('--github-repo <owner/repo>', 'Explicit GitHub repository')
    .option('--clear-repository', 'Clear the configured GitHub repository')
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
