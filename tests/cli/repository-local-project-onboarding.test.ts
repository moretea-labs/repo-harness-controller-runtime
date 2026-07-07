import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { bootstrapLocalProject, diagnoseLatestLocalProjectSource } from '../../src/cli/repositories/local-project-onboarding';
import { getRepository, registerRepository } from '../../src/cli/repositories/registry';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

function createIosProject(root: string, name = 'App'): void {
  mkdirSync(join(root, `${name}.xcodeproj`), { recursive: true });
  mkdirSync(join(root, name), { recursive: true });
  mkdirSync(join(root, 'Widget'), { recursive: true });
  mkdirSync(join(root, 'Resources'), { recursive: true });
  writeFileSync(join(root, 'Package.swift'), '// swift package\n');
  writeFileSync(join(root, 'README.md'), '# Project\n');
  writeFileSync(join(root, 'build.sh'), '#!/usr/bin/env bash\nxcodebuild\n');
}

describe('local project onboarding', () => {
  test('diagnosis prefers a richer sibling source tree over a stale registered path without mutating either directory', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'repo-harness-local-diagnose-'));
    const controllerHome = join(workspace, 'controller-home');
    const staleRoot = join(workspace, 'TinyMoments');
    const richRoot = join(workspace, 'TinyMoments 1.7');
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(staleRoot, { recursive: true });
      git(staleRoot, ['init', '-q']);
      mkdirSync(join(staleRoot, '.ai', 'harness'), { recursive: true });
      const registered = registerRepository({ path: staleRoot, controllerHome, displayName: 'TinyMoments' });
      const canonicalStaleRoot = realpathSync(staleRoot);

      mkdirSync(richRoot, { recursive: true });
      createIosProject(richRoot, 'TinyMoments');
      writeFileSync(join(richRoot, 'RELEASE_LOGO_WIDGET_LINKS_V1_7.md'), '# V1.7\n');
      const canonicalRichRoot = realpathSync(richRoot);

      const diagnosis = diagnoseLatestLocalProjectSource({ repoId: registered.repoId, controllerHome });
      expect(diagnosis.noMutation).toBe(true);
      expect(diagnosis.recommendedPath).toBe(canonicalRichRoot);
      expect(diagnosis.candidates[0]?.path).toBe(canonicalRichRoot);
      expect(diagnosis.candidates.find((candidate) => candidate.path === canonicalStaleRoot)?.repoId).toBe(registered.repoId);
      expect(diagnosis.warnings.join('\n')).toContain('looks stale');
      expect(existsSync(join(richRoot, '.git'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('bootstrap can replace a stale registered path while preserving the repoId and checkout history', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'repo-harness-local-replace-'));
    const controllerHome = join(workspace, 'controller-home');
    const staleRoot = join(workspace, 'TinyMoments');
    const richRoot = join(workspace, 'TinyMoments 1.7');
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(staleRoot, { recursive: true });
      git(staleRoot, ['init', '-q']);
      writeFileSync(join(staleRoot, '.gitignore'), '.DS_Store\n');
      const registered = registerRepository({ path: staleRoot, controllerHome, displayName: 'TinyMoments' });
      const canonicalStaleRoot = realpathSync(staleRoot);

      mkdirSync(richRoot, { recursive: true });
      createIosProject(richRoot, 'TinyMoments');
      const canonicalRichRoot = realpathSync(richRoot);

      const bootstrap = bootstrapLocalProject({
        path: richRoot,
        controllerHome,
        displayName: 'TinyMoments',
        mode: 'replace_registration',
        replaceRegisteredRepoId: registered.repoId,
        confirmAuthorization: true,
      });

      expect(bootstrap.repository?.repoId).toBe(registered.repoId);
      expect(bootstrap.replacedRegistration?.previousCanonicalRoot).toBe(canonicalStaleRoot);
      expect(bootstrap.repository?.canonicalRoot).toBe(canonicalRichRoot);
      expect(bootstrap.repository?.checkouts.map((checkout) => checkout.canonicalRoot).sort()).toEqual([canonicalRichRoot, canonicalStaleRoot].sort());
      expect(getRepository(registered.repoId, controllerHome).canonicalRoot).toBe(canonicalRichRoot);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('bootstrap denies sensitive paths before any mutation', () => {
    const home = process.env.HOME;
    if (!home) return;
    expect(() => bootstrapLocalProject({
      path: home,
      confirmAuthorization: true,
    })).toThrow('LOCAL_PROJECT_PATH_DENIED');
  });

  test('bootstrap is idempotent for an existing non-Git project directory', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'repo-harness-local-idempotent-'));
    const controllerHome = join(workspace, 'controller-home');
    const projectRoot = join(workspace, 'PulseMetronomeApp');
    try {
      mkdirSync(controllerHome, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      createIosProject(projectRoot, 'PulseMetronome');
      const canonicalProjectRoot = realpathSync(projectRoot);

      const first = bootstrapLocalProject({
        path: projectRoot,
        controllerHome,
        displayName: 'PulseMetronomeApp',
        defaultBranch: 'main',
        confirmAuthorization: true,
      });
      const second = bootstrapLocalProject({
        path: projectRoot,
        controllerHome,
        displayName: 'PulseMetronomeApp',
        defaultBranch: 'main',
        confirmAuthorization: true,
      });

      expect(first.createdGit).toBe(true);
      expect(first.createdGitignore).toBe(true);
      expect(second.createdGit).toBe(false);
      expect(second.createdGitignore).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.repository?.repoId).toBe(first.repository?.repoId);
      expect(second.repository?.checkouts.filter((checkout) => checkout.canonicalRoot === canonicalProjectRoot)).toHaveLength(1);
      expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('DerivedData/');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
