import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tryAppendControllerWorklogEvent } from "./worklog";

const PROJECT_STATE_PATH = ".ai/harness/controller/project-state.json";

export type IssueCreationMode = "open" | "focus_only" | "paused";

export interface ControllerProjectState {
  schemaVersion: 1;
  currentIssueId?: string;
  issueCreationMode: IssueCreationMode;
  showArchivedByDefault: boolean;
  updatedAt: string;
}

function defaultState(): ControllerProjectState {
  return {
    schemaVersion: 1,
    issueCreationMode: "open",
    showArchivedByDefault: false,
    updatedAt: new Date().toISOString(),
  };
}

function statePath(repoRoot: string): string {
  return join(repoRoot, PROJECT_STATE_PATH);
}

export function loadControllerProjectState(repoRoot: string): ControllerProjectState {
  const path = statePath(repoRoot);
  if (!existsSync(path)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ControllerProjectState>;
    return {
      schemaVersion: 1,
      currentIssueId: typeof parsed.currentIssueId === "string" && parsed.currentIssueId.trim()
        ? parsed.currentIssueId.trim()
        : undefined,
      issueCreationMode: ["open", "focus_only", "paused"].includes(parsed.issueCreationMode ?? "")
        ? parsed.issueCreationMode as IssueCreationMode
        : "open",
      showArchivedByDefault: parsed.showArchivedByDefault === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (_error) {
    return defaultState();
  }
}

export function saveControllerProjectState(
  repoRoot: string,
  patch: Partial<Pick<ControllerProjectState, "currentIssueId" | "issueCreationMode" | "showArchivedByDefault">>,
  actor = "repo-harness-controller",
): ControllerProjectState {
  const previous = loadControllerProjectState(repoRoot);
  const next: ControllerProjectState = {
    ...previous,
    ...patch,
    schemaVersion: 1,
    currentIssueId: patch.currentIssueId === "" ? undefined : patch.currentIssueId ?? previous.currentIssueId,
    updatedAt: new Date().toISOString(),
  };
  const path = statePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  const focusChanged = Object.prototype.hasOwnProperty.call(patch, "currentIssueId") && previous.currentIssueId !== next.currentIssueId;
  const creationPolicyChanged = patch.issueCreationMode !== undefined && patch.issueCreationMode !== previous.issueCreationMode;
  const archiveViewChanged = patch.showArchivedByDefault !== undefined && patch.showArchivedByDefault !== previous.showArchivedByDefault;
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "system",
    action: focusChanged
      ? "project_focus_changed"
      : creationPolicyChanged
        ? "issue_creation_policy_changed"
        : archiveViewChanged
          ? "archive_view_policy_changed"
          : "project_state_changed",
    summary: focusChanged
      ? next.currentIssueId
        ? `Current execution focus set to ${next.currentIssueId}.`
        : "Current execution focus cleared."
      : creationPolicyChanged
        ? `Issue creation mode changed from ${previous.issueCreationMode} to ${next.issueCreationMode}.`
        : archiveViewChanged
          ? `Archived-Issue default visibility changed to ${next.showArchivedByDefault}.`
          : "Controller project state refreshed.",
    actor,
    issueId: next.currentIssueId,
    details: {
      previousCurrentIssueId: previous.currentIssueId,
      issueCreationMode: next.issueCreationMode,
      showArchivedByDefault: next.showArchivedByDefault,
    },
  });
  return next;
}

export function clearCurrentIssue(repoRoot: string, actor?: string): ControllerProjectState {
  const previous = loadControllerProjectState(repoRoot);
  const next: ControllerProjectState = {
    ...previous,
    currentIssueId: undefined,
    updatedAt: new Date().toISOString(),
  };
  const path = statePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "system",
    action: "project_focus_cleared",
    summary: "Cleared the current execution focus.",
    actor: actor ?? "repo-harness-controller",
    issueId: previous.currentIssueId,
  });
  return next;
}

export function controllerProjectStateLocation(): string {
  return PROJECT_STATE_PATH;
}
