import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

describe("bundled Agent launcher", () => {
  test("dispatches accepted Runs inside the durable Worker without resolving source files", () => {
    const source = readFileSync(join(ROOT, "src/cli/agent-jobs/job-manager.ts"), "utf8");
    const start = source.indexOf("export function dispatchAcceptedTaskJob(");
    const end = source.indexOf("export function cancelAgentJob(", start);
    const dispatch = source.slice(start, end);

    expect(dispatch).toContain("startAcceptedTaskJob(repoRoot, runId)");
    expect(dispatch).not.toContain("job-manager.ts");
    expect(dispatch).not.toContain("spawn(process.execPath");
  });
});
