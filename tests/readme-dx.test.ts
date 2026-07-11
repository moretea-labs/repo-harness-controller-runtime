import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const PUBLIC_READMES = ["README.md", "README.zh-CN.md"];
const PUBLIC_GUIDES = ["docs/public-usage-guide.md", "docs/public-usage-guide.zh-CN.md"];
const RUNTIME_SCAN_FILES = [
  "SKILL.md",
  ...PUBLIC_READMES,
  ...PUBLIC_GUIDES,
  "docs/reference-configs/external-tooling.md",
];
const RUNTIME_RED_FLAGS = [
  /在 Claude Code/,
  /Claude Code skill/,
  /Claude Code 用户/,
  /Cursor only/,
  /Codex 中/,
  /^\[!\[Claude Code/,
  /~\/\.claude\/skills\/[a-z]/,
  /\/plugin install\b/,
];

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

function isAllowedRuntimeReference(file: string, line: string): boolean {
  if (/Claude skill alias/.test(line)) return true;
  if (file === "docs/reference-configs/external-tooling.md" && /~\/\.claude\/skills\/gstack/.test(line)) {
    return true;
  }
  return false;
}

describe("public README and documentation contract", () => {
  test("uses the current English, Chinese, and compatibility landing pages", () => {
    const zhReadme = read("README.md");
    const enReadme = read("README.en.md");
    const compatibilityReadme = read("README.zh-CN.md");

    for (const document of [zhReadme, enReadme]) {
      expect(document).toContain("# repo-harness Controller Runtime");
      expect(document).toContain("docs/images/repo-harness-banner.svg");
      expect(document).toContain("1.4.0-rc.1");
      expect(document).toContain("controller-chatgpt-bridge-v8");
      expect(document).toContain("schema `10`");
      expect(document).toContain("Direct Edit");
      expect(document).toContain("Issue → Task → Run");
      expect(document).toContain("repoId");
    }

    expect(enReadme).toContain("## Quick start");
    expect(enReadme).toContain("## Connect ChatGPT");
    expect(enReadme).toContain("@moretea-labs/repo-harness-controller@next");
    expect(zhReadme).toContain("## 快速开始");
    expect(compatibilityReadme).toContain("README.md");
    expect(compatibilityReadme).toContain("docs/public-usage-guide.zh-CN.md");
  });

  test("documents stable HTTPS exposure in the dedicated connector guides", () => {
    const readme = read("README.en.md");
    const zhReadme = read("README.md");
    const connectorGuide = read("docs/repo-harness-chatgpt-mcp-setup.md");
    const combined = [readme, zhReadme, connectorGuide].join("\n");

    expect(combined).toContain("Tailscale Funnel");
    expect(combined).toContain("Cloudflare");
    expect(combined).toContain("ngrok");
    expect(combined).toContain("/mcp");
    expect(combined).toContain("127.0.0.1:8766");
  });

  test("documents Project-scoped repository routing without publishing local identities", () => {
    const enReadme = read("README.en.md");
    const zhReadme = read("README.md");
    const combined = [enReadme, zhReadme, ...PUBLIC_GUIDES.map(read)].join("\n");

    expect(enReadme).toContain("Default repoId: <repo-id returned by repo-harness repo register>");
    expect(enReadme).toContain("Default checkoutId: <checkout-id returned by repo-harness repo register>");
    expect(zhReadme).toContain("默认 repoId：<repo-harness repo register 返回的 repo-id>");
    expect(enReadme).toContain("not a server-side authorization boundary");
    expect(combined).not.toContain("repo_123b7cf58b6b17b5cbe46a56");
    expect(combined).not.toContain("checkout_79d467b771d6c6f0e6c103a7");
  });

  test("packages the maintained public guides and preserves current metadata", () => {
    const pkg = JSON.parse(read("package.json")) as {
      version: string;
      license: string;
      files: string[];
      repository?: { url?: string };
    };

    expect(pkg.version).toBe("1.4.0-rc.1");
    expect(pkg.license).toBe("MIT");
    expect(pkg.files).toContain("README.en.md");
    expect(pkg.files).toContain("README.zh-CN.md");
    expect(pkg.files).toContain("docs/images/");
    expect(pkg.files).toContain("docs/public-usage-guide.md");
    expect(pkg.files).toContain("docs/public-usage-guide.zh-CN.md");
    expect(pkg.repository?.url).toContain("moretea-labs/repo-harness-controller-runtime");
  });

  test("keeps derivative attribution and release safety guidance visible", () => {
    const enReadme = read("README.en.md");
    const zhReadme = read("README.md");
    const notice = read("NOTICE");
    const license = read("LICENSE");

    for (const document of [enReadme, zhReadme]) {
      expect(document).toContain("AncientTwo/repo-harness");
      expect(document).toContain("LICENSE");
      expect(document).toContain("NOTICE");
      expect(document).toContain("check:release-surface");
      expect(document).toContain("check:public-export");
      expect(document).toContain("check:type");
    }

    expect(notice).toContain("derived from AncientTwo/repo-harness");
    expect(notice).toContain("substantial modifications");
    expect(license).toContain("Copyright (c) 2026 AncientTwo");
    expect(license).toContain("Copyright (c) 2026 Moretea Labs contributors");
  });

  test("release and verification references retain evidence authority terminology", () => {
    const releaseDoc = read("docs/reference-configs/release-deploy.md");
    const releaseAsset = read("assets/reference-configs/release-deploy.md");
    const verificationArchitecture = read("docs/architecture/current/verification-and-release-gates.md");

    expect(releaseAsset).toBe(releaseDoc);
    expect(releaseDoc).toContain("full_test_count");
    expect(releaseDoc).toContain("dry_run_ratio");
    expect(releaseDoc).toContain("grader_pass_rate");
    expect(releaseDoc).toContain("effectiveness_authority");
    expect(releaseDoc).toContain("missing eval evidence");
    expect(verificationArchitecture).toContain("Worker or Agent prose is supplementary evidence");
    expect(verificationArchitecture).toContain("bound to an exact Revision");
    expect(verificationArchitecture).toContain("becomes stale if repository content changes");
  });

  test("dry-run keeps the migration report onboarding signals", () => {
    const result = spawnSync("bash", ["scripts/migrate-project-template.sh", "--repo", ".", "--dry-run"], {
      cwd: ROOT,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("=== Migration Report ===");
    expect(result.stdout).toContain("Project hooks synced from:");
    expect(result.stdout).toContain("Workflow migration:");
    expect(result.stdout).toContain("Helper runtime:");
    expect(result.stdout).toContain("package-dispatched through repo-harness run with scripts/* compatibility wrappers");
    expect(result.stdout).toContain("Host hook config target: user-level ~/.claude/settings.json and ~/.codex/hooks.json");
    expect(result.stdout).toContain("Host hook adapters are user-level:");
  }, 30000);

  test("runtime red-flag scan keeps public onboarding host-neutral", () => {
    const hits: string[] = [];

    for (const file of RUNTIME_SCAN_FILES) {
      read(file).split("\n").forEach((line, index) => {
        const redFlag = RUNTIME_RED_FLAGS.some((pattern) => pattern.test(line));
        if (redFlag && !isAllowedRuntimeReference(file, line)) {
          hits.push(`${file}:${index + 1}:${line}`);
        }
      });
    }

    expect(hits).toEqual([]);
  });
});
