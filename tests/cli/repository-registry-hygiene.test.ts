import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { registerRepository } from "../../src/cli/repositories/registry";

const roots: string[] = [];

function initGit(root: string): void {
  mkdirSync(root, { recursive: true });
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository registry hygiene", () => {
  test("allows isolated test registries whose controller home is also temporary", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "repo-harness-registry-test-"));
    roots.push(sandbox);
    const repo = join(sandbox, "repo");
    const home = join(sandbox, "controller-home");
    initGit(repo);
    expect(registerRepository({ path: repo, controllerHome: home }).canonicalRoot).toBe(realpathSync(repo));
  });

  test("rejects OS temporary repositories for a persistent controller home", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "repo-harness-registry-source-"));
    roots.push(sandbox);
    const repo = join(sandbox, "repo");
    initGit(repo);
    const persistentHome = join(process.cwd(), ".tmp-registry-hygiene-controller-home");
    roots.push(persistentHome);
    expect(() => registerRepository({ path: repo, controllerHome: persistentHome })).toThrow("REPOSITORY_EPHEMERAL_PATH_DENIED");
  });

  test("rejects controller-managed worktrees as standalone repository registrations", () => {
    const home = join(process.cwd(), ".tmp-registry-managed-home");
    roots.push(home);
    const worktree = join(home, "repositories", "repo-a", "worktrees", "campaign-a");
    initGit(worktree);
    expect(() => registerRepository({ path: worktree, controllerHome: home })).toThrow("REPOSITORY_MANAGED_WORKTREE_DENIED");
  });
});
