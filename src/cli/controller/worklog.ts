import { randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";

const WORKLOG_PATH = ".ai/harness/controller/worklog.jsonl";

export const WORKLOG_CATEGORIES = [
  "issue",
  "task",
  "run",
  "verification",
  "edit",
  "github",
  "local_job",
  "system",
] as const;

export type WorklogCategory = (typeof WORKLOG_CATEGORIES)[number];

export function parseWorklogCategory(value: unknown): WorklogCategory | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && WORKLOG_CATEGORIES.includes(value as WorklogCategory)) {
    return value as WorklogCategory;
  }
  throw new Error(`invalid worklog category: ${String(value)}`);
}

export interface ControllerWorklogEvent {
  schemaVersion: 1;
  id: string;
  at: string;
  category: WorklogCategory;
  action: string;
  summary: string;
  actor: string;
  issueId?: string;
  taskId?: string;
  runId?: string;
  jobId?: string;
  editSessionId?: string;
  statusFrom?: string;
  statusTo?: string;
  details?: Record<string, unknown>;
}

export interface WorklogFilter {
  category?: WorklogCategory;
  issueId?: string;
  taskId?: string;
  runId?: string;
  jobId?: string;
  editSessionId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

function worklogPath(repoRoot: string): string {
  return join(repoRoot, WORKLOG_PATH);
}

function eventId(): string {
  return `WL-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export function appendControllerWorklogEvent(
  repoRoot: string,
  event: Omit<ControllerWorklogEvent, "schemaVersion" | "id" | "at" | "actor"> & {
    at?: string;
    actor?: string;
  },
): ControllerWorklogEvent {
  const record: ControllerWorklogEvent = {
    schemaVersion: 1,
    id: eventId(),
    at: event.at ?? new Date().toISOString(),
    actor: event.actor?.trim() || "repo-harness-controller",
    category: event.category,
    action: event.action,
    summary: event.summary,
    issueId: event.issueId,
    taskId: event.taskId,
    runId: event.runId,
    jobId: event.jobId,
    editSessionId: event.editSessionId,
    statusFrom: event.statusFrom,
    statusTo: event.statusTo,
    details: event.details,
  };
  const path = worklogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

export function tryAppendControllerWorklogEvent(
  repoRoot: string,
  event: Parameters<typeof appendControllerWorklogEvent>[1],
): void {
  try {
    appendControllerWorklogEvent(repoRoot, event);
  } catch (_error) {
    // Worklog recording is evidence enrichment. It must not corrupt the source mutation.
  }
}

export function listControllerWorklogEvents(
  repoRoot: string,
  filter: WorklogFilter = {},
): ControllerWorklogEvent[] {
  const path = worklogPath(repoRoot);
  if (!existsSync(path)) return [];
  const since = filter.since ? Date.parse(filter.since) : Number.NEGATIVE_INFINITY;
  const until = filter.until ? Date.parse(filter.until) : Number.POSITIVE_INFINITY;
  const events = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ControllerWorklogEvent];
      } catch (_error) {
        return [];
      }
    })
    .filter((event) => {
      const at = Date.parse(event.at);
      return (
        (!filter.category || event.category === filter.category) &&
        (!filter.issueId || event.issueId === filter.issueId) &&
        (!filter.taskId || event.taskId === filter.taskId) &&
        (!filter.runId || event.runId === filter.runId) &&
        (!filter.jobId || event.jobId === filter.jobId) &&
        (!filter.editSessionId || event.editSessionId === filter.editSessionId) &&
        at >= since &&
        at <= until
      );
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, Math.max(1, Math.min(filter.limit ?? 200, 5000)));
}

function markdownEscape(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function exportControllerWorklog(
  repoRoot: string,
  options: {
    format?: "markdown" | "json";
    outputPath?: string;
    filter?: WorklogFilter;
  } = {},
): { path: string; format: "markdown" | "json"; eventCount: number } {
  const format = options.format ?? "markdown";
  const events = listControllerWorklogEvents(repoRoot, {
    ...options.filter,
    limit: options.filter?.limit ?? 5000,
  }).slice().reverse();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const defaultPath = `tasks/reports/controller-worklog-${stamp}.${format === "json" ? "json" : "md"}`;
  const outputPath = options.outputPath?.trim() || defaultPath;
  const absolute = resolve(repoRoot, outputPath);
  const relativeOutput = relative(repoRoot, absolute);
  if (!relativeOutput || relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) {
    throw new Error("worklog output path must stay inside the repository");
  }
  mkdirSync(dirname(absolute), { recursive: true });
  if (format === "json") {
    writeFileSync(absolute, `${JSON.stringify({ generatedAt: new Date().toISOString(), events }, null, 2)}\n`, "utf-8");
  } else {
    const lines = [
      "---",
      `generated_at: ${JSON.stringify(new Date().toISOString())}`,
      'source: "repo-harness-controller-v8"',
      `event_count: ${events.length}`,
      "---",
      "",
      "# Controller Worklog",
      "",
      "| Time | Category | Action | Scope | Summary | Actor |",
      "| --- | --- | --- | --- | --- | --- |",
      ...events.map((event) => {
        const scope = [event.issueId, event.taskId, event.runId, event.jobId, event.editSessionId].filter(Boolean).join(" / ") || "project";
        return `| ${markdownEscape(event.at)} | ${markdownEscape(event.category)} | ${markdownEscape(event.action)} | ${markdownEscape(scope)} | ${markdownEscape(event.summary)} | ${markdownEscape(event.actor)} |`;
      }),
      "",
    ];
    writeFileSync(absolute, lines.join("\n"), "utf-8");
  }
  return { path: relative(repoRoot, absolute).replace(/\\/g, "/"), format, eventCount: events.length };
}

export function controllerWorklogLocation(): string {
  return WORKLOG_PATH;
}
