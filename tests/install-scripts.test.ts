import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("install script contracts", () => {
  test("macOS/Linux installer is syntax-valid and Bun-owned", () => {
    const script = read("install.sh");
    const syntax = spawnSync("bash", ["-n", "install.sh"], {
      cwd: ROOT,
      encoding: "utf-8",
    });

    expect(syntax.status).toBe(0);
    expect(script).toContain("REPO_HARNESS_VERSION");
    expect(script).toContain("https://bun.sh/install");
    expect(script).toContain("bun add -g \"$package_spec\"");
    expect(script).toContain("repo-harness --version");
    expect(script).not.toMatch(/\bnpm\b/);
    expect(script).not.toMatch(/\bnpx\b/);
    expect(script).not.toMatch(/\bnode\b/);
  });

  test("Windows installer is Bun-owned and version-pinnable", () => {
    const script = read("install.ps1");

    expect(script).toContain("REPO_HARNESS_VERSION");
    expect(script).toContain("https://bun.sh/install.ps1");
    expect(script).toContain("& bun add -g $PackageSpec");
    expect(script).toContain("repo-harness --version");
    expect(script).not.toMatch(/\bnpm\b/i);
    expect(script).not.toMatch(/\bnpx\b/i);
    expect(script).not.toMatch(/\bnode\b/i);
  });

  test("README documents source checkout and Bun package installation", () => {
    const readme = read("README.md");
    const zhReadme = read("README.zh-CN.md");
    const usageGuide = read("docs/public-usage-guide.md");
    const zhUsageGuide = read("docs/public-usage-guide.zh-CN.md");
    const pkg = JSON.parse(read("package.json"));

    for (const document of [readme, zhReadme, usageGuide, zhUsageGuide]) {
      expect(document).toContain("git clone https://github.com/greysonOuyang/repo-harness-controller-runtime.git");
      expect(document).toContain("bun add -g repo-harness");
    }
    expect(readme).toContain("docs/public-usage-guide.md");
    expect(zhReadme).toContain("docs/public-usage-guide.zh-CN.md");
    expect(readme).not.toContain("npm install -g repo-harness");
    expect(pkg.files).toContain("install.sh");
    expect(pkg.files).toContain("install.ps1");
  });
});
