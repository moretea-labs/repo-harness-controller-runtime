#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function text(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    failures.push(`missing ${path}`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function requireText(path, value) {
  if (!text(path).includes(value)) failures.push(`${path} must contain ${JSON.stringify(value)}`);
}

const pkg = JSON.parse(text("package.json") || "{}");
if (pkg.engines?.node !== ">=20.10.0") failures.push("package.json engines.node must be >=20.10.0");
if (!pkg.engines?.bun) failures.push("package.json must document the supported Bun runtime");
if (!pkg.scripts?.["check:platform-support"]) failures.push("package.json is missing check:platform-support");

requireText("bin/repo-harness.mjs", "#!/usr/bin/env node");
for (const path of ["install.sh", "install.ps1"]) {
  requireText(path, "REPO_HARNESS_INSTALL_RUNTIME");
  requireText(path, "Node.js 20.10");
  requireText(path, "Git is required");
  requireText(path, "repo-harness install --no-cli");
}
requireText("install.sh", "npm install -g");
requireText("install.ps1", "npm install -g");
requireText("docs/operations/platform-support.md", "Native Windows");
requireText("docs/operations/platform-support.md", "WSL2");
requireText("docs/operations/features.md", "Core features");
requireText("docs/tutorials/01-install-and-start.md", "Node.js 20.10");
requireText("docs/tutorials/01-install-and-start.zh-CN.md", "Node.js 20.10");
requireText(".github/workflows/windows-smoke.yml", "windows-latest");
requireText(".github/workflows/windows-smoke.yml", "-DryRun");

const publicDocs = [
  "README.md",
  "README.en.md",
  "README.zh-CN.md",
  "README.es.md",
  "README.fr.md",
  "README.ja.md",
  "docs/public-usage-guide.md",
  "docs/public-usage-guide.zh-CN.md",
];
for (const path of publicDocs) {
  const content = text(path);
  if (content.includes("github.com/greysonOuyang/")) failures.push(`${path} contains the retired personal repository URL`);
}

if (failures.length > 0) {
  console.error("[platform-support] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("[platform-support] OK");
