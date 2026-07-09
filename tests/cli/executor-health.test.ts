import { describe, expect, test } from "bun:test";
import {
  classifyExecutorFailure,
  classifyGitHubCopilotPreflight,
  classifyLocalExecutorHealth,
} from "../../src/cli/agent-jobs/executor-health";

describe("executor health classifier", () => {
  test("classifies local agent disabled", () => {
    const health = classifyLocalExecutorHealth(
      "claude",
      { agentRunner: true, allowedAgents: ["codex"] },
      { allowedPaths: ["src/a.ts"] },
    );
    expect(health?.status).toBe("disabled");
    expect(health?.reason).toBe("local_agent_disabled");
    expect(health?.fallback).toBe("use_direct_edit");
  });

  test("classifies dev runner disabled", () => {
    const health = classifyLocalExecutorHealth(
      "codex",
      { agentRunner: false, allowedAgents: ["codex"] },
      { allowedPaths: ["src/a.ts"] },
    );
    expect(health?.status).toBe("disabled");
    expect(health?.reason).toBe("local_dev_runner_disabled");
    expect(health?.fallback).toBe("use_direct_edit");
    expect(health?.message).toContain("begin_edit_session/apply_patch/run_check");
  });

  test("classifies GitHub Copilot CCA disabled failures", () => {
    const health = classifyExecutorFailure(
      "github-copilot",
      "gh: user or repo does not have CCA enabled (HTTP 409) Copilot Coding Agent",
      { allowedPaths: ["src/a.ts"] },
    );
    expect(health?.status).toBe("cloud_not_enabled");
    expect(health?.reason).toBe("copilot_cca_disabled");
  });

  test("classifies Codex insufficient balance failures", () => {
    const health = classifyExecutorFailure(
      "codex",
      'unexpected status 403 Forbidden {"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}',
      { allowedPaths: ["src/a.ts"] },
    );
    expect(health?.status).toBe("quota_or_balance");
    expect(health?.reason).toBe("codex_insufficient_balance");
  });

  test("classifies Codex AuthorizationRequired failures", () => {
    const health = classifyExecutorFailure(
      "codex",
      "Auth(AuthorizationRequired): not authenticated",
      { allowedPaths: ["src/a.ts"] },
    );
    expect(health?.status).toBe("auth_required");
    expect(health?.reason).toBe("codex_auth_required");
  });

  test("classifies GitHub preflight auth and CLI readiness", () => {
    const authRequired = classifyGitHubCopilotPreflight({
      available: true,
      authenticated: false,
      version: "gh version 2.80.0",
      agentTaskSupported: true,
      errors: ["not authenticated"],
    });
    expect(authRequired?.reason).toBe("github_auth_required");

    const unavailable = classifyGitHubCopilotPreflight({
      available: false,
      authenticated: false,
      agentTaskSupported: false,
      errors: ["missing gh"],
    });
    expect(unavailable?.reason).toBe("github_cli_unavailable");
  });
});
