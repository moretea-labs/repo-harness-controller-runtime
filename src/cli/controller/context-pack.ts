import { existsSync, lstatSync, readdirSync, statSync } from "fs";
import { gitSnapshot, readRepositoryRange, searchRepository } from "../repository/inspector";
import { resolveMcpPath, globMatches } from "../mcp/paths";
import type { McpPolicy } from "../mcp/types";
import { redactMcpText } from "../mcp/redaction";
import { projectBoard } from "./issue-store";
import { buildControllerTaskLedgerProjection, type TaskLedgerTaskProjection } from "./task-ledger";

const CONTEXT_PACK_SCHEMA_VERSION = 3;
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_SNIPPETS = 20;
const DEFAULT_SNIPPET_CONTEXT_BEFORE = 12;
const DEFAULT_SNIPPET_CONTEXT_AFTER = 28;
const DEFAULT_MAX_CHARS_PER_SNIPPET = 8000;

const STOPWORDS = new Set([
  "about", "after", "again", "also", "and", "around", "because", "before", "between", "change", "code", "config",
  "context", "current", "does", "file", "from", "have", "into", "issue", "make", "need", "needs", "only", "path",
  "repo", "repository", "runtime", "should", "task", "that", "this", "through", "todo", "update", "when", "with",
]);

export interface ControllerContextPackOptions {
  description?: string;
  issueId?: string;
  taskId?: string;
  knownPaths?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  searchTerms?: string[];
  maxFiles?: number;
  maxSnippets?: number;
  maxCharsPerSnippet?: number;
}

export interface ControllerContextPackSnippet {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  sha256: string;
  content: string;
  truncated: boolean;
  redactions: Array<{ type: string; count: number }>;
  reason: string;
}

export interface ControllerContextPackFile {
  path: string;
  reasons: string[];
  hitLines: number[];
  snippetCount: number;
  snippets: ControllerContextPackSnippet[];
}

export interface ControllerContextPackProjection {
  schemaVersion: typeof CONTEXT_PACK_SCHEMA_VERSION;
  generatedAt: string;
  source: "controller-context-pack";
  focus: {
    issueId?: string;
    issueTitle?: string;
    taskId?: string;
    taskTitle?: string;
    taskStatus?: string;
  };
  goal: string;
  git: {
    branch: string | null;
    status: string;
    diffStat: string;
    dirty: boolean;
  };
  search: {
    terms: string[];
    includeGlobs: string[];
    excludeGlobs: string[];
    scannedFiles: number;
    policyDeniedFiles: number;
    skippedLargeFiles: number;
    skippedBinaryFiles: number;
    truncated: boolean;
  };
  files: ControllerContextPackFile[];
  deniedPaths: Array<{ path: string; reason: string }>;
  omitted: Array<{ path: string; reason: string }>;
  limits: {
    maxFiles: number;
    maxSnippets: number;
    maxCharsPerSnippet: number;
  };
  validation: {
    policy: "task-targeted" | "minimal";
    checks: string[];
  };
  contextContract: {
    strategy: string;
    rawCodeRequiredForImplementation: true;
    notes: string[];
  };
  next: string[];
}

function cleanList(value: string[] | undefined): string[] {
  return Array.from(new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean)));
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function textTokens(value: string): string[] {
  const split = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const tokens = split
    .map((entry) => entry.replace(/^['"`]+|['"`]+$/g, ""))
    .filter((entry) => entry.length >= 3)
    .filter((entry) => !STOPWORDS.has(entry.toLowerCase()))
    .filter((entry) => !/^\d+$/.test(entry));
  return Array.from(new Set(tokens)).slice(0, 12);
}

interface ContextPackIssueFocus {
  id?: string;
  title?: string;
  summary?: string;
  tasks: ContextPackTaskFocus[];
}

interface ContextPackTaskFocus {
  id?: string;
  title?: string;
  objective?: string;
  status?: string;
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unknownString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unknownRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(unknownRecord).filter((entry) => Object.keys(entry).length > 0);
}

function contextPackTaskFocus(value: unknown): ContextPackTaskFocus {
  const record = unknownRecord(value);
  return {
    id: unknownString(record.id),
    title: unknownString(record.title),
    objective: unknownString(record.objective),
    status: unknownString(record.status),
  };
}

function contextPackIssueFocus(value: unknown): ContextPackIssueFocus {
  const record = unknownRecord(value);
  return {
    id: unknownString(record.id),
    title: unknownString(record.title),
    summary: unknownString(record.summary),
    tasks: unknownRecordArray(record.tasks).map(contextPackTaskFocus),
  };
}

function issueTaskFocus(repoRoot: string, issueId?: string, taskId?: string): { issue?: ContextPackIssueFocus; task?: ContextPackTaskFocus } {
  const board = projectBoard(repoRoot);
  const issues = board.issues.map(contextPackIssueFocus);
  const resolvedIssue = issueId
    ? issues.find((issue) => issue.id === issueId)
    : board.currentIssueId
      ? issues.find((issue) => issue.id === board.currentIssueId)
      : undefined;
  const resolvedTask = resolvedIssue?.tasks.find((task) => task.id === taskId) ?? resolvedIssue?.tasks[0];
  return { issue: resolvedIssue, task: resolvedTask };
}

function ledgerTask(repoRoot: string, issueId?: string, taskId?: string): TaskLedgerTaskProjection | undefined {
  const ledger = buildControllerTaskLedgerProjection(repoRoot);
  const tasks = ledger.issues.flatMap((issue) => issue.tasks);
  const findTask = (candidateIssueId?: string, candidateTaskId?: string) => tasks
    .find((task) => (!candidateIssueId || task.issueId === candidateIssueId) && (!candidateTaskId || task.taskId === candidateTaskId));

  if (!issueId && !taskId) {
    const readyTask = ledger.readyTasks[0];
    return ledger.attention[0]
      ?? findTask(readyTask?.issueId, readyTask?.taskId)
      ?? tasks.find((task) => task.dispatchable || task.queueable);
  }

  return findTask(issueId, taskId);
}

function looksLikeGlob(path: string): boolean {
  return /[*?{[]/.test(path);
}

function coveredByGlob(path: string, globs: string[]): boolean {
  return globs.length === 0 || globs.some((glob) => globMatches(glob, path));
}

function addReason(map: Map<string, { reasons: Set<string>; lines: Set<number> }>, path: string, reason: string, line?: number): void {
  const entry = map.get(path) ?? { reasons: new Set<string>(), lines: new Set<number>() };
  entry.reasons.add(reason);
  if (typeof line === "number" && Number.isFinite(line)) entry.lines.add(Math.max(1, Math.trunc(line)));
  map.set(path, entry);
}

function readableFile(repoRoot: string, policy: McpPolicy, path: string): { ok: true; path: string } | { ok: false; path: string; reason: string } {
  const decision = resolveMcpPath(repoRoot, path, policy, "read");
  if (!decision.ok || !decision.relativePath || !decision.absolutePath) {
    return { ok: false, path: decision.relativePath ?? path, reason: decision.reason ?? "path denied" };
  }
  if (!existsSync(decision.absolutePath)) return { ok: false, path: decision.relativePath, reason: "path does not exist" };
  if (!statSync(decision.absolutePath).isFile()) return { ok: false, path: decision.relativePath, reason: "path is not a file" };
  return { ok: true, path: decision.relativePath };
}

interface ExpandedKnownPath {
  files: string[];
  denied: Array<{ path: string; reason: string }>;
  directory?: string;
  truncated: boolean;
}

/**
 * Expand an explicit file or directory without following symlinks. Every file
 * is re-checked through resolveMcpPath so directory support never broadens the
 * policy boundary. Enumeration is deterministic and bounded.
 */
function expandKnownPath(
  repoRoot: string,
  policy: McpPolicy,
  path: string,
  maxFiles: number,
): ExpandedKnownPath {
  const decision = resolveMcpPath(repoRoot, path, policy, "read");
  if (!decision.ok || !decision.relativePath || !decision.absolutePath) {
    return { files: [], denied: [{ path: decision.relativePath ?? path, reason: decision.reason ?? "path denied" }], truncated: false };
  }
  if (!existsSync(decision.absolutePath)) {
    return { files: [], denied: [{ path: decision.relativePath, reason: "path does not exist" }], truncated: false };
  }
  const rootStat = lstatSync(decision.absolutePath);
  if (rootStat.isSymbolicLink()) {
    return { files: [], denied: [{ path: decision.relativePath, reason: "symbolic links are not followed" }], truncated: false };
  }
  if (rootStat.isFile()) return { files: [decision.relativePath], denied: [], truncated: false };
  if (!rootStat.isDirectory()) {
    return { files: [], denied: [{ path: decision.relativePath, reason: "path is neither a regular file nor directory" }], truncated: false };
  }

  const files: string[] = [];
  const denied: Array<{ path: string; reason: string }> = [];
  let truncated = false;
  const walk = (relativeDirectory: string, depth: number): void => {
    if (files.length >= maxFiles) { truncated = true; return; }
    if (depth > 8) { denied.push({ path: relativeDirectory, reason: "directory recursion depth exceeded" }); return; }
    const directoryDecision = resolveMcpPath(repoRoot, relativeDirectory, policy, "read");
    if (!directoryDecision.ok || !directoryDecision.absolutePath || !directoryDecision.relativePath) {
      denied.push({ path: directoryDecision.relativePath ?? relativeDirectory, reason: directoryDecision.reason ?? "path denied" });
      return;
    }
    let entries;
    try {
      entries = readdirSync(directoryDecision.absolutePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      denied.push({ path: directoryDecision.relativePath, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; break; }
      const child = `${directoryDecision.relativePath}/${entry.name}`.replace(/^\.\//, "");
      if (entry.isSymbolicLink()) {
        denied.push({ path: child, reason: "symbolic links are not followed" });
      } else if (entry.isDirectory()) {
        walk(child, depth + 1);
      } else if (entry.isFile()) {
        const readable = readableFile(repoRoot, policy, child);
        if (readable.ok) files.push(readable.path);
        else denied.push(readable);
      }
    }
  };
  walk(decision.relativePath, 0);
  return { files, denied, directory: decision.relativePath, truncated };
}

function boundedSnippet(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) return { content, truncated: false };
  return { content: `${content.slice(0, maxChars)}\n... <snippet truncated>`, truncated: true };
}

function mergeHitLines(lines: number[]): number[] {
  const sorted = Array.from(new Set(lines.filter((line) => line > 0))).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const line of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && line - previous <= DEFAULT_SNIPPET_CONTEXT_BEFORE + DEFAULT_SNIPPET_CONTEXT_AFTER) continue;
    merged.push(line);
  }
  return merged;
}

export function buildControllerContextPack(
  repoRoot: string,
  policy: McpPolicy,
  options: ControllerContextPackOptions = {},
): ControllerContextPackProjection {
  const maxFiles = clamp(options.maxFiles, DEFAULT_MAX_FILES, 1, 30);
  const maxSnippets = clamp(options.maxSnippets, DEFAULT_MAX_SNIPPETS, 1, 80);
  const maxCharsPerSnippet = clamp(options.maxCharsPerSnippet, DEFAULT_MAX_CHARS_PER_SNIPPET, 500, 50_000);
  const knownPaths = cleanList(options.knownPaths);
  const knownGlobs = knownPaths.filter(looksLikeGlob);
  const explicitKnownPaths = knownPaths.filter((path) => !looksLikeGlob(path));
  const includeGlobs = cleanList([...(options.includeGlobs ?? []), ...knownGlobs]);
  const excludeGlobs = cleanList(options.excludeGlobs);
  const focus = issueTaskFocus(repoRoot, options.issueId, options.taskId);
  const git = gitSnapshot(repoRoot);
  const compactTask = ledgerTask(repoRoot, focus.issue?.id, focus.task?.id);
  const allowedPathGlobs = cleanList(compactTask?.allowedPaths);
  const taskChecks = cleanList(compactTask?.checks);
  const goalParts = [
    options.description,
    focus.issue?.title,
    focus.issue?.summary,
    focus.task?.title,
    focus.task?.objective,
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  const goal = goalParts.join("\n").trim();
  const terms = cleanList([...(options.searchTerms ?? []), ...textTokens(goal)]).slice(0, 14);
  const candidates = new Map<string, { reasons: Set<string>; lines: Set<number> }>();
  const deniedPaths: Array<{ path: string; reason: string }> = [];
  const omitted: Array<{ path: string; reason: string }> = [];
  let scannedFiles = 0;
  let policyDeniedFiles = 0;
  let skippedLargeFiles = 0;
  let skippedBinaryFiles = 0;
  let searchTruncated = false;

  for (const path of explicitKnownPaths) {
    const expanded = expandKnownPath(repoRoot, policy, path, Math.max(maxFiles * 4, 40));
    for (const file of expanded.files) {
      addReason(candidates, file, expanded.directory ? `explicit-known-directory:${expanded.directory}` : "explicit-known-path", 1);
    }
    deniedPaths.push(...expanded.denied);
    scannedFiles += expanded.files.length;
    searchTruncated = searchTruncated || expanded.truncated;
  }

  for (const glob of allowedPathGlobs) {
    if (!includeGlobs.includes(glob)) includeGlobs.push(glob);
  }

  const searchIncludeGlobs = includeGlobs.length > 0 ? includeGlobs : allowedPathGlobs;
  for (const term of terms) {
    if (candidates.size >= maxFiles && terms.length > 1) break;
    const search = searchRepository(repoRoot, policy, {
      query: term,
      includeGlobs: searchIncludeGlobs,
      excludeGlobs,
      maxResults: Math.max(maxFiles * 4, 12),
      maxFiles: 10_000,
      caseSensitive: false,
    });
    scannedFiles += search.scannedFiles;
    policyDeniedFiles += search.policyDeniedFiles;
    skippedLargeFiles += search.skippedLargeFiles;
    skippedBinaryFiles += search.skippedBinaryFiles;
    searchTruncated = searchTruncated || search.truncated;
    for (const hit of search.results) {
      if (!coveredByGlob(hit.path, searchIncludeGlobs) || excludeGlobs.some((glob) => globMatches(glob, hit.path))) continue;
      addReason(candidates, hit.path, `search:${term}`, hit.line);
      if (candidates.size >= maxFiles * 3) break;
    }
  }

  const rankedCandidates = Array.from(candidates.entries())
    .map(([path, entry]) => ({ path, reasons: Array.from(entry.reasons), lines: Array.from(entry.lines) }))
    .sort((left, right) => {
      const leftExplicit = left.reasons.some((reason) => reason === "explicit-known-path" || reason.startsWith("explicit-known-directory:")) ? 1 : 0;
      const rightExplicit = right.reasons.some((reason) => reason === "explicit-known-path" || reason.startsWith("explicit-known-directory:")) ? 1 : 0;
      if (leftExplicit !== rightExplicit) return rightExplicit - leftExplicit;
      if (left.reasons.length !== right.reasons.length) return right.reasons.length - left.reasons.length;
      if (left.lines.length !== right.lines.length) return right.lines.length - left.lines.length;
      return left.path.localeCompare(right.path);
    });
  const selected = rankedCandidates.slice(0, maxFiles);
  for (const entry of rankedCandidates.slice(maxFiles)) omitted.push({ path: entry.path, reason: "max_files" });

  let remainingSnippets = maxSnippets;
  const files: ControllerContextPackFile[] = [];
  for (const entry of selected) {
    if (remainingSnippets <= 0) {
      omitted.push({ path: entry.path, reason: "max_snippets" });
      continue;
    }
    const hitLines = mergeHitLines(entry.lines.length > 0 ? entry.lines : [1]).slice(0, remainingSnippets);
    const snippets: ControllerContextPackSnippet[] = [];
    for (const line of hitLines) {
      if (remainingSnippets <= 0) break;
      try {
        const raw = readRepositoryRange(
          repoRoot,
          policy,
          entry.path,
          Math.max(1, line - DEFAULT_SNIPPET_CONTEXT_BEFORE),
          line + DEFAULT_SNIPPET_CONTEXT_AFTER,
        );
        const redacted = redactMcpText(raw.content);
        const bounded = boundedSnippet(redacted.text, maxCharsPerSnippet);
        snippets.push({
          path: raw.path,
          startLine: raw.startLine,
          endLine: raw.endLine,
          totalLines: raw.totalLines,
          sha256: raw.sha256,
          content: bounded.content,
          truncated: bounded.truncated,
          redactions: redacted.redactions,
          reason: entry.reasons.join(", "),
        });
        remainingSnippets -= 1;
      } catch (error) {
        deniedPaths.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (snippets.length > 0) {
      files.push({
        path: entry.path,
        reasons: entry.reasons,
        hitLines: Array.from(new Set(entry.lines)).sort((a, b) => a - b).slice(0, 30),
        snippetCount: snippets.length,
        snippets,
      });
    }
  }

  if (files.length === 0 && terms.length === 0 && explicitKnownPaths.length === 0) {
    omitted.push({ path: "<none>", reason: "No description, search_terms, issue/task focus, or known_paths produced search terms." });
  }

  return {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "controller-context-pack",
    focus: {
      issueId: focus.issue?.id,
      issueTitle: focus.issue?.title,
      taskId: focus.task?.id,
      taskTitle: focus.task?.title,
      taskStatus: compactTask?.effectiveStatus ?? focus.task?.status,
    },
    goal,
    git,
    search: {
      terms,
      includeGlobs: searchIncludeGlobs,
      excludeGlobs,
      scannedFiles,
      policyDeniedFiles,
      skippedLargeFiles,
      skippedBinaryFiles,
      truncated: searchTruncated,
    },
    files,
    deniedPaths: deniedPaths.slice(0, 20),
    omitted: omitted.slice(0, 30),
    limits: { maxFiles, maxSnippets, maxCharsPerSnippet },
    validation: {
      policy: taskChecks.length > 0 ? "task-targeted" : "minimal",
      checks: taskChecks,
    },
    contextContract: {
      strategy: "Use this pack for scoped investigation only. Do not treat search ranking or summaries as proof of the correct implementation.",
      rawCodeRequiredForImplementation: true,
      notes: [
        "The pack includes bounded raw snippets around explicit paths and search hits; expand exact files/ranges before editing important code.",
        "Run focused validation after patching; a context pack is not a substitute for tests, typecheck, diff review, or source review.",
        taskChecks.length > 0 ? `Task checks advertised by the board: ${taskChecks.join(", ")}.` : "No task-specific checks were found in the compact ledger.",
      ],
    },
    next: [
      files.length > 0
        ? "Inspect the returned snippets and request exact wider ranges for files that will be edited."
        : "Provide known_paths or narrower search_terms before attempting implementation.",
      "After editing, review diff projection plus the raw diff for the edited files.",
      "Use targeted validation before accepting or merging the change.",
    ],
  };
}
