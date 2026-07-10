import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("public npm release contract", () => {
  test("uses the organization package identity without changing CLI names", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("@moretea-labs/repo-harness-controller");
    expect(pkg.version).toMatch(/^1\.4\.0-rc\.\d+$/);
    expect(pkg.author).toBe("Moretea Labs contributors");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true, tag: "next" });
    expect(pkg.bin).toEqual({
      "repo-harness": "bin/repo-harness.mjs",
      "repo-harness-hook": "bin/repo-harness-hook.mjs",
    });
    expect(pkg.scripts.prepublishOnly).toBe("bash scripts/check-npm-release.sh");
  });

  test("ships license, attribution, docs, and the lockfile", () => {
    const pkg = JSON.parse(read("package.json"));
    for (const path of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "README.en.md", "README.zh-CN.md", "docs/README.md", "docs/tutorials/", "docs/operations/"]) {
      expect(pkg.files).toContain(path);
    }
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("@modelcontextprotocol/sdk");
    expect(notices).toContain("playwright");
  });

  test("keeps RC publishing manual, OIDC-based, and next-only", () => {
    const workflow = read(".github/workflows/release-rc.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("PUBLISH_RC");
    expect(workflow).toContain("npm run check:release-readiness");
    expect(workflow).toContain("npm publish --tag next --access public --provenance");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
  });

  test("documents scoped installation while preserving command names", () => {
    for (const path of ["README.md", "README.en.md", "docs/tutorials/01-install-and-start.md", "docs/tutorials/01-install-and-start.zh-CN.md", "docs/operations/releasing.md", "docs/operations/releasing.zh-CN.md"]) {
      const content = read(path);
      expect(content).toContain("@moretea-labs/repo-harness-controller@next");
      expect(content).toContain("repo-harness");
    }
    expect(read("docs/operations/releasing.md")).toContain("repo-harness-hook");
    expect(read("docs/operations/releasing.zh-CN.md")).toContain("repo-harness-hook");
  });
});
