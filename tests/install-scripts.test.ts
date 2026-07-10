import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("install script contracts", () => {
  test("macOS/Linux installer validates the launcher prerequisites and supports Bun or npm", () => {
    const script = read("install.sh");
    const syntax = spawnSync("bash", ["-n", "install.sh"], {
      cwd: ROOT,
      encoding: "utf-8",
    });

    if (process.platform !== "win32") expect(syntax.status).toBe(0);
    expect(script).toContain("REPO_HARNESS_VERSION");
    expect(script).toContain("REPO_HARNESS_INSTALL_RUNTIME");
    expect(script).toContain("Node.js 20.10 or newer");
    expect(script).toContain("Git is required");
    expect(script).toContain("https://bun.sh/install");
    expect(script).toContain('bun add -g "$package_spec"');
    expect(script).toContain('npm install -g "$package_spec"');
    expect(script).toContain("repo-harness doctor --help");
    expect(script).toContain("repo-harness install --no-cli");
  });

  test("Windows installer validates PowerShell, Git, Node and supports Bun or npm", () => {
    const script = read("install.ps1");

    expect(script).toContain("REPO_HARNESS_VERSION");
    expect(script).toContain("REPO_HARNESS_INSTALL_RUNTIME");
    expect(script).toContain("[switch]$DryRun");
    expect(script).toContain('[ValidateSet("auto", "bun", "node")]');
    expect(script).toContain('[version]"20.10.0"');
    expect(script).toContain("Git is required");
    expect(script).toContain("https://bun.sh/install.ps1");
    expect(script).toContain("& bun add -g $PackageSpec");
    expect(script).toContain("& npm install -g $PackageSpec");
    expect(script).toContain("repo-harness doctor --help");
    expect(script).toContain("repo-harness install --no-cli");
  });

  test("public onboarding points at the canonical repository and platform guide", () => {
    const readme = read("README.md");
    const englishReadme = read("README.en.md");
    const installGuide = read("docs/tutorials/01-install-and-start.md");
    const platformGuide = read("docs/operations/platform-support.md");
    const pkg = JSON.parse(read("package.json"));

    for (const document of [readme, englishReadme, installGuide]) {
      expect(document).toContain("moretea-labs/repo-harness-controller-runtime");
    }
    expect(platformGuide).toContain("Native Windows");
    expect(platformGuide).toContain("WSL2");
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toContain("install.sh");
    expect(pkg.files).toContain("install.ps1");
    expect(pkg.scripts["check:platform-support"]).toBeDefined();
  });
});
