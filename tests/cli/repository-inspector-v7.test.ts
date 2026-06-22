import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { globMatches } from "../../src/cli/mcp/paths";
import { getMcpPolicy } from "../../src/cli/mcp/policy";
import { readRepositoryRange, searchRepository } from "../../src/cli/repository/inspector";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository glob and read policy v7", () => {
  test("globstar matches root files and nested files consistently", () => {
    expect(globMatches("**/*.ts", "root.ts")).toBe(true);
    expect(globMatches("**/*.ts", "src/nested/value.ts")).toBe(true);
    expect(globMatches("src/{a,b}.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/file?.ts", "src/file1.ts")).toBe(true);
    expect(globMatches("src/file?.ts", "src/file10.ts")).toBe(false);
  });

  test("targeted search and direct read share the same MCP path authority", () => {
    const root = mkdtempSync(join(tmpdir(), "repo-harness-search-v7-"));
    roots.push(root);
    mkdirSync(join(root, ".ai/harness/jobs/RUN-X"), { recursive: true });
    writeFileSync(join(root, ".ai/harness/jobs/RUN-X/stdout.log"), "needle from targeted evidence\n");
    const policy = getMcpPolicy("controller", { repoRoot: root });
    policy.readGlobs.push(".ai/harness/jobs/**");
    policy.denyGlobs = policy.denyGlobs.filter((entry) => entry !== ".ai/harness/jobs/**");

    const search = searchRepository(root, policy, {
      query: "targeted evidence",
      includeGlobs: [".ai/harness/jobs/**/*.log"],
    });
    expect(search.results.map((entry) => entry.path)).toContain(".ai/harness/jobs/RUN-X/stdout.log");
    const read = readRepositoryRange(root, policy, ".ai/harness/jobs/RUN-X/stdout.log", 1, 1);
    expect(read.content).toContain("targeted evidence");
  });
});
