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
  test("uses concise English and Chinese public landing pages", () => {
    const readme = read("README.md");
    const zhReadme = read("README.zh-CN.md");

    for (const document of [readme, zhReadme]) {
      expect(document).toContain("# repo-harness Controller Runtime");
      expect(document).toContain("docs/images/repo-harness-banner.svg");
      expect(document).toContain("README.md");
      expect(document).toContain("README.zh-CN.md");
      expect(document).toContain("1.4.0");
      expect(document).toContain("controller-chatgpt-bridge-v8");
      expect(document).toContain("schema `10`");
      expect(document).toContain("Direct Edit");
      expect(document).toContain("Issue → Task → Run");
      expect(document).toContain("Cloudflare");
      expect(document).toContain("ngrok");
      expect(document).toContain("repoId");
    }

    expect(readme).toContain("## Quick start");
    expect(readme).toContain("## Connect ChatGPT");
    expect(readme.indexOf("## Quick start")).toBeLessThan(readme.indexOf("## Connect ChatGPT"));
    expect(readme).toContain("git clone https://github.com/greysonOuyang/repo-harness-controller-runtime.git");
    expect(readme).toContain("bun add -g repo-harness");
    expect(readme).toContain("repo-harness repo register");
    expect(readme).toContain("repo-harness mcp keepalive");
    expect(readme).toContain("docs/public-usage-guide.md");
    expect(zhReadme).toContain("docs/public-usage-guide.zh-CN.md");

    expect(readme).not.toContain("README.ja.md");
    expect(readme).not.toContain("README.fr.md");
    expect(readme).not.toContain("README.es.md");
    expect(zhReadme).not.toContain("README.ja.md");
  });

  test("documents public HTTPS exposure through Cloudflare and external ngrok", () => {
    const guide = read("docs/public-usage-guide.md");
    const zhGuide = read("docs/public-usage-guide.zh-CN.md");

    for (const document of [guide, zhGuide]) {
      expect(document).toContain("--tunnel quick");
      expect(document).toContain("--tunnel named");
      expect(document).toContain("--cloudflare-tunnel-name repo-harness-mcp");
      expect(document).toContain("--tunnel none");
      expect(document).toContain("ngrok http 8765");
      expect(document).toContain("/mcp");
      expect(document).toContain("127.0.0.1:8766");
      expect(document).toContain("https://developers.openai.com/apps-sdk/deploy/connect-chatgpt");
      expect(document).toContain("https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/");
      expect(document).toContain("https://ngrok.com/docs/getting-started/");
    }

    expect(guide).toContain("ngrok is not an embedded repo-harness tunnel mode");
    expect(zhGuide).toContain("ngrok 不是 repo-harness 内置 tunnel mode");
  });

  test("documents Project-scoped repository routing without publishing local identities", () => {
    const readme = read("README.md");
    const zhReadme = read("README.zh-CN.md");
    const guide = read("docs/public-usage-guide.md");
    const zhGuide = read("docs/public-usage-guide.zh-CN.md");
    const combined = [readme, zhReadme, guide, zhGuide].join("\n");

    expect(readme).toContain("Default repoId: <repo-id returned by repo-harness repo register>");
    expect(readme).toContain("Default checkoutId: <checkout-id returned by repo-harness repo register>");
    expect(zhReadme).toContain("默认 repoId：<repo-harness repo register 返回的 repo-id>");
    expect(readme).toContain("Project instructions are a durable conversation default, not a server-side authorization boundary");
    expect(guide).toContain("Project instructions guide ChatGPT; they do not change server-side authorization");
    expect(guide).toContain("A multi-repository controller should continue passing `repoId` explicitly");
    expect(zhGuide).toContain("Project instructions 约束 ChatGPT 行为，不改变服务端权限");
    expect(combined).not.toContain("repo_123b7cf58b6b17b5cbe46a56");
    expect(combined).not.toContain("checkout_79d467b771d6c6f0e6c103a7");
  });

  test("packages the bilingual public guides and preserves current metadata", () => {
    const pkg = JSON.parse(read("package.json")) as {
      version: string;
      license: string;
      files: string[];
      repository?: { url?: string };
    };

    expect(pkg.version).toBe("1.4.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.files).toContain("README.zh-CN.md");
    expect(pkg.files).toContain("docs/images/");
    expect(pkg.files).toContain("docs/public-usage-guide.md");
    expect(pkg.files).toContain("docs/public-usage-guide.zh-CN.md");
    expect(pkg.repository?.url).toContain("greysonOuyang/repo-harness-controller-runtime");
  });

  test("keeps derivative attribution and release safety guidance visible", () => {
    const readme = read("README.md");
    const zhReadme = read("README.zh-CN.md");
    const notice = read("NOTICE");
    const license = read("LICENSE");

    for (const document of [readme, zhReadme]) {
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
    expect(license).toContain("Copyright (c) 2026 greysonOuyang");
  });

  test("release and verification references retain authoritative eval terminology", () => {
    const releaseDoc = read("docs/reference-configs/release-deploy.md");
    const releaseAsset = read("assets/reference-configs/release-deploy.md");
    const evalArchitecture = read("docs/architecture/modules/verification/evals-checks.md");

    expect(releaseAsset).toBe(releaseDoc);
    expect(releaseDoc).toContain("full_test_count");
    expect(releaseDoc).toContain("dry_run_ratio");
    expect(releaseDoc).toContain("grader_pass_rate");
    expect(releaseDoc).toContain("effectiveness_authority");
    expect(releaseDoc).toContain("missing eval evidence");
    expect(releaseDoc).toMatch(/non-authoritative\s+skill eval evidence/);
    expect(evalArchitecture).toContain("non-dry-run `bun run benchmark:skills --eval <slug>`");
    expect(evalArchitecture).toContain("Non-authoritative smoke");
    expect(evalArchitecture).toMatch(/not\s+skill-effectiveness evidence/);
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
