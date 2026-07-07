import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyScheduleDedupe, buildScheduleDedupeReport, createSchedule, getSchedule } from "../../src/runtime/workflow/schedules/store";

function scheduleInput(repoId: string, requestId: string) {
  return {
    repoId,
    requestId,
    name: "Daily repo review",
    enabled: true,
    trigger: { type: "interval" as const, everyMinutes: 60 },
    policy: {
      maxActiveOccurrences: 1,
      maxFailures: 3,
      cooldownMinutes: 5,
      dailyBudgetMinutes: 30,
      shadowMode: false,
    },
    action: { operation: "repository_stuck_diagnose", arguments: { repo_id: repoId } },
    stopConditions: [],
  };
}

describe("schedule dedupe engine", () => {
  test("reports duplicate schedules and can pause older enabled duplicates", () => {
    const workspace = mkdtempSync(join(tmpdir(), "repo-harness-schedule-dedupe-"));
    const controllerHome = join(workspace, "controller-home");
    const repoId = "repo-schedule-test";
    try {
      const first = createSchedule(controllerHome, scheduleInput(repoId, "req-1"));
      const second = createSchedule(controllerHome, scheduleInput(repoId, "req-2"));

      const report = buildScheduleDedupeReport(controllerHome, repoId);
      expect(report.duplicateGroups.length).toBe(1);
      expect(report.proposedDisableCount).toBe(1);
      expect(report.duplicateGroups[0].scheduleIds.sort()).toEqual([first.scheduleId, second.scheduleId].sort());

      const dry = applyScheduleDedupe(controllerHome, repoId, { dryRun: true });
      expect(dry.disabled.length).toBe(0);
      expect(getSchedule(controllerHome, repoId, first.scheduleId).enabled).toBe(true);
      expect(getSchedule(controllerHome, repoId, second.scheduleId).enabled).toBe(true);

      const applied = applyScheduleDedupe(controllerHome, repoId, { confirmAuthorization: true });
      expect(applied.disabled.length).toBe(1);
      const schedules = [getSchedule(controllerHome, repoId, first.scheduleId), getSchedule(controllerHome, repoId, second.scheduleId)];
      expect(schedules.filter((schedule) => schedule.enabled).length).toBe(1);
      expect(schedules.filter((schedule) => !schedule.enabled)[0].pausedReason).toContain("duplicate schedule paused");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
