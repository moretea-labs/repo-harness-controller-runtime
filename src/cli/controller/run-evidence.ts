import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { AgentJobMeta } from "../agent-jobs/types";
import type { ControllerIssue, ControllerTask } from "./types";

const JOB_ROOT = ".ai/harness/jobs";

function readRun(repoRoot: string, runId: string): AgentJobMeta | undefined {
  const path = join(repoRoot, JOB_ROOT, runId, "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AgentJobMeta;
  } catch (_error) {
    return undefined;
  }
}

export function readTaskRunEvidence(repoRoot: string, task: ControllerTask): AgentJobMeta[] {
  return task.runIds
    .map((runId) => readRun(repoRoot, runId))
    .filter((run): run is AgentJobMeta => Boolean(run));
}

export function readIssueRunEvidence(
  repoRoot: string,
  issue: ControllerIssue,
): Map<string, AgentJobMeta[]> {
  return new Map(
    issue.tasks.map((task) => [task.id, readTaskRunEvidence(repoRoot, task)]),
  );
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'starting', 'running', 'waiting_for_user']);

export function readActiveRunEvidence(repoRoot: string): AgentJobMeta[] {
  const root = join(repoRoot, JOB_ROOT);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRun(repoRoot, entry.name))
    .filter((run): run is AgentJobMeta => Boolean(run))
    .filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
}
