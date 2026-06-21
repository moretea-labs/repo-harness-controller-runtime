import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getGitHubStatus, publishIssueToGitHub, refreshGitHubIssue, closeGitHubIssue } from "./github";
import type { ControllerIssue } from "../controller/types";
import { tryAppendControllerWorklogEvent } from "../controller/worklog";

const CONFIG_PATH = ".repo-harness/plugins/github.json";
const STATUS_CACHE_TTL_MS = 30_000;
const statusCache = new Map<string, { at: number; fingerprint: string; status: GitHubPluginStatus }>();

export interface GitHubPluginConfig {
  schemaVersion: 1;
  enabled: boolean;
  repository?: string;
  syncMode: "manual" | "checkpoint";
  includeTasks: boolean;
  projectOwner?: string;
  projectNumber?: number;
}

export interface GitHubPluginStatus {
  config: GitHubPluginConfig;
  probed: boolean;
  available: boolean;
  authenticated: boolean;
  ready: boolean;
  repository?: string;
  errors: string[];
  warnings: string[];
  capabilities: {
    issues: boolean;
    projects: boolean;
    copilotAgentSessions: boolean;
  };
}

export function defaultGitHubPluginConfig(): GitHubPluginConfig {
  return {
    schemaVersion: 1,
    enabled: false,
    syncMode: "manual",
    includeTasks: true,
  };
}

export function loadGitHubPluginConfig(repoRoot: string): GitHubPluginConfig {
  const path = join(repoRoot, CONFIG_PATH);
  if (!existsSync(path)) return defaultGitHubPluginConfig();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<GitHubPluginConfig>;
    const repository = typeof raw.repository === "string" && raw.repository.trim()
      ? raw.repository.trim()
      : undefined;
    const projectOwner = typeof raw.projectOwner === "string" && raw.projectOwner.trim()
      ? raw.projectOwner.trim()
      : undefined;
    const projectNumber = Number.isInteger(raw.projectNumber) && Number(raw.projectNumber) > 0
      ? Number(raw.projectNumber)
      : undefined;
    return {
      schemaVersion: 1,
      enabled: raw.enabled === true,
      repository,
      syncMode: raw.syncMode === "checkpoint" ? "checkpoint" : "manual",
      includeTasks: raw.includeTasks !== false,
      projectOwner,
      projectNumber,
    };
  } catch (_error) {
    return defaultGitHubPluginConfig();
  }
}

export type GitHubPluginConfigPatch = Partial<Omit<GitHubPluginConfig, "schemaVersion" | "projectNumber">> & {
  projectNumber?: number | null;
};

export function saveGitHubPluginConfig(
  repoRoot: string,
  patch: GitHubPluginConfigPatch,
): GitHubPluginConfig {
  const current = loadGitHubPluginConfig(repoRoot);
  const repository = patch.repository === undefined
    ? current.repository
    : patch.repository.trim() || undefined;
  const projectOwner = patch.projectOwner === undefined
    ? current.projectOwner
    : patch.projectOwner.trim() || undefined;
  let projectNumber = patch.projectNumber === undefined ? current.projectNumber : patch.projectNumber ?? undefined;
  if (projectNumber !== undefined) {
    if (!Number.isInteger(projectNumber) || projectNumber < 1) {
      throw new Error("GitHub project number must be a positive integer");
    }
  }
  const config: GitHubPluginConfig = {
    schemaVersion: 1,
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    repository,
    syncMode: patch.syncMode === "manual" || patch.syncMode === "checkpoint"
      ? patch.syncMode
      : current.syncMode,
    includeTasks: typeof patch.includeTasks === "boolean" ? patch.includeTasks : current.includeTasks,
    projectOwner,
    projectNumber,
  };
  const path = join(repoRoot, CONFIG_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  statusCache.delete(repoRoot);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "github",
    action: "github_plugin_configured",
    summary: `GitHub plugin ${config.enabled ? "enabled" : "disabled"}.`,
    actor: "local-controller",
    details: { config },
  });
  return config;
}

export function getGitHubPluginStatus(repoRoot: string, forceRefresh = false): GitHubPluginStatus {
  const config = loadGitHubPluginConfig(repoRoot);
  if (!config.enabled) {
    return {
      config,
      probed: false,
      available: false,
      authenticated: false,
      ready: false,
      repository: config.repository,
      errors: [],
      warnings: ["GitHub plugin is disabled. Enable it to probe GitHub CLI and repository readiness."],
      capabilities: { issues: false, projects: false, copilotAgentSessions: false },
    };
  }
  const fingerprint = JSON.stringify(config);
  const cached = statusCache.get(repoRoot);
  if (!forceRefresh && cached && cached.fingerprint === fingerprint && Date.now() - cached.at < STATUS_CACHE_TTL_MS) {
    return cached.status;
  }
  const status = getGitHubStatus(repoRoot, config.repository);
  const result: GitHubPluginStatus = {
    config,
    probed: true,
    available: status.available,
    authenticated: status.authenticated,
    ready: status.available && status.authenticated && Boolean(status.repository),
    repository: status.repository?.nameWithOwner ?? config.repository,
    errors: status.errors,
    warnings: status.agentTaskSupported ? [] : ["GitHub CLI is too old for observable Copilot agent sessions; Issue synchronization remains available."],
    capabilities: {
      issues: status.available && status.authenticated,
      projects: status.available && status.authenticated,
      copilotAgentSessions: status.agentTaskSupported,
    },
  };
  statusCache.set(repoRoot, { at: Date.now(), fingerprint, status: result });
  return result;
}

function requireEnabled(repoRoot: string): GitHubPluginConfig {
  const config = loadGitHubPluginConfig(repoRoot);
  if (!config.enabled) throw new Error("GitHub plugin is disabled. Enable it before publishing or syncing Issues.");
  return config;
}

export function publishIssueWithGitHubPlugin(repoRoot: string, issueId: string): ControllerIssue {
  const config = requireEnabled(repoRoot);
  const issue = publishIssueToGitHub(repoRoot, issueId, {
    repo: config.repository,
    includeTasks: config.includeTasks,
    projectOwner: config.projectOwner,
    projectNumber: config.projectNumber,
  });
  statusCache.delete(repoRoot);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "github",
    action: "github_issue_published",
    summary: `Published ${issue.id} to GitHub.`,
    actor: "github-plugin",
    issueId: issue.id,
    details: { url: issue.github?.url },
  });
  return issue;
}

export function refreshIssueWithGitHubPlugin(repoRoot: string, issueId: string) {
  requireEnabled(repoRoot);
  const result = refreshGitHubIssue(repoRoot, issueId);
  statusCache.delete(repoRoot);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "github",
    action: "github_issue_refreshed",
    summary: `Refreshed ${issueId} from GitHub.`,
    actor: "github-plugin",
    issueId,
    details: { url: result.issue.github?.url, remote: result.remote },
  });
  return result;
}

export function closeIssueWithGitHubPlugin(repoRoot: string, issueId: string): ControllerIssue {
  requireEnabled(repoRoot);
  const issue = closeGitHubIssue(repoRoot, issueId);
  statusCache.delete(repoRoot);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "github",
    action: "github_issue_closed",
    summary: `Closed the linked GitHub Issue for ${issueId}.`,
    actor: "github-plugin",
    issueId,
    details: { url: issue.github?.url },
  });
  return issue;
}

export function githubPluginConfigPath(): string {
  return CONFIG_PATH;
}
