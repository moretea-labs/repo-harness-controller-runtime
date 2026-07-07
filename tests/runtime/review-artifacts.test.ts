import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { registerRepository } from '../../src/cli/repositories/registry';
import { buildReviewArtifactIndex, ensureReviewArtifactRoots, prepareBrowserReviewPacket, prepareIosReviewPacket } from '../../src/runtime/safe-tooling';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.REPO_HARNESS_CONTROLLER_HOME;
});

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-review-artifacts-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-review-artifacts-controller-'));
  roots.push(repoRoot, controllerHome);
  process.env.REPO_HARNESS_CONTROLLER_HOME = controllerHome;
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  return registerRepository({ path: repoRoot, controllerHome });
}

describe('review artifacts', () => {
  it('creates bounded artifact roots and indexes browser/iOS review files', () => {
    const repository = fixture();
    const prepared = ensureReviewArtifactRoots(repository);
    expect(prepared.roots).toContain('.repo-harness/browser/screenshots');
    mkdirSync(join(repository.canonicalRoot, '.repo-harness/browser/screenshots'), { recursive: true });
    mkdirSync(join(repository.canonicalRoot, '.repo-harness/ios/screenshots'), { recursive: true });
    writeFileSync(join(repository.canonicalRoot, '.repo-harness/browser/screenshots/home.png'), 'png');
    writeFileSync(join(repository.canonicalRoot, '.repo-harness/ios/screenshots/home.png'), 'png');

    const index = buildReviewArtifactIndex(repository);
    expect(index.artifacts.map((artifact) => artifact.path)).toContain('.repo-harness/browser/screenshots/home.png');
    expect(prepareBrowserReviewPacket(repository).ready).toBe(true);
    expect(prepareIosReviewPacket(repository).artifacts.some((artifact) => artifact.kind === 'ios_screenshot')).toBe(true);
  });
});
