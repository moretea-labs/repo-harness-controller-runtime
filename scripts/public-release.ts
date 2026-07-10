#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = process.env.REPO_HARNESS_PUBLIC_MANIFEST
  ? resolve(process.env.REPO_HARNESS_PUBLIC_MANIFEST)
  : join(root, "scripts/public-release-files.txt");

function fail(message: string): never {
  throw new Error(`public export: ${message}`);
}

function inside(base: string, candidate: string): boolean {
  const value = relative(base, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function normalized(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function forbidden(path: string): boolean {
  const value = normalized(path);
  const roots = [
    ".git",
    ".ai",
    ".claude",
    ".codex",
    ".repo-harness",
    "tasks",
    "coverage",
    "artifacts",
    "autoresearch",
    "docs/researches",
  ];
  return (
    roots.some((entry) => value === entry || value.startsWith(`${entry}/`)) ||
    /^docs\/repo-harness-.*-file-manifest\.sha256$/.test(value) ||
    /\.(?:log|tgz|tar\.gz|pem|key)$/.test(value)
  );
}

function manifestEntries(): string[] {
  if (!existsSync(manifest)) fail(`manifest not found: ${manifest}`);
  return readFileSync(manifest, "utf-8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((entry) => {
      if (isAbsolute(entry)) fail(`absolute manifest entry is forbidden: ${entry}`);
      if (entry.split("/").includes("..")) fail(`parent traversal is forbidden: ${entry}`);
      return entry;
    });
}

function selectedFiles(): string[] {
  const files = new Set<string>();
  for (const entry of manifestEntries()) {
    const result = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", entry],
      { cwd: root, encoding: "utf-8" },
    );
    if (result.status !== 0) fail(`git ls-files failed for ${entry}: ${result.stderr.trim()}`);
    for (const line of result.stdout.split("\n")) {
      const file = normalized(line.trim());
      if (file) files.add(file);
    }
  }
  const result = [...files].sort();
  if (result.length === 0) fail("manifest selected no files");
  return result;
}

function copyFiles(output: string, files: string[]): void {
  for (const file of files) {
    if (forbidden(file)) fail(`forbidden file selected: ${file}`);
    const source = join(root, file);
    if (!existsSync(source)) fail(`selected file disappeared: ${file}`);
    const stat = lstatSync(source);
    if (stat.isDirectory()) continue;
    if (stat.isSymbolicLink()) {
      const target = realpathSync(source);
      if (!inside(root, target)) fail(`symlink escapes repository: ${file} -> ${target}`);
    } else if (!stat.isFile()) {
      fail(`unsupported file type selected: ${file}`);
    }
    const target = join(output, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function walk(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile()) result.push(path);
    else fail(`non-regular file in export: ${path}`);
  }
  return result;
}

function scan(output: string): void {
  for (const required of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "README.md", "README.en.md", "src", "scripts"]) {
    if (!existsSync(join(output, required))) fail(`required public file missing: ${required}`);
  }
  for (const blocked of [".git", ".ai", ".claude", ".codex", ".repo-harness", "tasks", "coverage", "artifacts", "autoresearch"]) {
    if (existsSync(join(output, blocked))) fail(`runtime/internal path leaked: ${blocked}`);
  }

  const ignoredScanners = new Set([
    "scripts/public-release.ts",
    "scripts/check-public-export.sh",
    "scripts/check-open-source-tracked-surface.sh",
  ]);
  const patterns: Array<[string, RegExp]> = [
    ["macOS personal path detected", /(?<![A-Za-z0-9._-])\/Users\/[^/\s"'`]+/],
    ["Linux personal path detected", /(?<![A-Za-z0-9._-])\/home\/[^/\s"'`]+/],
    ["private key detected", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["AWS access key detected", /AKIA[0-9A-Z]{16}/],
    ["GitHub token detected", /gh[pousr]_[A-Za-z0-9_]{20,}/],
    ["OpenAI-style secret detected", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/],
    ["real repository binding detected", /repo_[0-9a-f]{24,}/],
    ["real checkout binding detected", /checkout_[0-9a-f]{16,}/],
  ];

  for (const path of walk(output)) {
    const rel = normalized(relative(output, path));
    if (forbidden(rel)) fail(`runtime, key, or package snapshot file detected: ${rel}`);
    if (ignoredScanners.has(rel) || basename(rel).endsWith(".svg")) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf-8");
    for (const [label, pattern] of patterns) {
      if (pattern.test(text)) fail(`${label}: ${rel}`);
    }
  }
}

const requestedOutput = process.argv[2];
const output = requestedOutput
  ? resolve(requestedOutput)
  : mkdtempSync(join(tmpdir(), "repo-harness-public-"));
if (requestedOutput) {
  if (existsSync(output)) fail(`output already exists: ${output}`);
  mkdirSync(output, { recursive: true });
}
if (output === root || inside(output, root)) fail("output must not replace or contain the source repository");

const files = selectedFiles();
copyFiles(output, files);
scan(output);
console.log(`public export ready: ${output} (${files.length} files)`);
