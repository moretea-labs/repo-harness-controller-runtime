#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const notices = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8").replace(/\r\n/g, "\n");

const fallbackLicenses = new Map([
  ["commander@14.0.3", "MIT"],
  ["express@5.2.1", "MIT"],
  ["playwright@1.61.1", "Apache-2.0"],
  ["typescript@6.0.3", "Apache-2.0"],
]);

function fail(message) {
  console.error(`[third-party-notices] ERROR: ${message}`);
  process.exit(1);
}

function validate(name, role) {
  const meta = lock.packages?.[`node_modules/${name}`];
  if (!meta?.version) fail(`package-lock entry missing for ${name}`);
  const license = meta.license ?? fallbackLicenses.get(`${name}@${meta.version}`);
  if (!license) fail(`license metadata missing for ${name}@${meta.version}`);
  const row = `| \`${name}\` | \`${meta.version}\` | ${role} | \`${license}\` |`;
  if (!notices.includes(row)) fail(`THIRD_PARTY_NOTICES.md missing or stale for ${name}@${meta.version}`);
}

for (const name of Object.keys(pkg.dependencies ?? {})) validate(name, "runtime");
for (const name of Object.keys(pkg.devDependencies ?? {})) validate(name, "development");
if (!notices.includes(`\`${pkg.name}@${pkg.version}\``)) fail("notice package identity is stale");

console.log(`[third-party-notices] OK: ${Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length} direct dependencies inventoried`);
