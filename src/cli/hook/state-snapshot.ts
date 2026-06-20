import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'fs';
import { join } from 'path';

export type SnapshotPlanState =
  | 'none'
  | 'stale_marker'
  | 'foreign_worktree'
  | 'draft'
  | 'annotating'
  | 'approved'
  | 'executing'
  | 'unknown';

export interface StateSnapshot {
  readonly protocol: 1;
  readonly kind: 'repo-harness-state-snapshot';
  readonly states: {
    readonly spec: 'present' | 'missing';
    readonly plan: SnapshotPlanState;
    readonly pending: 'none' | 'fresh' | 'stale';
    readonly worktree: 'current' | 'linked_target' | 'foreign_marker';
    readonly contract: 'present' | 'missing';
    readonly contract_path: 'present' | 'missing';
    readonly evidence: 'unchecked' | 'complete' | 'incomplete';
  };
  readonly paths: {
    readonly active_plan: string | null;
    readonly contract: string | null;
  };
  readonly marker: {
    readonly problem: 'none' | 'deleted' | 'foreign_worktree';
  };
}

const ACTIVE_PLAN_MARKER = '.ai/harness/active-plan';
const LEGACY_ACTIVE_PLAN_MARKER = '.claude/.active-plan';
const ACTIVE_WORKTREE_MARKER = '.ai/harness/active-worktree';
const EVIDENCE_LABELS = [
  'State/progress path',
  'Verification evidence',
  'Evaluator rubric',
  'Stop condition',
  'Rollback surface',
] as const;

function repoPath(cwd: string, relPath: string): string {
  return join(cwd, relPath);
}

function readTrimmed(cwd: string, relPath: string): string | null {
  try {
    const value = readFileSync(repoPath(cwd, relPath), 'utf-8').trim();
    return value.length > 0 ? stripWrappingQuotes(value) : null;
  } catch {
    return null;
  }
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function fileExists(cwd: string, relPath: string | null | undefined): boolean {
  return Boolean(relPath) && existsSync(repoPath(cwd, relPath as string));
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function getPlanStatus(cwd: string, planPath: string): SnapshotPlanState {
  let content = '';
  try {
    content = readFileSync(repoPath(cwd, planPath), 'utf-8');
  } catch {
    return 'unknown';
  }
  const statusLine = content
    .split(/\r?\n/)
    .find((line) => line.includes('**Status**:'));
  const status = statusLine?.replace(/^.*\*\*Status\*\*:\s*/, '').trim();
  switch (status) {
    case 'Draft':
      return 'draft';
    case 'Annotating':
      return 'annotating';
    case 'Approved':
      return 'approved';
    case 'Executing':
      return 'executing';
    default:
      return 'unknown';
  }
}

function slugFromPlanPath(planPath: string): string | null {
  const base = planPath.split('/').pop() ?? '';
  const match = /^plan-\d{8}-\d{4}-(.+)\.md$/.exec(base);
  return match?.[1] ?? null;
}

function originalArtifactStemFromPlanPath(planPath: string): string | null {
  const base = planPath.split('/').pop() ?? '';
  const match = /^plan-(.+)\.md$/.exec(base);
  return match?.[1] ?? null;
}

function isTransientPlanSlug(slug: string): boolean {
  return /^(think-plan-\d+|codex-plan-\d+|approved-plan-\d+)$/.test(slug);
}

function titleSlugFromPlanFile(cwd: string, planPath: string): string | null {
  let content = '';
  try {
    content = readFileSync(repoPath(cwd, planPath), 'utf-8');
  } catch {
    return null;
  }
  const titleLine = content
    .split(/\r?\n/)
    .find((line) => line.startsWith('# Plan: '));
  const title = titleLine?.replace(/^# Plan:\s*/, '').trim();
  if (!title) return null;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-');
  return slug || null;
}

function artifactStemFromPlanPath(cwd: string, planPath: string): string | null {
  const stem = originalArtifactStemFromPlanPath(planPath);
  const slug = slugFromPlanPath(planPath);
  if (!stem || !slug) return null;
  const stampMatch = /^(\d{8}-\d{4})-.+$/.exec(stem);
  if (!stampMatch) return slug;
  if (isTransientPlanSlug(slug)) {
    const titleSlug = titleSlugFromPlanFile(cwd, planPath);
    if (titleSlug && titleSlug !== slug) return `${stampMatch[1]}-${titleSlug}`;
  }
  return stem;
}

function preferredOrLegacyPath(
  cwd: string,
  preferred: string,
  legacy: string,
): string {
  if (fileExists(cwd, preferred) || !fileExists(cwd, legacy)) return preferred;
  return legacy;
}

function deriveContractPath(cwd: string, planPath: string): string | null {
  const stem = artifactStemFromPlanPath(cwd, planPath);
  const slug = slugFromPlanPath(planPath);
  if (!stem || !slug) return null;
  return preferredOrLegacyPath(
    cwd,
    `tasks/contracts/${stem}.contract.md`,
    `tasks/contracts/${slug}.contract.md`,
  );
}

function evidenceContractComplete(cwd: string, planPath: string): boolean {
  let content = '';
  try {
    content = readFileSync(repoPath(cwd, planPath), 'utf-8');
  } catch {
    return false;
  }
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Evidence Contract\s*$/.test(line));
  if (start < 0) return false;
  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    section.push(lines[i]);
  }
  if (section.join('').trim().length === 0) return false;
  for (const label of EVIDENCE_LABELS) {
    const line = section.find((candidate) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(
        `^\\s*-\\s*(\\*\\*)?${escaped}(\\*\\*)?\\s*:`,
        'i',
      ).test(candidate);
    });
    if (!line) return false;
    const value = line.slice(line.indexOf(':') + 1).trim();
    if (!value || /^(tbd|todo|n\/a|none|unknown|\.\.\.)$/i.test(value)) {
      return false;
    }
  }
  return true;
}

function policyPath(cwd: string, jqPath: string, fallback: string): string {
  let policy: unknown;
  try {
    policy = JSON.parse(readFileSync(repoPath(cwd, '.ai/harness/policy.json'), 'utf-8'));
  } catch {
    return fallback;
  }
  const value = jqPath
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (current && typeof current === 'object' && segment in current) {
        return (current as Record<string, unknown>)[segment];
      }
      return undefined;
    }, policy);
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (
    value.startsWith('/') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.split('/').includes('..') ||
    !value.startsWith('.ai/harness/')
  ) {
    return fallback;
  }
  return value;
}

function planStatusForPendingDraft(cwd: string, planPath: string): string {
  if (!fileExists(cwd, planPath)) return '';
  const state = getPlanStatus(cwd, planPath);
  return state === 'draft' || state === 'annotating' ? state : '';
}

function pendingState(cwd: string, nowMs: number): 'none' | 'fresh' | 'stale' {
  const pendingPath = policyPath(
    cwd,
    '.planning.pending_orchestration_file',
    '.ai/harness/planning/pending.json',
  );
  if (!fileExists(cwd, pendingPath)) return 'none';
  let stat;
  try {
    stat = statSync(repoPath(cwd, pendingPath));
    if (stat.size <= 0) return 'none';
  } catch {
    return 'none';
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 1000));
  if (ageSeconds <= 259200) return 'fresh';
  let parsed: { draft_plan_path?: unknown } = {};
  try {
    parsed = JSON.parse(readFileSync(repoPath(cwd, pendingPath), 'utf-8'));
  } catch {
    return 'stale';
  }
  const draftPath =
    typeof parsed.draft_plan_path === 'string' ? parsed.draft_plan_path : '';
  if (
    draftPath &&
    planStatusForPendingDraft(cwd, draftPath) &&
    ageSeconds <= 604800
  ) {
    return 'fresh';
  }
  return 'stale';
}

function readActiveMarker(cwd: string, markerPath: string): {
  value: string | null;
  deleted: boolean;
} {
  const value = readTrimmed(cwd, markerPath);
  if (!value) return { value: null, deleted: false };
  if (fileExists(cwd, value)) return { value, deleted: false };
  return { value, deleted: true };
}

function activePlanInfo(cwd: string): {
  planPath: string | null;
  markerPlanPath: string | null;
  problem: 'none' | 'deleted' | 'foreign_worktree';
} {
  const current = safeRealpath(cwd);
  const owner = readTrimmed(cwd, ACTIVE_WORKTREE_MARKER);
  const markerPlanPath =
    readTrimmed(cwd, ACTIVE_PLAN_MARKER) ??
    readTrimmed(cwd, LEGACY_ACTIVE_PLAN_MARKER);

  if (owner && owner !== current) {
    return { planPath: null, markerPlanPath, problem: 'foreign_worktree' };
  }

  let deleted = false;
  for (const marker of [ACTIVE_PLAN_MARKER, LEGACY_ACTIVE_PLAN_MARKER]) {
    const result = readActiveMarker(cwd, marker);
    if (result.value && !result.deleted) {
      return { planPath: result.value, markerPlanPath: result.value, problem: 'none' };
    }
    deleted = deleted || result.deleted;
  }
  return {
    planPath: null,
    markerPlanPath,
    problem: deleted ? 'deleted' : 'none',
  };
}

export function buildStateSnapshot(
  cwd = process.cwd(),
  nowMs = Date.now(),
): StateSnapshot {
  const active = activePlanInfo(cwd);
  const validPlanPath = active.planPath;
  const plan =
    active.problem === 'foreign_worktree'
      ? 'foreign_worktree'
      : active.problem === 'deleted'
        ? 'stale_marker'
        : validPlanPath
          ? getPlanStatus(cwd, validPlanPath)
          : 'none';
  const contractPath = validPlanPath ? deriveContractPath(cwd, validPlanPath) : null;
  const evidence = validPlanPath
    ? evidenceContractComplete(cwd, validPlanPath)
      ? 'complete'
      : 'incomplete'
    : 'unchecked';

  return {
    protocol: 1,
    kind: 'repo-harness-state-snapshot',
    states: {
      spec: fileExists(cwd, 'docs/spec.md') ? 'present' : 'missing',
      plan,
      pending: pendingState(cwd, nowMs),
      worktree: active.problem === 'foreign_worktree' ? 'foreign_marker' : 'current',
      contract: contractPath && fileExists(cwd, contractPath) ? 'present' : 'missing',
      contract_path: contractPath ? 'present' : 'missing',
      evidence,
    },
    paths: {
      active_plan: validPlanPath ?? active.markerPlanPath,
      contract: contractPath,
    },
    marker: {
      problem: active.problem,
    },
  };
}

export interface StateSnapshotCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runStateSnapshotCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
): StateSnapshotCliResult {
  if (argv.length !== 1 || argv[0] !== '--json') {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'repo-harness-hook state-snapshot: usage: repo-harness-hook state-snapshot --json\n',
    };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(buildStateSnapshot(cwd))}\n`,
    stderr: '',
  };
}
