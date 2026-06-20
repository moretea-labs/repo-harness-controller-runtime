import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const SHIM = join(ROOT, "scripts/hook-shim.sh");
const CLI = join(ROOT, "scripts/repo-harness.sh");
const REAL_RUN_HOOK = join(ROOT, "assets/hooks/run-hook.sh");

let sandbox: string;
let harnessHome: string;
let fakeHome: string;
let repo: string;
let centralDir: string;

function git(args: string[], cwd: string) {
  return spawnSync("git", args, { cwd, encoding: "utf-8" });
}

function runShim(hook: string, cwd: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [SHIM, hook], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, REPO_HARNESS_HOME: harnessHome, ...extraEnv },
  });
}

function writeEchoRunHook(dir: string, label: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run-hook.sh"), `#!/bin/bash\necho "RAN-${label} $1"\n`);
}

function writePolicy(content: string | null) {
  const policyPath = join(repo, ".ai/harness/policy.json");
  if (content === null) {
    rmSync(policyPath, { force: true });
  } else {
    writeFileSync(policyPath, content);
  }
}

beforeAll(() => {
  // realpath: the shim canonicalizes repo roots (pwd -P), so trust entries and
  // path assertions must use the resolved /private/var form on macOS.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hook-shim-resolution-")));
  harnessHome = join(sandbox, "rh-home");
  fakeHome = join(sandbox, "fake-home");
  repo = join(sandbox, "fake-repo");
  centralDir = join(harnessHome, "hooks");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(join(repo, ".ai/harness"), { recursive: true });
  writeFileSync(join(repo, ".ai/harness/workflow-contract.json"), "{}\n");
  writeEchoRunHook(join(repo, ".ai/hooks"), "REPO");
  git(["init", "-q"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], repo);
  mkdirSync(harnessHome, { recursive: true });
  writeFileSync(join(harnessHome, "trusted-repos"), `${repo}\n`);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(centralDir, { recursive: true, force: true });
  writePolicy(null);
});

describe("hook-shim runtime resolution", () => {
  test("falls back to the repo-local copy when no central bundle exists", () => {
    const res = runShim("post-bash.sh", repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("RAN-REPO post-bash.sh");
  });

  test("prefers the central bundle over the vendored repo copy", () => {
    writeEchoRunHook(centralDir, "CENTRAL");
    const res = runShim("post-bash.sh", repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("RAN-CENTRAL post-bash.sh");
    expect(res.stdout).not.toContain("RAN-REPO");
  });

  test('policy pin "hook_source": "repo" keeps the vendored copy active', () => {
    writeEchoRunHook(centralDir, "CENTRAL");
    writePolicy('{\n  "hook_source": "repo"\n}\n');
    const res = runShim("post-bash.sh", repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("RAN-REPO post-bash.sh");
  });

  test("policy without the pin still resolves central", () => {
    writeEchoRunHook(centralDir, "CENTRAL");
    writePolicy('{\n  "hook_source": "central"\n}\n');
    const res = runShim("post-bash.sh", repo);
    expect(res.stdout).toContain("RAN-CENTRAL post-bash.sh");
  });

  test("REPO_HARNESS_HOOK_SOURCE env overrides the policy pin", () => {
    writeEchoRunHook(centralDir, "CENTRAL");
    writePolicy('{\n  "hook_source": "repo"\n}\n');
    const central = runShim("post-bash.sh", repo, { REPO_HARNESS_HOOK_SOURCE: "central" });
    expect(central.stdout).toContain("RAN-CENTRAL post-bash.sh");

    const asRepo = runShim("post-bash.sh", repo, { REPO_HARNESS_HOOK_SOURCE: "repo" });
    expect(asRepo.stdout).toContain("RAN-REPO post-bash.sh");

    const custom = join(sandbox, "custom-hooks");
    writeEchoRunHook(custom, "CUSTOM");
    const viaDir = runShim("post-bash.sh", repo, { REPO_HARNESS_HOOK_SOURCE: custom });
    expect(viaDir.stdout).toContain("RAN-CUSTOM post-bash.sh");
  });

  test("a repo without vendored .ai/hooks still runs via the central bundle", () => {
    const bare = join(sandbox, "bare-repo");
    mkdirSync(join(bare, ".ai/harness"), { recursive: true });
    writeFileSync(join(bare, ".ai/harness/workflow-contract.json"), "{}\n");
    git(["init", "-q"], bare);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], bare);
    writeFileSync(join(harnessHome, "trusted-repos"), `${repo}\n${bare}\n`);

    const before = runShim("post-bash.sh", bare);
    expect(before.status).toBe(0);
    expect(before.stdout).toBe("");

    writeEchoRunHook(centralDir, "CENTRAL");
    const after = runShim("post-bash.sh", bare);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain("RAN-CENTRAL post-bash.sh");
  });

  test("the real dispatcher works from the central dir: cwd and HOOK_REPO_ROOT point at the repo", () => {
    mkdirSync(centralDir, { recursive: true });
    copyFileSync(REAL_RUN_HOOK, join(centralDir, "run-hook.sh"));
    writeFileSync(
      join(centralDir, "probe-hook.sh"),
      '#!/bin/bash\necho "PWD=$(pwd) ROOT=$HOOK_REPO_ROOT"\n',
    );
    const res = runShim("probe-hook.sh", repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`ROOT=${repo}`);
    expect(res.stdout).toContain(`PWD=${repo}`);
  });

  test("install creates the central bundle with dispatcher, libs, and version stamp", () => {
    const res = spawnSync("bash", [CLI, "install", "--target", "claude"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { ...process.env, REPO_HARNESS_HOME: harnessHome, HOME: fakeHome },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Central hooks bundle installed");
    expect(existsSync(join(centralDir, "run-hook.sh"))).toBe(true);
    expect(existsSync(join(centralDir, "prompt-guard.sh"))).toBe(true);
    expect(existsSync(join(centralDir, "hook-input.sh"))).toBe(true);
    expect(existsSync(join(centralDir, "lib/workflow-state.sh"))).toBe(true);
    expect(existsSync(join(centralDir, "codex.hooks.template.json"))).toBe(false);

    const version = readFileSync(join(centralDir, ".version"), "utf-8").trim();
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string };
    expect(version).toBe(pkg.version);

    // Stale files from a previous bundle are removed on reinstall.
    writeFileSync(join(centralDir, "dead-hook.sh"), "#!/bin/bash\n");
    const again = spawnSync("bash", [CLI, "install", "--target", "claude"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { ...process.env, REPO_HARNESS_HOME: harnessHome, HOME: fakeHome },
    });
    expect(again.status).toBe(0);
    expect(existsSync(join(centralDir, "dead-hook.sh"))).toBe(false);
  });
});
