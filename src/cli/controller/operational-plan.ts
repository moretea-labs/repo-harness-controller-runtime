import { runProcess } from "../../effects/process-runner";
import type { TaskLedgerProjection } from "./task-ledger";

const OPERATIONAL_PLAN_SCHEMA_VERSION = 1;

export interface ControllerOperationalPlan {
  schemaVersion: typeof OPERATIONAL_PLAN_SCHEMA_VERSION;
  source: "controller-operational-plan";
  generatedAt: string;
  status: "ready" | "needs_attention" | "blocked";
  completedCapabilities: string[];
  remainingDecisionPoints: string[];
  diffProjection: {
    source: "live-git-diff-projection";
    dirty: boolean;
    changedFiles: Array<{ path: string; status: string }>;
    diffStat: string;
    reviewRequired: boolean;
  };
  validationStrategy: {
    source: "task-targeted-validation-policy";
    policy: "minimal" | "task-targeted" | "release-gate";
    checks: string[];
    reason: string;
  };
  recipeSystem: {
    source: "controller-recipe-system";
    recipes: Array<{
      id: string;
      label: string;
      when: string;
      steps: string[];
      requiredEvidence: string[];
    }>;
  };
  workerAbstraction: {
    source: "worker-routing-abstraction";
    workers: Array<{
      id: string;
      role: string;
      preferredFor: string[];
      avoidWhen: string[];
    }>;
    recommendedWorker: string;
  };
  guiInteraction: {
    source: "controller-console-interaction-model";
    primaryPanels: string[];
    primaryActions: string[];
    hiddenByDefault: string[];
  };
  mcpToolSchemaConvergence: {
    source: "mcp-tool-schema-convergence";
    readModels: string[];
    commandModels: string[];
    compatibilityRules: string[];
  };
  runtimeStorage: {
    source: "controller-home-runtime-storage-policy";
    controllerHomeFirst: true;
    legacyFallbackPreserved: true;
    repoLocalMutableRuntimeFilesAvoided: true;
  };
  branchWorktreeCleanup: {
    source: "safe-workspace-cleanup-policy";
    safeToAutoClean: boolean;
    requiredBeforeCleanup: string[];
    protectedCases: string[];
  };
  taskRecovery: {
    source: "task-recovery-loop";
    continuationState: string;
    nextActions: string[];
    handoffArtifacts: string[];
  };
}

function parseNameStatus(output: string): Array<{ path: string; status: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => {
      const [status, ...rest] = line.split(/\s+/);
      return { status: status || "unknown", path: rest.join(" ") || line };
    });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim()).map((value) => value.trim())));
}

function checksFromLedger(ledger: TaskLedgerProjection): string[] {
  const focused = ledger.status.taskId
    ? ledger.issues.flatMap((issue) => issue.tasks).find((task) => task.taskId === ledger.status.taskId && task.issueId === ledger.status.issueId)
    : undefined;
  const candidates = focused?.checks.length ? focused.checks : ledger.issues.flatMap((issue) => issue.tasks).flatMap((task) => task.checks);
  return unique(candidates.length ? candidates : ["package:check:type"]);
}

export function buildControllerOperationalPlan(repoRoot: string, ledger: TaskLedgerProjection): ControllerOperationalPlan {
  const nameStatus = runProcess("git", ["diff", "--name-status"], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const diffStat = runProcess("git", ["diff", "--stat"], { cwd: repoRoot, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
  const changedFiles = nameStatus.ok ? parseNameStatus(nameStatus.stdout) : [];
  const checks = checksFromLedger(ledger);
  const dirty = changedFiles.length > 0;
  const blocked = ledger.status.kind === "blocked" || ledger.status.kind === "needs_retry_decision";
  const needsAttention = blocked || ledger.status.severity === "action" || ledger.status.severity === "warning" || dirty;
  const policy = checks.some((check) => check.includes("release") || check.includes("ci"))
    ? "release-gate" as const
    : checks.length > 0
      ? "task-targeted" as const
      : "minimal" as const;

  return {
    schemaVersion: OPERATIONAL_PLAN_SCHEMA_VERSION,
    source: "controller-operational-plan",
    generatedAt: new Date().toISOString(),
    status: blocked ? "blocked" : needsAttention ? "needs_attention" : "ready",
    completedCapabilities: [
      "task-ledger",
      "context-pack",
      "diff-projection",
      "validation-strategy",
      "recipe-system",
      "worker-abstraction",
      "gui-interaction-model",
      "mcp-tool-schema-convergence",
      "controller-home-runtime-storage-policy",
      "branch-worktree-cleanup-policy",
      "task-recovery-loop",
    ],
    remainingDecisionPoints: dirty
      ? ["Review and commit or discard current diff before dispatching unrelated work."]
      : [],
    diffProjection: {
      source: "live-git-diff-projection",
      dirty,
      changedFiles,
      diffStat: diffStat.ok ? diffStat.stdout.trim() : diffStat.error || diffStat.stderr.trim(),
      reviewRequired: dirty,
    },
    validationStrategy: {
      source: "task-targeted-validation-policy",
      policy,
      checks,
      reason: policy === "release-gate"
        ? "Release or CI checks are declared by the focused work."
        : policy === "task-targeted"
          ? "Use checks declared on the focused task or ready queue; do not expand validation scope by default."
          : "No task-specific checks were found; keep validation minimal and explicit.",
    },
    recipeSystem: {
      source: "controller-recipe-system",
      recipes: [
        {
          id: "scoped-direct-edit",
          label: "Scoped direct edit",
          when: "Known files and low/medium-risk bounded changes.",
          steps: ["build context pack", "read exact ranges", "apply bounded patch", "review diff projection", "run task-targeted checks"],
          requiredEvidence: ["contextPack", "diffProjection", "validationStrategy"],
        },
        {
          id: "isolated-worker-run",
          label: "Isolated worker run",
          when: "Large, risky, or long-running implementation requiring agent execution.",
          steps: ["derive worker scope", "dispatch isolated run", "inspect run diff", "integrate through edit session", "verify exact revision"],
          requiredEvidence: ["run", "task diff", "integration session", "checks"],
        },
        {
          id: "recovery-resume",
          label: "Fresh-session recovery",
          when: "A controller session restarts or loses conversation state.",
          steps: ["load task ledger", "read operational plan", "select continuation state", "expand only needed context", "resume or ask for the one missing decision"],
          requiredEvidence: ["taskLedger", "operationalPlan", "handoffArtifacts"],
        },
      ],
    },
    workerAbstraction: {
      source: "worker-routing-abstraction",
      workers: [
        { id: "direct_edit", role: "transactional patch executor", preferredFor: ["small scoped edits", "known paths"], avoidWhen: ["unknown architecture", "long-running generation"] },
        { id: "quick_agent", role: "bounded investigation or small implementation", preferredFor: ["uncertain file discovery", "medium-risk changes"], avoidWhen: ["dirty main workspace", "release-critical changes"] },
        { id: "isolated_task_run", role: "durable worker with worktree", preferredFor: ["parallel tasks", "risky implementation"], avoidWhen: ["single-line fixes"] },
        { id: "github_copilot", role: "visible cloud coding session", preferredFor: ["remote reviewable work", "GitHub issue flow"], avoidWhen: ["secret-local context", "offline tasks"] },
      ],
      recommendedWorker: dirty ? "direct_edit" : ledger.status.kind === "ready_to_dispatch" ? "isolated_task_run" : "direct_edit",
    },
    guiInteraction: {
      source: "controller-console-interaction-model",
      primaryPanels: ["Needs Attention", "Current Work", "Context Pack", "Diff Review", "Validation", "Recovery"],
      primaryActions: ["Continue", "Review Diff", "Run Targeted Checks", "Accept", "Request Changes", "Retry", "Clean Safe Artifacts"],
      hiddenByDefault: ["raw run ids", "lease internals", "projection fingerprints", "scheduler queues"],
    },
    mcpToolSchemaConvergence: {
      source: "mcp-tool-schema-convergence",
      readModels: ["controller_context", "controller_context_pack", "work_status_digest", "prepare_handoff_artifacts"],
      commandModels: ["work_submit", "run_check", "dispatch_task", "verify_task", "accept_task", "repository_safe_patch_apply"],
      compatibilityRules: [
        "compact reads are default",
        "raw code and raw logs require explicit opt-in tools",
        "controller profile exposes recovery projections in core toolset",
        "new projections are additive and must not replace durable Issue/Task/Run state",
      ],
    },
    runtimeStorage: {
      source: "controller-home-runtime-storage-policy",
      controllerHomeFirst: true,
      legacyFallbackPreserved: true,
      repoLocalMutableRuntimeFilesAvoided: true,
    },
    branchWorktreeCleanup: {
      source: "safe-workspace-cleanup-policy",
      safeToAutoClean: !dirty && ledger.status.kind !== "active_work",
      requiredBeforeCleanup: ["clean git status", "no active local worker", "terminal run state", "no unique unmerged commits"],
      protectedCases: ["dirty main workspace", "waiting_for_user runs", "unmerged worktree branch", "unknown ownership metadata"],
    },
    taskRecovery: {
      source: "task-recovery-loop",
      continuationState: ledger.status.kind,
      nextActions: ledger.suggestedNextActions.slice(0, 6),
      handoffArtifacts: [".ai/harness/controller/task-ledger.json", ".ai/harness/handoff/controller-current.md"],
    },
  };
}
