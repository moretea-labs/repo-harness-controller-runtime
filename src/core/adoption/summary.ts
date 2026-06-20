import type { AdoptionOperation, AdoptionPlanSummary } from "./operations";

const USER_OWNED_PATHS = new Set([".gitignore"]);

export function summarizeOperations(operations: readonly AdoptionOperation[]): AdoptionPlanSummary {
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let userOwnedFilesTouched = 0;
  let generatedFiles = 0;
  let repoHarnessOwnedFiles = 0;
  let requiresVerification = false;

  for (const operation of operations) {
    byKind[operation.kind] = (byKind[operation.kind] ?? 0) + 1;
    byStatus[operation.status] = (byStatus[operation.status] ?? 0) + 1;

    if (operation.path && USER_OWNED_PATHS.has(operation.path)) {
      userOwnedFilesTouched += 1;
    }
    if (operation.kind === "writeFile" || operation.kind === "appendManagedBlock") {
      generatedFiles += 1;
    }
    if (operation.path?.startsWith(".ai/")) {
      repoHarnessOwnedFiles += 1;
    }
    if (operation.kind === "runCheck" || operation.risk !== "low") {
      requiresVerification = true;
    }
  }

  return {
    total: operations.length,
    byKind,
    byStatus,
    plannedTotal: byStatus.planned ?? 0,
    skippedTotal: byStatus.skipped ?? 0,
    failedTotal: byStatus.failed ?? 0,
    userOwnedFilesTouched,
    generatedFiles,
    repoHarnessOwnedFiles,
    requiresVerification,
  };
}
