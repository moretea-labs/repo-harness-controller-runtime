import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");

describe("init-project settings runtime", () => {
  test("create_structure should keep hook adapters user-level", () => {
    const cwd = mkdtempSync(join(tmpdir(), "init-project-settings-"));
    try {
      const res = spawnSync(
        "/bin/bash",
        [
          "-lc",
          `
            export REPO_HARNESS_SOURCE_ONLY=1
            source "${join(ROOT, "scripts/init-project.sh")}" demo vite-tanstack bun >/dev/null
            create_structure
          `,
        ],
        {
          cwd,
          encoding: "utf-8",
        }
      );

      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Host hook adapters are user-level:");
      expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(false);
      expect(existsSync(join(cwd, ".codex/hooks.json"))).toBe(false);
      expect(existsSync(join(cwd, ".ai/hooks/README.md"))).toBe(true);
      expect(existsSync(join(cwd, ".ai/hooks/lib/workflow-state.sh"))).toBe(true);
      expect(existsSync(join(cwd, ".ai/hooks/lib/session-state.sh"))).toBe(true);
      expect(existsSync(join(cwd, ".ai/hooks/run-hook.sh"))).toBe(false);
      expect(existsSync(join(cwd, ".ai/hooks/session-start-context.sh"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);
});
