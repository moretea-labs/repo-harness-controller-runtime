import { describe, expect, test } from "bun:test";
import { classifyRepositoryCommand } from "../../src/cli/repositories/command-executor";

describe("repository git command classification", () => {
  test("ordinary git write commands require authorization instead of strong confirmation", () => {
    expect(classifyRepositoryCommand("git fetch origin --prune")).toMatchObject({
      risk: "workspace_write",
      confirmation: "authorization",
    });

    expect(classifyRepositoryCommand("git cherry-pick 167d05726438d803ce7a2b230b64bb4086c877d3")).toMatchObject({
      risk: "workspace_write",
      confirmation: "authorization",
    });
  });

  test("read-only git commands stay confirmation-free", () => {
    expect(classifyRepositoryCommand("git branch --show-current")).toMatchObject({
      risk: "readonly",
      confirmation: "none",
    });
  });

  test("quoted metacharacters and process inspection remain read-only", () => {
    const commands = [
      'rg -n "LOCK_HELD|cancel_task_run|cancellation" src tests | head -200',
      "sed -n '1,700p' src/cli/editing/edit-session.ts",
      "ps -axo pid=,ppid=,command= | grep repo-harness | grep -v grep || true",
      'rg -n ">" src',
      "pgrep -af repo-harness || true",
    ];

    for (const command of commands) {
      expect(classifyRepositoryCommand(command)).toMatchObject({
        risk: "readonly",
        confirmation: "none",
      });
    }
  });

  test("real output redirection and sed in-place editing remain writes", () => {
    expect(classifyRepositoryCommand("printf 'ok' > report.txt")).toMatchObject({
      risk: "workspace_write",
      confirmation: "authorization",
    });
    expect(classifyRepositoryCommand("sed -i '' 's/old/new/' README.md")).toMatchObject({
      risk: "workspace_write",
      confirmation: "authorization",
    });
    expect(classifyRepositoryCommand("git status --short 2>/dev/null")).toMatchObject({
      risk: "readonly",
      confirmation: "none",
    });
  });

  test("truly destructive git commands require strong confirmation", () => {
    expect(classifyRepositoryCommand("git reset --hard HEAD")).toMatchObject({
      risk: "destructive",
      confirmation: "strong_confirmation",
    });

    expect(classifyRepositoryCommand("git clean -fdx")).toMatchObject({
      risk: "destructive",
      confirmation: "strong_confirmation",
    });
  });
});
