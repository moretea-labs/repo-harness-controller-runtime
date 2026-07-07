import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { inspectCompletionBacklog, type CompletionBacklogReport } from './completion-backlog';
import { inspectStuckControllerStates, type StuckControllerStateReport } from './stuck-state-migration';

export type CodexContinuationMode = 'prepare' | 'launch';

export interface CodexContinuationOptions {
  objective?: string;
  maxItems?: number;
  mode?: CodexContinuationMode;
  reviewer?: string;
}

export interface CodexContinuationPacket {
  schemaVersion: 1;
  packetId: string;
  createdAt: string;
  objective: string;
  repoRootHint: string;
  controller: 'codex-cli';
  allowedActions: string[];
  stopConditions: string[];
  backlog: Pick<CompletionBacklogReport, 'counts' | 'finishableRunIds' | 'needsHumanReviewRunIds' | 'retryTaskRefs' | 'recommendations'>;
  stuckStates: Pick<StuckControllerStateReport, 'counts' | 'recommendations'>;
  nextCommands: string[];
}

export interface CodexContinuationResult {
  packet: CodexContinuationPacket;
  packetPath: string;
  promptPath: string;
  prompt: string;
  launched: boolean;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
  error?: string;
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function tail(text: string, max = 8000): string {
  return text.length <= max ? text : text.slice(-max);
}

function continuationDir(repoRoot: string): string {
  return join(repoRoot, '.ai', 'harness', 'continuations');
}

function relativePath(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).replace(/\\/g, '/');
}

export function buildCodexContinuationPrompt(packet: CodexContinuationPacket): string {
  return `# repo-harness Codex continuation

## Objective
${packet.objective}

## Role
You are the local Codex controller for this trusted repository. Use repo-harness commands as the execution boundary. Do not add external API-key based model clients. Do not perform destructive Git operations unless explicitly requested.

## Current completion backlog
- auto-finishable runs: ${packet.backlog.finishableRunIds.length}
- human-review runs: ${packet.backlog.needsHumanReviewRunIds.length}
- retry-required tasks: ${packet.backlog.retryTaskRefs.length}
- counts: ${JSON.stringify(packet.backlog.counts)}

## Stuck-state summary
- counts: ${JSON.stringify(packet.stuckStates.counts)}

## Recommended next commands
${packet.nextCommands.map((command) => `- \`${command}\``).join('\n') || '- No automatic command is currently recommended.'}

## Allowed actions
${packet.allowedActions.map((action) => `- ${action}`).join('\n')}

## Stop conditions
${packet.stopConditions.map((condition) => `- ${condition}`).join('\n')}

## Instructions
1. Prefer \`repo-harness controller completion-backlog --json\` before starting new work.
2. Run \`repo-harness controller finish-ready-runs --apply --json\` only for low/medium auto-finishable runs.
3. For high/destructive work, prepare a concise review summary instead of auto-approving it.
4. If a command fails because of tool/platform limitations, write a small patch or a continuation note rather than retrying the same blocked path repeatedly.
5. Finish with checks, a short status summary, and explicit remaining blockers.
`;
}

export function prepareCodexContinuation(repoRoot: string, options: CodexContinuationOptions = {}): CodexContinuationResult {
  const backlog = inspectCompletionBacklog(repoRoot, { limit: options.maxItems ?? 100 });
  const stuckStates = inspectStuckControllerStates(repoRoot, { limit: options.maxItems ?? 100 });
  const id = `CONT-${timestampId()}`;
  const objective = options.objective?.trim() || 'Close repo-harness completion backlog using local Codex and repo-harness safety gates.';
  const packet: CodexContinuationPacket = {
    schemaVersion: 1,
    packetId: id,
    createdAt: new Date().toISOString(),
    objective,
    repoRootHint: '.',
    controller: 'codex-cli',
    allowedActions: [
      'inspect compact backlog and stuck-state reports',
      'finish low/medium successful runs using repo-harness controller finish-ready-runs',
      'prepare patches for remaining blocker classes',
      'run declared checks and summarize failures',
    ],
    stopConditions: [
      'destructive, external-write, publish, payment, messaging, or force-push action is required',
      'a high/destructive task needs approve_and_finish',
      'checks fail for reasons unrelated to the current completion work',
      'repository has unrelated staged changes that would be mixed with completion commits',
    ],
    backlog: {
      counts: backlog.counts,
      finishableRunIds: backlog.finishableRunIds,
      needsHumanReviewRunIds: backlog.needsHumanReviewRunIds,
      retryTaskRefs: backlog.retryTaskRefs,
      recommendations: backlog.recommendations,
    },
    stuckStates: {
      counts: stuckStates.counts,
      recommendations: stuckStates.recommendations,
    },
    nextCommands: [
      'repo-harness controller completion-backlog --json',
      'repo-harness controller stuck-states --json',
      ...(backlog.finishableRunIds.length ? ['repo-harness controller finish-ready-runs --apply --json'] : []),
      'npm run check:type',
      'npm run check:mcp-compatibility',
    ],
  };
  const dir = continuationDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const packetAbsolute = join(dir, `${id}.json`);
  const promptAbsolute = join(dir, `${id}.md`);
  const prompt = buildCodexContinuationPrompt(packet);
  writeFileSync(packetAbsolute, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  writeFileSync(promptAbsolute, prompt, 'utf-8');
  const result: CodexContinuationResult = {
    packet,
    packetPath: relativePath(repoRoot, packetAbsolute),
    promptPath: relativePath(repoRoot, promptAbsolute),
    prompt,
    launched: false,
  };
  if (options.mode !== 'launch') return result;
  const launched = spawnSync('codex', ['exec', '--json', '--cd', repoRoot, prompt], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  return {
    ...result,
    launched: true,
    exitCode: launched.status,
    stdoutTail: tail(typeof launched.stdout === 'string' ? launched.stdout : ''),
    stderrTail: tail(typeof launched.stderr === 'string' ? launched.stderr : ''),
    error: launched.error?.message,
  };
}
