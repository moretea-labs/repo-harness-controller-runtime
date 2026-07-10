#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const skill = JSON.parse(readFileSync(resolve(root, "assets/skill-version.json"), "utf8"));

const expectedName = "@moretea-labs/repo-harness-controller";
const requiredFiles = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.en.md",
  "README.zh-CN.md",
  "docs/README.md",
  "docs/tutorials/",
  "docs/operations/",
];

function fail(message) {
  console.error(`[package-identity] ERROR: ${message}`);
  process.exit(1);
}

if (pkg.name !== expectedName) fail(`package.json name is ${pkg.name}`);
const versionMatch = String(pkg.version ?? "").match(/^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/);
if (!versionMatch) fail(`package.json version is not a stable or rc semantic version: ${pkg.version}`);
const coreVersion = versionMatch[1];
const isReleaseCandidate = versionMatch[2] !== undefined;
if (coreVersion !== skill.version || coreVersion !== skill.templateVersion) {
  fail(`package core version ${coreVersion} must match workflow versions ${skill.version}/${skill.templateVersion}`);
}
if (pkg.publishConfig?.access !== "public") fail("publishConfig.access must be public");
if (pkg.publishConfig?.provenance !== true) fail("publishConfig.provenance must be true");
const expectedTag = isReleaseCandidate ? "next" : "latest";
if (pkg.publishConfig?.tag !== expectedTag) fail(`publishConfig.tag must be ${expectedTag}`);
if (pkg.private !== undefined) fail("package must not declare private");
if (pkg.author !== "Moretea Labs contributors") fail(`unexpected package author: ${pkg.author}`);
if (!String(pkg.repository?.url ?? "").includes("moretea-labs/repo-harness-controller-runtime")) {
  fail("repository URL must target the organization repository");
}

const bin = pkg.bin ?? {};
if (bin["repo-harness"] !== "bin/repo-harness.mjs") fail("repo-harness bin mapping changed");
if (bin["repo-harness-hook"] !== "bin/repo-harness-hook.mjs") fail("repo-harness-hook bin mapping changed");
if (pkg.scripts?.prepublishOnly !== "bash scripts/check-npm-release.sh") fail("prepublishOnly gate changed");
if (pkg.scripts?.["release:rc"] !== "npm publish --tag next --access public --provenance") fail("release:rc script changed");

const files = new Set(pkg.files ?? []);
for (const required of requiredFiles) {
  if (!files.has(required)) fail(`package files missing ${required}`);
}

if (lock.name !== pkg.name || lock.version !== pkg.version) fail("package-lock root identity differs from package.json");
if (lock.packages?.[""]?.name !== pkg.name || lock.packages?.[""]?.version !== pkg.version) {
  fail("package-lock root package identity differs from package.json");
}

console.log(`[package-identity] OK: ${pkg.name}@${pkg.version}`);
