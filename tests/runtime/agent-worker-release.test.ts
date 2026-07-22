import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

describe("Agent worker release ownership", () => {
  test("bundles the Agent worker and binds launches to the stable Daemon", () => {
    const installer = readFileSync(join(ROOT, "src/runtime/supervisor/installer.ts"), "utf8");
    const manager = readFileSync(join(ROOT, "src/cli/agent-jobs/job-manager.ts"), "utf8");

    expect(installer).toContain("'src/cli/agent-jobs/job-worker.ts', join(releasePath, 'agent-worker.js')");
    expect(installer).toContain("'agent-worker.js'");
    expect(manager).toContain('join(controllerHome, "daemon", "controller.pid")');
    expect(manager).toContain('join(dirname(process.argv[1] ?? ""), "agent-worker.js")');
    expect(manager).toContain("detached: true");
    expect(manager).not.toContain("parentPid: process.pid");
  });
});
