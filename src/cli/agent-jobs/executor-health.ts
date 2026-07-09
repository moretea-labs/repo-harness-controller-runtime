import type { GitHubStatus } from "../github/github";
import type { McpAgentRunnerName } from "../mcp/types";
import type { ControllerAgent, ControllerTask } from "../controller/types";

export type ExecutorHealthStatus =
  | "available"
  | "disabled"
  | "not_installed"
  | "auth_required"
  | "quota_or_balance"
  | "cloud_not_enabled"
  | "unknown";

export type ExecutorHealthReason =
  | "local_dev_runner_disabled"
  | "local_agent_disabled"
  | "github_cli_unavailable"
  | "github_auth_required"
  | "github_cli_too_old"
  | "copilot_cca_disabled"
  | "codex_auth_required"
  | "codex_usage_limit"
  | "codex_insufficient_balance"
  | "unknown";

export type ExecutorHealthFallback =
  | "use_direct_edit"
  | "enable_local_agent"
  | "run_gh_auth_login"
  | "enable_copilot_coding_agent"
  | "fix_codex_api_balance_or_base_url"
  | "update_github_cli"
  | "install_github_cli"
  | "authenticate_codex"
  | "inspect_executor_configuration";

export interface ExecutorHealth {
  agent: ControllerAgent;
  status: ExecutorHealthStatus;
  reason: ExecutorHealthReason;
  message: string;
  remediation: string;
  fallback: ExecutorHealthFallback;
}

export interface LocalExecutorPolicy {
  agentRunner: boolean;
  allowedAgents: McpAgentRunnerName[];
}

export class ExecutorHealthError extends Error {
  code: string;
  executorHealth: ExecutorHealth;

  constructor(code: string, executorHealth: ExecutorHealth) {
    super(executorHealth.message);
    this.name = "ExecutorHealthError";
    this.code = code;
    this.executorHealth = executorHealth;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isSmallScopedTask(task: Pick<ControllerTask, "allowedPaths"> | undefined): boolean {
  return Array.isArray(task?.allowedPaths) && task.allowedPaths.length > 0 && task.allowedPaths.length <= 3;
}

function localUnavailableMessage(base: string, task?: Pick<ControllerTask, "allowedPaths">): string {
  if (!isSmallScopedTask(task)) return base;
  return `${base} Use begin_edit_session/apply_patch/run_check instead of retrying unavailable agents.`;
}

function localUnavailableFallback(task?: Pick<ControllerTask, "allowedPaths">): ExecutorHealthFallback {
  return isSmallScopedTask(task) ? "use_direct_edit" : "enable_local_agent";
}

export function executorHealthCode(health: ExecutorHealth): string {
  switch (health.reason) {
    case "local_dev_runner_disabled":
      return "DEV_RUNNER_DISABLED";
    case "local_agent_disabled":
      return "AGENT_DENIED";
    case "github_cli_unavailable":
      return "GITHUB_CLI_UNAVAILABLE";
    case "github_auth_required":
      return "GITHUB_AUTH_REQUIRED";
    case "github_cli_too_old":
      return "GITHUB_CLI_TOO_OLD";
    case "copilot_cca_disabled":
      return "GITHUB_CLOUD_NOT_ENABLED";
    case "codex_auth_required":
      return "CODEX_AUTH_REQUIRED";
    case "codex_usage_limit":
    case "codex_insufficient_balance":
      return "CODEX_QUOTA_OR_BALANCE";
    default:
      return "EXECUTOR_UNAVAILABLE";
  }
}

export function classifyLocalExecutorHealth(
  agent: Exclude<ControllerAgent, "github-copilot">,
  policy: LocalExecutorPolicy,
  task?: Pick<ControllerTask, "allowedPaths">,
): ExecutorHealth | null {
  if (!policy.agentRunner) {
    return {
      agent,
      status: "disabled",
      reason: "local_dev_runner_disabled",
      message: localUnavailableMessage(
        `Local ${agent} runs are disabled because the dev runner is not enabled.`,
        task,
      ),
      remediation: "Enable the controller dev runner before dispatching local Codex or Claude runs.",
      fallback: localUnavailableFallback(task),
    };
  }
  if (!policy.allowedAgents.includes(agent)) {
    return {
      agent,
      status: "disabled",
      reason: "local_agent_disabled",
      message: localUnavailableMessage(
        `Local agent is not enabled: ${agent}.`,
        task,
      ),
      remediation: `Enable ${agent} in the controller dev-runner allowedAgents list before retrying.`,
      fallback: localUnavailableFallback(task),
    };
  }
  return null;
}

export function classifyGitHubCopilotPreflight(
  status: GitHubStatus,
  task?: Pick<ControllerTask, "allowedPaths">,
): ExecutorHealth | null {
  if (!status.available) {
    return {
      agent: "github-copilot",
      status: "not_installed",
      reason: "github_cli_unavailable",
      message: "GitHub CLI (gh) is unavailable, so GitHub Copilot cloud sessions cannot start.",
      remediation: "Install GitHub CLI and ensure `gh --version` works in this repository environment.",
      fallback: isSmallScopedTask(task) ? "use_direct_edit" : "install_github_cli",
    };
  }
  if (!status.authenticated) {
    return {
      agent: "github-copilot",
      status: "auth_required",
      reason: "github_auth_required",
      message: "GitHub CLI authentication is required before starting GitHub Copilot cloud sessions.",
      remediation: "Run `gh auth login` and confirm the target repository is accessible.",
      fallback: "run_gh_auth_login",
    };
  }
  if (!status.agentTaskSupported) {
    return {
      agent: "github-copilot",
      status: "disabled",
      reason: "github_cli_too_old",
      message: "GitHub CLI is too old for GitHub Copilot cloud sessions.",
      remediation: "Upgrade GitHub CLI to a version that supports agent tasks.",
      fallback: "update_github_cli",
    };
  }
  return null;
}

export function classifyExecutorFailure(
  agent: ControllerAgent,
  message: string,
  task?: Pick<ControllerTask, "allowedPaths">,
): ExecutorHealth | null {
  const text = normalize(message);
  if (!text) return null;

  if (agent === "github-copilot") {
    if (
      text.includes("http 409")
      || text.includes("cca enabled")
      || text.includes("does not have cca enabled")
      || text.includes("copilot coding agent")
    ) {
      return {
        agent,
        status: "cloud_not_enabled",
        reason: "copilot_cca_disabled",
        message: "GitHub Copilot cloud agent is not enabled for this account or repository.",
        remediation: "Enable GitHub Copilot Coding Agent / CCA for the account and repository before retrying cloud sessions.",
        fallback: isSmallScopedTask(task) ? "use_direct_edit" : "enable_copilot_coding_agent",
      };
    }
    return null;
  }

  if (agent === "codex") {
    if (text.includes("insufficient_balance") || text.includes("insufficient account balance")) {
      return {
        agent,
        status: "quota_or_balance",
        reason: "codex_insufficient_balance",
        message: "Codex execution is unavailable because the configured API account has insufficient balance.",
        remediation: "Restore API balance or correct the Codex base URL/account configuration before retrying.",
        fallback: isSmallScopedTask(task) ? "use_direct_edit" : "fix_codex_api_balance_or_base_url",
      };
    }
    if (text.includes("usage limit")) {
      return {
        agent,
        status: "quota_or_balance",
        reason: "codex_usage_limit",
        message: "Codex execution is unavailable because the configured account has reached a usage limit.",
        remediation: "Raise or wait for the Codex usage limit, or correct the API account/base URL configuration before retrying.",
        fallback: isSmallScopedTask(task) ? "use_direct_edit" : "fix_codex_api_balance_or_base_url",
      };
    }
    if (
      text.includes("authorizationrequired")
      || text.includes("auth required")
      || text.includes("not authenticated")
      || text.includes("authentication required")
    ) {
      return {
        agent,
        status: "auth_required",
        reason: "codex_auth_required",
        message: "Codex execution is unavailable because authentication is required.",
        remediation: "Authenticate the Codex executor or correct the configured credentials/base URL before retrying.",
        fallback: isSmallScopedTask(task) ? "use_direct_edit" : "authenticate_codex",
      };
    }
  }

  return {
    agent,
    status: "unknown",
    reason: "unknown",
    message: `${agent} execution failed for an unclassified reason.`,
    remediation: "Inspect the bounded run error and executor configuration before retrying.",
    fallback: isSmallScopedTask(task) ? "use_direct_edit" : "inspect_executor_configuration",
  };
}

export function isExecutorHealthError(error: unknown): error is ExecutorHealthError {
  return error instanceof ExecutorHealthError;
}
